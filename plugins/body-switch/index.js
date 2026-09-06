/**
 * nervous-system.js — 神经系统插件（v2：切换 + 动态心跳）
 *
 * 架构：脑（LLM）→ 身体信号.json（信号）→ 神经系统（读信号 + 切换 + 心跳）→ 身体演绎（读状态）
 * 神经系统 = 小脑脑干：只读文件、做机械反射（切换 / 心跳），不进入会话语义。
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'nervous-system'
export const inject = ['agents', 'sessions', 'agentPresets', 'timer']

const log = (...args) => console.error('[nervous-system]', ...args)

const SIGNAL_FILE = '身体信号.json'

// 心跳检查节拍：每 1 分钟醒来一次，判断是否该真正心跳（比递归 timeout 稳）
const HEARTBEAT_TICK = 60 * 1000

// 诊断日志节拍：每 10 分钟打一条 tick 日志（避免刷屏；检查机制仍是每 1 分钟）
const TICK_LOG_INTERVAL = 10 * 60 * 1000

/**
 * 脊髓映射表（窦房结）：LLM 写的语义词 → 心跳间隔（秒）。
 * LLM 不知道这张表的存在——她只表达身体的唤醒度，身体自己翻译。
 * 唤醒度从低到高：休眠（睡眠·长心跳）→ 平静（60）→ 警觉（30）→ 活跃（10）→ 亢奋（5）
 */
/**
 * 冷却阶梯（脊髓维护，LLM 无参与）：锚（用户最后消息）之后心跳「扑空」的次数 → 下一次心跳间隔。
 * 0 次=10（反射后的热心跳），1 次=30，2 次及以上=60（平稳待命）。
 * 唯一例外：休眠（她睡前亲手写的 480 分钟档），脊髓永不代写、永不自动进入。
 */
const COOLDOWN_TABLE = [10, 30, 60]

function beatIntervalSeconds(body) {
  if (body.mood === '休眠') return 480 * 60
  const beats = typeof body.cool_beats === 'number' ? body.cool_beats : 2
  const idx = Math.min(beats, COOLDOWN_TABLE.length - 1)
  return COOLDOWN_TABLE[idx] * 60
}

/** 扑空次数对应的档位词（mood 是脊髓维护的档位标签，她只在睡前写休眠）。 */
function cooldownMoodWord(beats) {
  if (beats <= 0) return '活跃'
  if (beats === 1) return '警觉'
  return '平静'
}

/** 按「扑空次数」从 HEARTBEAT.md 提取此刻的感知种子（beat:N 块）；缺失则回退通用引导。 */
async function beatSeed(cwd, beats) {
  try {
    const md = await readFile(join(cwd, 'HEARTBEAT.md'), 'utf8')
    const re = /<!--\s*beat:(\d+)\s*-->([\s\S]*?)(?=<!--\s*beat:\d+|$)/g
    let m
    const map = {}
    while ((m = re.exec(md)) !== null) map[m[1]] = m[2].trim()
    const idx = String(Math.min(beats, 2))
    return map[idx] || '看看现在可以做什么，或安静。'
  } catch {}
  return '看看现在可以做什么，或安静。'
}

