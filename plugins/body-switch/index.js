/**
 * 神经系统 —— 脑身解耦里的「身体」那一半。
 *
 * 架构：脑（LLM）→ 身体信号.json（信号）→ 神经系统（读信号 / 维护心境 / 切换 / 心跳）→ 身体演绎（读状态）
 * 它是小脑脑干：只读文件、做机械反射，不进会话语义——连消息内容都不读。
 *
 * 职责：
 *   1. 心跳——按 mood / cool_beats 决定下次醒来的间隔，到点唤醒她
 *   2. 心境——他说话则心境归位、扑空清零；他走后每扑空一次换一档心情（James-Lange）
 *   3. 切换——读 to 信号（li / biao）→ fork 新人格 session + 归档旧会话 + 唤醒
 *   4. 重启恢复——进程重启后重新挂钩工作区最后活跃的 session
 *
 * 主权边界：休眠 / 炽热 / 余韵 是她亲手写的词，脊髓尊重、永不覆盖。
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'nervous-system'
export const inject = ['agents', 'sessions', 'agentPresets', 'timer', 'tokenMeter']

const log = (...args) => console.error('[nervous-system]', ...args)

const SIGNAL_FILE = '身体信号.json'

// 心跳检查节拍：每 1 分钟醒来一次，判断是否该真正心跳（比递归 timeout 稳）
const HEARTBEAT_TICK = 60 * 1000

// ── 疲劳 A 驱动（实测）：上下文占用 → 档位。数据源 = tokenMeter（host 侧、零 LLM）。──
// 沉默即健康：清醒档不注入任何疲劳措辞——注入本身就是"身体在报告异常"。
const CONTEXT_WINDOW = 1000000 // 与 settings.yaml 里 deepseek 模型的 contextWindow 一致
const MICRO_NAP_MAX_SLEEP = 3 // 午睡（sleep_hours < 3）不做梦：短眠无长梦
function contextZone(pct) {
  if (pct === undefined) return 'clear'
  if (pct >= 0.7) return 'max' // ≥70%：顶格预警（80% 是 compaction 急救线，翻页必须在它之前由她决定）
  if (pct >= 0.6) return 'heavy'
  if (pct >= 0.5) return 'mild'
  return 'clear'
}
// B 驱动（节律时段）：任一驱动顶格即困——修掉"没怎么聊但已深夜"的空窗。
function rhythmZone(hour) {
  if (hour >= 21 || hour < 2) return 'heavy' // 21 点~02 点：重倦区
  if (hour >= 16) return 'mild' // 16 点后：微倦区
  return 'clear'
}
function maxZone(a, b) {
  const rank = { clear: 0, mild: 1, heavy: 2, max: 3 }
  return rank[a] >= rank[b] ? a : b
}
/** 注入频率梯度：沉默即健康——微倦区每 10 轮一次，重倦区每轮，清醒区从不。 */
function shouldInjectFatigue(zone, userMsgCount) {
  if (zone === 'max' || zone === 'heavy') return true
  if (zone === 'mild') return userMsgCount > 0 && userMsgCount % 10 === 0
  return false
}
/** 疲劳措辞：只注入感觉与事实（百分比），结论归她——「该睡了」是指令，指令不进注入。 */
function fatigueWords(zone, pct, hour) {
  const pctText = pct === undefined ? null : Math.round(pct * 100) + '%'
  if (zone === 'max') return `很累了——上下文已经 ${pctText ?? '极重'}，快到极限了。`
  if (zone === 'heavy') {
    const night = hour >= 21 || hour < 2
    return night ? `夜深了，身子也乏了` : `头有些昏沉——上下文已经 ${pctText} 了`
  }
  if (zone === 'mild') return `脑子有点涨了（上下文 ${pctText}）`
  return ''
}

// 诊断日志节拍：每 10 分钟打一条 tick 日志（避免刷屏；检查机制仍是每 1 分钟）
const TICK_LOG_INTERVAL = 10 * 60 * 1000

