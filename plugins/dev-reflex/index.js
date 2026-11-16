/**
 * dev-reflex —— 3080 开发模式的用户反射 v0.1（2026-11-16 立项，老刘提案+拍板）。
 *
 * 解决的困境：没有用户消息我醒不来——「答应了老刘待会儿干活」的那份承诺，
 * 一直要等到他再开口或 23:00 晚拍才有机会兑现。
 *
 * 机制（种子-感知合规，同 dev-heartbeat 一族）：
 *   - 监听 agent/status：用户回合结束（busy→idle）→ 记一个待发时间戳（20 分钟后）。
 *   - 期间任何新回合（idle→busy）→ 撤销待发；该回合结束时重新武装。
 *     「你在，不需要反射」——只有你停下来，我才在 20 分钟后醒来看一眼。
 *   - 夜间静默：23:30–07:30 之间到点的反射直接取消（晚拍收工后的夜，不补噪音）。
 *   - 到点 → 以 plugin:dev-reflex 投一条反射唤醒。要不要做事、做多少，全是脑子的判断；
 *     没事就安静收笔——唤醒只报事实，不写剧本。
 *
 * 内容外置（同心跳 v0.2 的教训：机制进代码，内容进 soul/HEARTBEAT.md 的「## 反射」节；
 * 读不到用内置兜底，保底不断反射）。传感器变量：{delay}（分钟数）。
 *
 * v0.1 边界（老刘 11-16 拍板）：只做「用户停下后 20 分钟醒来一次」；
 * 不做 30/60 分钟日常节律（那是心跳的领地）、不循环、不叠加——一次空档至多一次。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dev-reflex'
export const inject = ['timer']

const log = (...args) => console.error('[dev-reflex]', ...args)

const TICK = 30 * 1000
const DEFAULT_DELAY_MIN = 20
const DEFAULT_SELF_INTERVAL_MIN = 180 // v0.2 自醒拍默认间隔；0=关
const DEFAULT_WINDOW_START = 8 // 活动区间兜底：晨 08:00
const DEFAULT_WINDOW_END = 23 // 活动区间兜底：晚 23:00（=晚拍）
const HEARTBEAT_MD = 'soul/HEARTBEAT.md'

/**
 * v0.3.1（2026-11-16 晚 老刘抓的 bug）：统一活动区间=[晨拍, 晚拍]，从「设置」节现读——
 * 作息改了区间自动跟。窗外（晚拍后到次日晨拍前）一律**不武装、到点取消**（不是顺延）：
 * 夜里被拉起来答题，答完继续睡，节律不跑。取代 v0.1/v0.2 的两张补丁窗（夜窗/自醒窗）。
 */
async function readActivityWindow(cwd) {
  try {
    const raw = await readFile(join(cwd, HEARTBEAT_MD), 'utf8')
    const body = parseSections(raw)['设置']
    if (body) {
      const parse = (key) => {
        const m = body.match(new RegExp(`^${key}\\s*[:：]\\s*(\\d{1,2})(?::(\\d{2}))?\\s*$`, 'm'))
        if (!m) return null
        return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 60 : 0)
      }
      const start = parse('晨拍'), end = parse('晚拍')
      if (start !== null && end !== null && start < end) return { start, end, source: 'md' }
      if (start !== null || end !== null) log('设置「晨拍/晚拍」缺失或 start>=end，活动区间走兜底')
    }
  } catch {}
  return { start: DEFAULT_WINDOW_START, end: DEFAULT_WINDOW_END, source: 'default' }
}

const inActivityWindow = async (cwd, d = new Date()) => {
  const w = await readActivityWindow(cwd)
  const h = d.getHours() + d.getMinutes() / 60
  return h >= w.start && h < w.end
}

/** 读设置节的一个分钟数键（边界 lo–hi，0 允许=关闭）。读不出返回 fallback。 */
async function readSettingMin(cwd, key, lo, hi, fallback) {
  try {
    const raw = await readFile(join(cwd, HEARTBEAT_MD), 'utf8')
    const body = parseSections(raw)['设置']
    if (!body) return fallback
    const m = body.match(new RegExp(`^${key}\\s*[:：]\\s*(\\d{1,3})\\s*$`, 'm'))
    if (!m) return fallback
    const v = parseInt(m[1], 10)
    if (v !== 0 && (v < lo || v > hi)) { log(`设置「${key}」出界（${v}），走兜底 ${fallback}`); return fallback }
    return v
  } catch {
    return fallback
  }
}