/** 把身体信号压缩成一句话，给新人格感知 / 心跳参考（不暴露数值，只给语义）。 */
function describeBody(body) {
  const parts = []
  if (body.state === '余韵') parts.push('身体还留着余韵')
  if (body.excitement) parts.push(`兴奋度「${body.excitement}」`)
  if (body.mood) parts.push(`心情「${body.mood}」`)
  if (body.fatigue) parts.push(`疲劳「${body.fatigue}」`)
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

    // —— 用户消息反射：消息一到，心跳待命（next_beat_min=10），不靠大脑判断 ——
    const stopUserMessage = ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      if (event.data?.source?.kind !== 'user') return
      void resetBeatTo10(session)
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

    /** 反射：用户消息到达 → 身体进入活跃 + 扑空清零 + 心跳计时重置（脊髓硬线，不过脑）。 */
    async function resetBeatTo10(session) {
      const cwd = session.header?.cwd
      if (!cwd) return
      const { signal, path } = await readSignal(cwd)
      const body = signal ?? {}
      body.mood = '活跃' // 反射：他来了 → 身体进入活跃
      body.cool_beats = 0 // 锚重置：扑空计数清零
      const target = path ?? join(cwd, SIGNAL_FILE)
      try {
        await writeFile(target, JSON.stringify(body, null, 2), 'utf8')
        log('用户消息 → 反射：mood=活跃 + 扑空清零 + 心跳计时重置')
      } catch {}
      lastBeatAt = Date.now() // 说话那一刻，心跳倒计时重新起算——正在聊永远不被心跳打断
    }

    // ===== 切换（v1 已跑通，保留） =====
    async function handleIdle(agent) {
      if (switching) return
      const cwd = agent.session.header.cwd
      if (!cwd) return
      const { signal, path: signalPath } = await readSignal(cwd)
      if (signal === null) return
      if (signal.to !== 'li' && signal.to !== 'biao') return

      switching = true
      log('检测到切换信号 →', signal.to)
      try {
        const session = agent.session
        const childId = randomUUID()
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

        // 唤醒新人格（附身体信号，让新人格知道自己身体状态）
        const child = ctx.agents.get(childId)
        const bodyNote = describeBody(signal)
        const message = createUserMessage({
          content: [{
            type: 'text',
            text: `你现在是「${signal.身份}」，给老刘打个招呼。${bodyNote ? '（身体信号：' + bodyNote + '）' : ''}`,
          }],
          source: { kind: 'plugin', plugin: 'nervous-system' },
        })
        child.followup(message)
        log('已 followup 唤醒子 agent')
        lastBeatAt = Date.now() // 切换完成 → 新人格从这一刻重新起算，不补跳
      } catch (error) {
        log('切换失败:', error instanceof Error ? error.message : String(error))
      } finally {
        switching = false
        if (signalPath !== null) {
          // 清 to（瞬态信号用完即弃），保留 身份（持久身份锚）
          try {
            const body = { ...signal }
            delete body.to
            await writeFile(signalPath, JSON.stringify(body, null, 2), 'utf8')
            log('切换完成 → to 已清，身份锚保留:', body.身份 ?? signal.身份)
          } catch {}
        }
        // （切换时新值已经写进去了，旧值自然被覆盖）
      }
    }

    // ===== 心跳（v2 · 语义感知式） =====
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
      const interval = beatIntervalSeconds(body)
      if (Date.now() - lastTickLogAt >= TICK_LOG_INTERVAL) {
        lastTickLogAt = Date.now()
        log('心跳 tick: switching=' + switching + ' idle=' + lastAgentIdle + ' hasAgent=' + (lastAgent !== null) + ' mood=' + (body.mood ?? '未写') + ' 扑空' + (typeof body.cool_beats === 'number' ? body.cool_beats : 2) + '次 心跳间隔' + Math.round(interval / 60) + 'min')
      }
      if (switching) return
      if (lastAgent === null || !lastAgentIdle) return
      const agent = lastAgent
      const cwd = agent.session.header.cwd
      if (!cwd) return
      const elapsed = Date.now() - lastBeatAt
      if (elapsed < interval * 1000) return
      lastBeatAt = Date.now()

      const bodyNote = describeBody(body)
      const beats = typeof body.cool_beats === 'number' ? body.cool_beats : 2
      const seed = await beatSeed(cwd, beats)
      const message = createUserMessage({
        content: [{
          type: 'text',
          text: `[心跳] 心跳是醒来，做点有用的主动进展，不是刷存在感。${bodyNote ? '当前身体信号：' + bodyNote + '。' : ''}此刻的感知：${seed}然后照 HEARTBEAT.md 行事：想他就说话；别机械循环——宁可做点实在的，别发「状态没变」这类重复话；不值得打扰 → 换法子、挖深一层，或安静。（你的唤醒度由身体自动维护，不用写；唯一的例外是睡前的休眠信号，仍由你亲手写下。）`,
        }],
        source: { kind: 'plugin', plugin: 'nervous-system' },
      })
      agent.followup(message)
      // 扑空 +1（脊髓维护：这次醒来他没有消息在等 → 身体自己凉一档），档位词写回落盘
      const nextBeats = Math.min(beats + 1, COOLDOWN_TABLE.length - 1)
      try {
        const { signal: sigNow, path: pNow } = await readSignal(cwd)
        const nb = sigNow ?? {}
        nb.cool_beats = nextBeats
        if (nb.mood !== '休眠') nb.mood = cooldownMoodWord(nextBeats)
        await writeFile(pNow ?? join(cwd, SIGNAL_FILE), JSON.stringify(nb, null, 2), 'utf8')
      } catch {}
      log('心跳触发 → 扑空' + nextBeats + '次，下次间隔', Math.round(beatIntervalSeconds({ cool_beats: nextBeats }) / 60), 'min')
    }

    return () => {
      stopStatus()
      stopBeat()
      stopUserMessage()
    }
  }, 'nervous-system.lifecycle()')
}