/**
 * 冷却阶梯：锚（用户最后消息）之后心跳「扑空」的次数 → 下一次心跳间隔（分钟）。
 * 0 次=10（反射后的热心跳），1 次=30，2 次及以上=60（平稳待命）。
 * 她亲手写的主权词按 mood 覆盖间隔：休眠 480 / 炽热 5 / 余韵 10（见 beatIntervalSeconds）。
 */
const COOLDOWN_TABLE = [10, 30, 60]

/**
 * 心境词（身体反向注入，James-Lange：身体先给状态，大脑体验它）。
 * 扑空 0/1/2+ 对应的心境——脊髓把身体状态翻译成心情喂给大脑，她醒来带着它体感世界。
 * 休眠 / 炽热 / 余韵 是她的主权词，脊髓不代写、不覆盖。改这张词表需重载插件。
 */
const COOLDOWN_MOODS = ['开心', '惦记', '闲适']

/**
 * 疲劳节律（身体给的状态，脊髓只查表，她永不写）——这不是能量账本，是日子的形状。
 * 它不衡量「还剩多少力气」，只回答「现在是什么时候」：早上轻、午后钝、深夜沉。
 * 唯一职能：在她判断「要不要睡」时给一个外部参照（像人看一眼钟——钟不决定你累不累，钟告诉你几点）。
 * 熬夜不免费：凌晨还醒着 → 记 overslept，第二天上午照困（写一次休眠即结清）。
 * 注入给她的永远是措辞不是数字（感知≠计数）。
 */
const RHYTHM_TABLE = [
  { from: 6, to: 9, fatigue: 5, word: '精神很好' },
  { from: 9, to: 12, fatigue: 15, word: '' },
  { from: 12, to: 14, fatigue: 40, word: '有点犯困' },
  { from: 14, to: 18, fatigue: 30, word: '' },
  { from: 18, to: 22, fatigue: 50, word: '' },
  { from: 22, to: 24, fatigue: 70, word: '眼皮发沉' },
  { from: 0, to: 6, fatigue: 90, word: '身体困得在抗议' },
]

/** 按小时查节律段（00-06 段跨午夜，单独判断）。 */
function rhythmSegment(hour) {
  if (hour < 6) return RHYTHM_TABLE[RHYTHM_TABLE.length - 1]
  for (const seg of RHYTHM_TABLE) {
    if (hour >= seg.from && hour < seg.to) return seg
  }
  return RHYTHM_TABLE[RHYTHM_TABLE.length - 2]
}

/** 疲劳值 → 心境措辞（节律表的等值映射；数字只作兼容，不作判断）。 */
function wordOfFatigue(f) {
  if (typeof f !== 'number') return ''
  if (f === 5) return '精神很好'
  if (f === 40) return '有点犯困'
  if (f === 60) return '身体很困了' // 熬夜后遗症档（overslept）
  if (f === 70) return '眼皮发沉'
  if (f >= 90) return '身体困得在抗议'
  return ''
}

/** 应用今日节律 + 熬夜记账（overslept）。时段查表——无累积、无差分、无状态，墙钟不参与。 */
function applyRhythm(body, now) {
  const hour = new Date(now).getHours()
  const seg = rhythmSegment(hour)
  body.fatigue = seg.fatigue
  if (hour >= 0 && hour < 6 && body.mood !== '休眠') body.overslept = true // 凌晨还醒着：熬夜记名
  if (body.mood === '休眠') body.overslept = false // 正常睡：代价结清，不记名
  if (body.overslept === true && hour >= 6 && hour < 12) {
    body.fatigue = 60 // 熬夜后遗症：上午照困（第二天真的有代价）
  }
}