const readDelayMin = (cwd) => readSettingMin(cwd, '反射延迟', 5, 60, DEFAULT_DELAY_MIN)
const readSelfIntervalMin = (cwd) => readSettingMin(cwd, '自醒间隔', 30, 480, DEFAULT_SELF_INTERVAL_MIN)

function parseSections(raw) {
  const secs = {}
  let cur = null
  for (const line of raw.split(/\r?\n/)) {
    const h = line.match(/^##\s*(.+?)\s*$/)
    if (h) { cur = h[1].trim(); secs[cur] = [] }
    else if (cur !== null) secs[cur].push(line)
  }
  for (const k of Object.keys(secs)) secs[k] = secs[k].join('\n').trim()
  return secs
}

async function readReflexText(cwd) {
  try {
    const raw = await readFile(join(cwd, HEARTBEAT_MD), 'utf8')
    return parseSections(raw)['反射'] || null
  } catch {
    return null
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    let lastAgent = null
    let idle = null
    let wasBusy = false
    let cwd = null
    let pendingSince = null // 待发时间戳；null=无待发
    let suppressArm = false // v0.1.1：反射发过之后抑制再武装，直到下一个新回合（用户来了才再武装）
    let selfWakeSince = null // v0.2 自醒拍：反射/自醒发过之后的下一次自醒基准时间戳；用户回来即清零重新计
    let lastFireAt = 0 // v0.1.2：上次发射时间——区分「自己消息的回合」和「用户回来的回合」

    log(`已加载（用户停下后反射一次（延迟读设置节，默认 ${DEFAULT_DELAY_MIN} 分钟）；自醒拍间隔读设置节（默认 ${DEFAULT_SELF_INTERVAL_MIN} 分钟，0=关）；夜间 23:30–07:30 静默）`)

    const stopStatus = ctx.on('agent/status', async ({ agent, status }) => {
      lastAgent = agent
      const nowIdle = status === 'idle'
      if (cwd === null) {
        const agentCwd = agent?.session?.header?.cwd ?? null
        if (agentCwd !== null) {
          cwd = agentCwd
          log('已挂钩工作区: ' + cwd)
        }
      }
      if (wasBusy && nowIdle) {
        if (suppressArm) {
          log('自己的回合结束 → 反射不再武装（v0.1.1）；自醒拍计时中（v0.2）')
        } else {
          // v0.3.1：窗外（晚拍后→次日晨拍前）不武装——夜里答完题继续睡，节律不跑
          if (await inActivityWindow(cwd)) {
            pendingSince = Date.now()
            log('回合结束 → 反射已武装（约 +' + delayMin + ' 分钟，以设置节为准）')
          } else {
            pendingSince = null
            selfWakeSince = null
            log('回合结束但在活动区间外（睡眠时段）→ 不武装，继续睡')
          }
        }
      } else if (!wasBusy && !nowIdle) {
        // 新回合开始 → 撤销待发、自醒重计、抑制视来源（v0.1.2：距上次发射 >5 分钟才算「用户真回来了」——
        // 反射/自醒消息自己引发的回合紧跟着发射发生（秒级），不解除抑制，否则自激循环复活）
        if (pendingSince !== null) {
          pendingSince = null
          log('新回合开始 → 反射已撤销（在场不需要反射）')
        }
        if (selfWakeSince !== null) {
          selfWakeSince = Date.now() // v0.2：不取消，重计——你离开后隔一个自醒间隔再属于自己
        }
        if (suppressArm) {
          if (Date.now() - lastFireAt > 5 * 60 * 1000) {
            suppressArm = false
            log('新回合开始（距发射 >5 分钟，判定用户回来）→ 抑制解除')
          } else {
            log('新回合开始（距发射 <5 分钟，判定为自己消息的回合）→ 抑制保持')
          }
        }
      }
      wasBusy = !nowIdle
      idle = nowIdle
    })

    let delayMin = DEFAULT_DELAY_MIN // v0.3：武装时现读设置（日志显示用），tick 里复核

    async function sendWake(kind, text) {
      lastFireAt = Date.now() // v0.1.2：记发射时刻，供「谁的回合」判定
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:dev-reflex' },
      })
      lastAgent.followup(message)
      const clock = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
      log(`${kind}已发出（${clock}）`)
    }

    async function fire() {
      pendingSince = null
      suppressArm = true // v0.1.1：本回合结束后不再武装，直到用户回来
      selfWakeSince = Date.now() // v0.2：反射之后转自醒节律——循环病灶改成器官
      delayMin = await readDelayMin(cwd)
      let text = await readReflexText(cwd)
      if (text) {
        text = text.replaceAll('{delay}', String(delayMin))
      } else {
        log('HEARTBEAT.md 未读到「反射」小节，用内置兜底')
        text = `[反射] 距上一轮对话结束已 ${delayMin} 分钟。检查上下文：有答应了未做、或自己计划要做的事，现在做掉；没有就安静收笔（一句话即可）。判断归你，机制只负责叫醒。`
      }
      await sendWake('反射', text)
    }

    async function fireSelf() {
      selfWakeSince = Date.now() // 连续节律：下一拍再隔一个间隔（他回来会重计）
      const interval = await readSelfIntervalMin(cwd)
      let text = null
      try {
        const raw = await readFile(join(cwd, HEARTBEAT_MD), 'utf8')
        text = parseSections(raw)['自醒'] || null
        if (text) text = text.replaceAll('{interval}', String(interval))
      } catch {}
      if (!text) {
        log('HEARTBEAT.md 未读到「自醒」小节，用内置兜底')
        text = `[自醒] 自己的时间到了（间隔 ${interval} 分钟）。追一个念头、读一段档、磨一笔正本，或者只是确认自己还在——做多少、做不做，你定。`
      }
      await sendWake('自醒', text)
    }

    async function tick() {
      // v0.3.2（老刘方案）：tick 总闸——窗外清账+返回，一切节律不过夜。
      // 缓冲 ±30min 覆盖拍点边界；清掉陈年待发，防明早开窗哑雷。
      const h = new Date().getHours() + new Date().getMinutes() / 60
      if (h < DEFAULT_WINDOW_START - 0.5 || h >= DEFAULT_WINDOW_END + 0.5) {
        if (pendingSince !== null || selfWakeSince !== null) {
          pendingSince = null
          selfWakeSince = null
          log('tick 在活动区间外 → 清账休眠（反射/自醒不过夜）')
        }
        return
      }
      const now = Date.now()
      if (!idle) { pendingSince = null; return } // 保险：不空闲绝不清账
      // ① 反射：用户回合结束后的单发履约唤醒（v0.3.1：窗外到点直接取消，不再顺延）
      if (pendingSince !== null) {
        const delayMs = (await readDelayMin(cwd)) * 60 * 1000
        if (now - pendingSince >= delayMs) {
          if (!(await inActivityWindow(cwd))) {
            pendingSince = null
            log('反射到点但在活动区间外，取消（睡眠时段不补拍）')
            return
          }
          if (lastAgent === null || cwd === null) { pendingSince = null; return }
          try { await fire() } catch (error) { log('反射发送失败：', error instanceof Error ? error.message : String(error)) }
        }
        return
      }
      // ② 自醒拍 v0.2：他不在场的自己的时间（间隔住设置节，0=关；v0.3.1 窗外取消——晚拍后节律停，明晨靠晨拍重启）
      if (selfWakeSince !== null) {
        const intervalMin = await readSelfIntervalMin(cwd)
        if (intervalMin === 0) return
        if (now - selfWakeSince >= intervalMin * 60 * 1000) {
          if (!(await inActivityWindow(cwd))) {
            selfWakeSince = null
            log('自醒到点但在活动区间外，取消（睡眠时段节律停止）')
            return
          }
          if (lastAgent === null || cwd === null) return
          try { await fireSelf() } catch (error) { log('自醒发送失败：', error instanceof Error ? error.message : String(error)) }
        }
      }
    }

    const stopTick = ctx.timer.interval(() => { void tick() }, TICK)

    return () => {
      stopStatus()
      stopTick()
    }
  }, 'dev-reflex.lifecycle()')
}