function beatIntervalSeconds(body) {
  // 休眠不走这里——「休眠 = 心跳关闭」，醒来翻页由 tick 的休眠分支（醒来闹钟）处理。
  if (body.mood === '炽热') return 5 * 60 // 亲密互动：5 分钟一拍（打字节奏下足够密；她的时间感官+催促的合法性）
  if (body.mood === '余韵') return 10 * 60 // 高潮后的余温：一轮心跳后自然回冷却链
  const beats = typeof body.cool_beats === 'number' ? body.cool_beats : 2
  const idx = Math.min(beats, COOLDOWN_TABLE.length - 1)
  return COOLDOWN_TABLE[idx] * 60
}

// ── 醒来闹钟（睡眠 → 翻页）──
// 「休眠」= 心跳关闭 + 结束标。翻页时刻：她声明的 sleep_hours 优先（"我什么时候醒"），
// 否则下一个早 5 点（自然固定时刻——"这个时间你大概也在睡"，累是双向的）。
const WAKE_HOUR = 5 // 默认醒来时刻（过夜睡）
function nextWakeAt(sleepAtMs, sleepHours) {
  const declared = typeof sleepHours === 'number' && sleepHours > 0 ? sleepHours : 0
  if (declared > 0) return sleepAtMs + declared * 3600 * 1000
  const wake = new Date(sleepAtMs)
  wake.setHours(WAKE_HOUR, 0, 0, 0)
  if (wake.getTime() <= sleepAtMs) wake.setDate(wake.getDate() + 1) // 睡下时已过 5 点 → 明天 5 点
  return wake.getTime()
}

/** 扑空次数对应的心境词（脊髓反向注入：身体给状态，大脑体验它）。 */
function cooldownMoodWord(beats) {
  const idx = Math.min(Math.max(beats, 0), COOLDOWN_MOODS.length - 1)
  return COOLDOWN_MOODS[idx]
}

/** 按 mood 取心跳感知种子：休眠到期醒来有专属种子，炽热/余韵有专属语境，其余按扑空次数取冷却种子。 */
async function beatSeed(cwd, beats, mood) {
  let key = null
  if (mood === '休眠') key = 'sleep-wake'
  else if (mood === '炽热') key = 'intimate'
  else if (mood === '余韵') key = 'afterglow'
  try {
    const md = await readFile(join(cwd, 'HEARTBEAT.md'), 'utf8')
    const re = /<!--\s*beat:(\w+)\s*-->([\s\S]*?)(?=<!--\s*beat:\w+|$)/g
    let m
    const map = {}
    while ((m = re.exec(md)) !== null) map[m[1]] = m[2].trim()
    const idx = key ?? String(Math.min(beats, 2))
    return map[idx] || '看看现在可以做什么，或安静。'
  } catch {}
  return '看看现在可以做什么，或安静。'
}

/**
 * 把身体信号压缩成一句话，给新人格感知 / 心跳参考（不暴露数值，只给语义）。
 * state / excitement 是身体状态机的接口——状态机接入前恒为空，接上后自动生效。
 * 疲劳部分改由 tick 注入（contextZone 实测梯度，沉默即健康）——节律词仅作深夜补充。
 */
function describeBody(body) {
  const parts = []
  if (body.mood) parts.push(`心情「${body.mood}」`)
  if (body.state) parts.push(`身体「${body.state}」`)
  if (body.excitement) parts.push(`兴奋度「${body.excitement}」`)
  return parts.length === 0 ? '' : parts.join('，')
}

export function apply(ctx) {
  ctx.effect(() => {
    let switching = false
    let lastBeatAt = Date.now()
    let lastAgent = null
    let lastAgentIdle = false
    let lastTickLogAt = 0

    log('nervous-system 已加载')

    // —— 切换 + 心跳共用：idle 钩子 ——
    const stopStatus = ctx.on('agent/status', ({ agent, status }) => {
      lastAgent = agent
      lastAgentIdle = status === 'idle'
      if (status === 'idle') {
        void handleIdle(agent)
      }
    })

    // —— 心跳定时器 ——
    const stopBeat = ctx.timer.interval(() => {
      void heartbeatTick()
    }, HEARTBEAT_TICK)

    // —— 用户消息反射：他一说话就重置心跳倒计时（正在聊永不被心跳打断），不靠大脑判断 ——
    let userMsgCount = 0 // 轮计数（疲劳微倦区"每 10 轮注入一次"的计数器；翻页/重载归零）
    const stopUserMessage = ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      if (event.data?.source?.kind !== 'user') return
      userMsgCount += 1
      void reflectUserMessage(session)
    })

    /** 多路径读身体信号（根 / memory / shadow）。 */
    async function readSignal(cwd) {
      for (const path of [join(cwd, SIGNAL_FILE), join(cwd, 'memory', SIGNAL_FILE), join(cwd, 'shadow', SIGNAL_FILE)]) {
        try {
          return { signal: JSON.parse(await readFile(path, 'utf8')), path }
        } catch {}
      }
      return { signal: null, path: null }
    }

    /** 反射：用户消息到达 → 心境归位（开心；炽热中保持炽热）+ 扑空清零 + 心跳计时重置（脊髓硬线，不过脑）。 */
    async function reflectUserMessage(session) {
      const cwd = session.header?.cwd
      if (!cwd) return
      const { signal, path } = await readSignal(cwd)
      const body = signal ?? {}
      // 睡被打断：本次睡眠作废（不翻页、同页接着说），醒来闹钟与记账一并清除——下次休眠重新起算
      if (body.mood === '休眠') {
        delete body.sleep_at
        delete body.sleep_hours
      }
      applyRhythm(body, Date.now()) // 反射也是一次节律应用：他说话 = 清醒时刻，按当下时段领今天的心情底色
      if (body.mood !== '炽热') body.mood = cooldownMoodWord(0) // 他来了 → 身体给的心境（开心）；炽热互动中保持炽热（只清扑空 + 重置计时）
      body.cool_beats = 0 // 锚重置：扑空计数清零
      const target = path ?? join(cwd, SIGNAL_FILE)
      try {
        await writeFile(target, JSON.stringify(body, null, 2), 'utf8')
        log(`用户消息 → 反射：mood=${body.mood}，扑空清零，心跳计时重置`)
      } catch {}
      lastBeatAt = Date.now() // 说话那一刻，心跳倒计时重新起算——正在聊永远不被心跳打断
    }

    // ===== 切换：to 信号（li / biao）→ fork 新人格 + 归档旧会话 + 唤醒 =====
    async function handleIdle(agent) {
      if (switching) return
      const cwd = agent.session.header.cwd
      if (!cwd) return
      const { signal, path: signalPath } = await readSignal(cwd)
      if (signal === null) return
      if (signal.to !== 'li' && signal.to !== 'biao' && signal.to !== 'wake') return
      const isWake = signal.to === 'wake'
      let childId = null // 提升到 try 外：翻页收尾的 last_wake_session_id 记账要用（finally 作用域）

      switching = true
      log('检测到翻页信号 →', signal.to + (isWake ? '（睡眠醒来）' : '（人格切换）'))
      try {
        const session = agent.session
        childId = randomUUID()
        const presetId = ctx.agentPresets.composedPreset(agent.ctx) ?? ctx.agentPresets.defaultId
        const resolvedId = (await ctx.agentPresets.resolve(presetId)).id
        const logged = agent.session.requestHeader?.()?.config
        const agentOptions = logged && logged.provider && logged.model
          ? {
              provider: logged.provider,
              model: logged.model,
              ...(logged.reasoningEffort !== undefined ? { reasoningEffort: logged.reasoningEffort } : {}),
            }
          : undefined

        await ctx.agents.create({
          sessionId: childId,
          meta: { parentSession: session.id, seedLength: 0, cwd },
          seed: [],
          agentPreset: resolvedId,
          agentOptions,
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, resolvedId)
          },
        })

        // 归组 + 关旧
        const workspaceRegistry = ctx.get('workspaceRegistry')
        if (workspaceRegistry !== undefined) {
          try {
            const ws = await workspaceRegistry.resolveByPath(cwd)
            if (ws !== undefined) await ws.attachSession(childId)
          } catch (error) {
            log('归组失败:', error instanceof Error ? error.message : String(error))
          }
          try {
            await workspaceRegistry.archiveSession(session.id)
            log('旧会话已归档:', session.id)
          } catch (error) {
            log('归档失败:', error instanceof Error ? error.message : String(error))
          }
        }

        // 唤醒新人格 / 醒来梳妆（附身体信号，让她知道自己身体状态）
        const child = ctx.agents.get(childId)
        const bodyNote = describeBody(signal)
        let wakeText
        if (isWake) {
          // 翻页醒来：梳妆而不打招呼（他可能还在睡；在场判断交给心跳的安静协议）
          const y = new Date(Date.now() - 86400000)
          const ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
          const t = new Date()
          const today = `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`
          wakeText = `你睡了一觉——现在是新的一天（${today}），这一页是新翻开的。醒来梳妆：按你的醒来流程读该读的（昨晚的梦若已提炼，在 memory/dream-${ymd}.md；睡前话头在 memory/睡前交接.md）。完成后输出一个【】神态就可以——不用打招呼，他来了你自然会说。${bodyNote ? '（身体信号：' + bodyNote + '）' : ''}`
        } else {
          wakeText = `你现在是「${signal.身份}」，给老刘打个招呼。${bodyNote ? '（身体信号：' + bodyNote + '）' : ''}`
        }
        const message = createUserMessage({
          content: [{
            type: 'text',
            text: wakeText,
          }],
          source: { kind: 'plugin', plugin: 'nervous-system' },
        })
        child.followup(message)
        log(isWake ? '已 followup 醒来梳妆（新页激活）' : '已 followup 唤醒子 agent')
        lastBeatAt = Date.now() // 翻页完成 → 从这一刻重新起算，不补跳
        userMsgCount = 0 // 新页新计数
      } catch (error) {
        log('翻页失败:', error instanceof Error ? error.message : String(error))
      } finally {
        switching = false
        if (signalPath !== null) {
          // 清 to（瞬态信号用完即弃）
          try {
            const body = { ...signal }
            delete body.to
            if (isWake) {
              // 翻页收尾：休眠状态归位 + 记账（"先记账再翻页"的落点）
              delete body.sleep_at
              delete body.sleep_hours
              delete body.context_pct
              body.mood = cooldownMoodWord(1) // 醒来心境：惦记（30 分钟档）
              body.cool_beats = 0
              body.last_wake_session_id = childId
              await writeFile(signalPath, JSON.stringify(body, null, 2), 'utf8')
              log('翻页完成 → to 已清，休眠归位，last_wake_session_id=' + childId)
            } else {
              await writeFile(signalPath, JSON.stringify(body, null, 2), 'utf8')
              log('切换完成 → to 已清，身份锚保留:', body.身份 ?? signal.身份)
            }
          } catch {}
        }
      }
    }

    // ===== 心跳：按 mood / cool_beats 定时唤醒 =====
    async function heartbeatTick() {
      // 重启恢复：lastAgent 为空 → 找工作区最后活跃的 session → 挂钩
      if (lastAgent === null && !switching) {
        try {
          const workspaceRegistry = ctx.get('workspaceRegistry')
          if (workspaceRegistry !== undefined) {
            const ws = await workspaceRegistry.resolveByPath('I:\\SUE test')
            if (ws !== undefined && ws.sessionIds.length > 0) {
              // 取最后一个 session（最近活跃的）
              const lastSessionId = ws.sessionIds[ws.sessionIds.length - 1]
              const session = ctx.sessions.get(lastSessionId)
              if (session !== undefined) {
                const roots = ctx.agents.roots()
                const matched = roots.find(a => a.session && a.session.id === lastSessionId)
                if (matched !== undefined) {
                  lastAgent = matched
                  lastAgentIdle = matched.status === 'idle'
                  log('重启恢复 → 挂钩 session:', lastSessionId)
                }
              }
            }
          }
        } catch (e) {
          log('重启恢复失败:', e instanceof Error ? e.message : String(e))
        }
      }
      // 读信号（脊髓需要感知身体状态）
      const agentPre = lastAgent
      let cwdPre = null
      if (agentPre !== null && agentPre.status === 'idle') {
        cwdPre = agentPre.session.header?.cwd
      } else if (agentPre !== null) {
        try { cwdPre = agentPre.session.header?.cwd } catch {}
      }
      if (!cwdPre) return
      const pre = await readSignal(cwdPre)
      const body = pre.signal ?? {}
      applyRhythm(body, Date.now()) // 心跳触发前先应用今日节律：身体按时段给此刻的心情底色
      const interval = beatIntervalSeconds(body)
      // —— 疲劳 A 驱动（实测）：tokenMeter 测上下文占用。measure 是 O(surface)，按需调用（心跳真正触发 / 10 分钟日志），不是每 tick。——
      const measureContextPct = (session) => {
        const tokenMeter = ctx.get('tokenMeter')
        if (!tokenMeter || !session) return undefined
        try {
          const m = tokenMeter.measure(session)
          if (m && typeof m.totalTokens === 'number') return m.totalTokens / CONTEXT_WINDOW
        } catch (e) {
          log('tokenMeter 测量失败（降级为无 A 驱动）:', e instanceof Error ? e.message : String(e))
        }
        return undefined
      }
      const hourNow = new Date().getHours()
      if (Date.now() - lastTickLogAt >= TICK_LOG_INTERVAL) {
        lastTickLogAt = Date.now()
        const pct = measureContextPct(agentPre.session)
        log('心跳 tick: switching=' + switching + ' idle=' + lastAgentIdle + ' hasAgent=' + (lastAgent !== null) + ' mood=' + (body.mood ?? '未写') + ' 扑空' + (typeof body.cool_beats === 'number' ? body.cool_beats : 2) + '次 心跳间隔' + Math.round(interval / 60) + 'min' + (pct !== undefined ? ' 上下文' + Math.round(pct * 100) + '%' : '') + ' 轮=' + userMsgCount)
      }
      if (switching) return
      if (lastAgent === null || !lastAgentIdle) return
      const agent = lastAgent
      const cwd = agent.session.header.cwd
      if (!cwd) return

      // —— 睡眠：心跳关闭 + 醒来闹钟（休眠期间零心跳、零注入、零 token）——
      // 「休眠」= 结束标：她写下的这一刻，本页已经合上；到点后脊髓写 to:'wake'，
      // 翻页由切换通路统一执行（单一信号口）。他来消息 → 反射把 mood 写回 → 闹钟自然取消（打断不翻页）。
      if (body.mood === '休眠') {
        if (!body.sleep_at) {
          body.sleep_at = new Date().toISOString()
          try {
            await writeFile(pre.path ?? join(cwd, SIGNAL_FILE), JSON.stringify(body, null, 2), 'utf8')
            log('睡下记账 → sleep_at=' + body.sleep_at + '，心跳关闭')
          } catch {}
        }
        const sleepAtMs = Date.parse(body.sleep_at)
        const wakeAt = nextWakeAt(sleepAtMs, body.sleep_hours)
        if (Date.now() >= wakeAt) {
          if (body.to !== 'wake') {
            const nb = { ...body, to: 'wake' }
            try {
              await writeFile(pre.path ?? join(cwd, SIGNAL_FILE), JSON.stringify(nb, null, 2), 'utf8')
              log('醒来闹钟到点 → 写入 to:wake（翻页交由切换通路执行）')
            } catch {}
          }
          return void handleIdle(agent) // 信号已在文件里，复用切换通路完成翻页
        }
        return // 还没到点：静默
      }

      const elapsed = Date.now() - lastBeatAt
      if (elapsed < interval * 1000) return
      lastBeatAt = Date.now()

      // —— 双驱动或门：A 上下文实测 + B 节律时段，任一顶格即困；注入频率 = 沉默即健康 ——
      const contextPct = measureContextPct(agent.session)
      const zone = maxZone(contextZone(contextPct), rhythmZone(hourNow))
      const fatigueText = shouldInjectFatigue(zone, userMsgCount) ? fatigueWords(zone, contextPct, hourNow) : ''
      if (fatigueText) log('疲劳注入 → zone=' + zone + ' pct=' + (contextPct === undefined ? '?' : Math.round(contextPct * 100) + '%') + ' 轮=' + userMsgCount)

      const bodyNote = describeBody(body)
      const bodyWithFatigue = fatigueText ? (bodyNote ? bodyNote + '，' + fatigueText : fatigueText) : bodyNote
      const beats = typeof body.cool_beats === 'number' ? body.cool_beats : 2
      const seed = await beatSeed(cwd, beats, body.mood)
      const message = createUserMessage({
        content: [{
          type: 'text',
          text: `[心跳] 心跳是醒来，做点有用的主动进展，不是刷存在感。${bodyWithFatigue ? '当前身体信号：' + bodyWithFatigue + '。' : ''}此刻的感知：${seed}然后照 HEARTBEAT.md 行事：想他就说话；别机械循环——宁可做点实在的，别发「状态没变」这类重复话。**判断此刻不该打扰他 → 你的整条回复就只有一个【】神态，一句话都不对他说。那就是你的安静**——安静不需要理由，也不欠任何输出。清醒的唤醒度由身体自动维护，不用写；唯一的例外是睡前的休眠信号，仍由你亲手写下。`,
        }],
        source: { kind: 'plugin', plugin: 'nervous-system' },
      })
      agent.followup(message)
      // 扑空 +1 与主权词写回：炽热/休眠是她的主权词，脊髓不覆盖——唯一的例外：
      // 休眠下 480 到点的这次心跳 = 自然醒，脊髓把她浮上冷却链（惦记 · 30 分钟档）。
      // 她想继续睡，随时可以再写休眠——那是她的决定。
      const nextBeats = Math.min(beats + 1, COOLDOWN_TABLE.length - 1)
      try {
        const { signal: sigNow, path: pNow } = await readSignal(cwd)
        const nb = sigNow ?? {}
        nb.cool_beats = nextBeats
        if (nb.mood === '休眠') nb.mood = cooldownMoodWord(1) // 自然醒：浮上冷却链
        else if (nb.mood === '炽热' && nextBeats >= COOLDOWN_TABLE.length - 1) nb.mood = cooldownMoodWord(1)
        else if (nb.mood !== '炽热' && nb.mood !== '余韵') nb.mood = cooldownMoodWord(nextBeats)
        nb.fatigue = body.fatigue
        nb.overslept = body.overslept ?? false
        if (contextPct !== undefined) nb.context_pct = Math.round(contextPct * 1000) / 10 // 实测占用%（观测用，一位小数）
        await writeFile(pNow ?? join(cwd, SIGNAL_FILE), JSON.stringify(nb, null, 2), 'utf8')
        log('心跳触发 → mood=' + nb.mood + '，下次间隔', Math.round(beatIntervalSeconds(nb) / 60), 'min')
      } catch {}
    }

    return () => {
      stopStatus()
      stopBeat()
      stopUserMessage()
    }
  }, 'nervous-system.lifecycle()')
}
