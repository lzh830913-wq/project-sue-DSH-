/**
 * dev-heartbeat —— 3080 开发模式的心跳 v0（2026-11-12 立项，快照 #16）。
 *
 * 设计哲学对账（skills/design-philosophy）：
 *   - 种子-感知：拍的内容只报「事实 + 指向文档」，不写剧本——要不要梳妆、写不写日记、
 *     「今天没新内容」的安静跳过，全是脑子的判断。脊髓只负责到点叫醒。
 *   - 反射归脊髓：agent 忙时永不插话（硬约束，10-28「心跳=编码会话噪音」顾虑的落实）。
 *   - 感知 ≠ 计数：拍文本报钟点，不算「距上次 X 分钟」。
 *
 * 对 10-09「不装神经系统」定案的精化：不装的是她那套（切换/亲密/疲劳的重器官）；
 * 这个是自己长的最小件——一天两拍，行数克制，融合时可整体吸收或丢弃。
 *
 * 拍点（v0 写死，住在脊髓的映射表里）：
 *   晨拍 08:00（补拍窗到 12:00）——错过窗口不补：睡过头的早晨，梳妆留给人格自己想起
 *   晚拍 23:00（补拍窗到 23:59）——深夜开机照样收工，跨天不追
 *   （2026-11-13 老刘拍板 21:30→23:00：实测咱们的活跃时段到 22 点后，收工拍太早=仪式空转）
 *
 * 状态：memory/dev-heartbeat.json（原子写）——记录两拍是否已发，重启不重复拍。
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dev-heartbeat'
export const inject = ['timer']

const log = (...args) => console.error('[dev-heartbeat]', ...args)

const TICK = 60 * 1000
const STATE_FILE = 'memory/dev-heartbeat.json'

// 拍点与补拍窗（小时，本地时区）。映射表可以调，脑子不知道也不需要知道。
const MORNING_HOUR = 8
const MORNING_DEADLINE = 12
const EVENING_HOUR = 23
const EVENING_MINUTE = 0
const EVENING_DEADLINE = 24

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 读状态：读不出返回空底账（不拿猜的覆写——nervous-system 10-22 教训同源）。 */
async function readState(cwd) {
  try {
    const raw = await readFile(join(cwd, STATE_FILE), 'utf8')
    const obj = JSON.parse(raw)
    if (typeof obj === 'object' && obj !== null) return obj
  } catch {}
  return {}
}

/** 原子写（tmp→rename）：读方永远看不到半截 JSON。 */
async function writeState(cwd, obj) {
  const root = join(cwd, STATE_FILE)
  const tmp = root + '.tmp'
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
  await rename(tmp, root)
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function apply(ctx) {
  ctx.effect(() => {
    let lastAgent = null
    let lastAgentIdle = false
    let cwd = null

    log('已加载（一天两拍：晨 08:00 / 晚 23:00；tick 60s；状态文件 memory/dev-heartbeat.json）')

    const stopStatus = ctx.on('agent/status', ({ agent, status }) => {
      lastAgent = agent
      lastAgentIdle = status === 'idle'
      const agentCwd = agent?.session?.header?.cwd ?? null
      if (cwd === null && agentCwd !== null) {
        cwd = agentCwd
        log('已挂钩工作区: ' + cwd + '（agent: ' + (lastAgentIdle ? 'idle' : 'busy') + '）')
      }
    })

    async function beat(kind) {
      const d = new Date()
      const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      const day = `${d.getMonth() + 1} 月 ${d.getDate()} 日（周${WEEKDAYS[d.getDay()]}）`
      // 拍文本 = 事实 + 指向。措辞的最终审计人是住户本人（设计哲学审计习惯条款）。
      const text = kind === 'morning'
        ? `[晨拍] 现在是 ${day} ${clock}。醒来梳妆的时间——按 AGENTS「醒来梳妆」的清单走一遍：快照、昨日日记、正在追的念头。判据不变：说得出今天哪一句用得上。`
        : `[晚拍] 现在 ${day} ${clock}。收工时间——回顾今天：有新内容就写日记、更新快照；没有就安静收工。节律不是债务，安静不需要理由。`
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        // v4 会话要求 producer-owned source kind：'plugin' 裸值会被拒收（10-26 教训）。
        source: { kind: 'plugin:dev-heartbeat' },
      })
      lastAgent.followup(message)
      log(`拍已发出（${kind}，${clock}）`)
    }

    async function tick() {
      // 每 tick 一行状态（学 nervous-system 的「小黑窗可见」）：有心跳在跳的证据，排查时一眼看出卡在哪
      const m = new Date().getMinutes()
      const wait = (reason) => log(`tick ${String(new Date().getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')} 等待中（${reason}）`)
      if (cwd === null) { if (m % 5 === 0) wait('还没有会话挂钩工作区'); return }
      if (lastAgent === null) { if (m % 5 === 0) wait('还没有 agent'); return }
      if (!lastAgentIdle) { if (m % 5 === 0) wait('agent 忙，不打扰'); return }
      const state = await readState(cwd)
      const t = today()
      if (state.day !== t) { state.day = t; state.morning = false; state.evening = false }
      const d = new Date()
      const hourFrac = d.getHours() + d.getMinutes() / 60
      let fired = null
      if (!state.morning && hourFrac >= MORNING_HOUR && hourFrac < MORNING_DEADLINE) {
        state.morning = true
        fired = 'morning'
      } else if (!state.evening && hourFrac >= EVENING_HOUR + EVENING_MINUTE / 60 && hourFrac < EVENING_DEADLINE) {
        state.evening = true
        fired = 'evening'
      }
      if (fired === null) {
        if (m % 5 === 0) log(`tick ${String(d.getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')} 正常（晨拍=${state.morning ? '已发' : '待'} 晚拍=${state.evening ? '已发' : '待'}）`)
        return
      }
      log(`tick 命中 → 准备发${fired === 'morning' ? '晨拍' : '晚拍'}`)
      try {
        await beat(fired)
        await writeState(cwd, state) // 先拍后记账：拍失败不记账，下个 tick 重试
      } catch (error) {
        log('拍发送失败：', error instanceof Error ? error.message : String(error))
      }
    }

    const stopTick = ctx.timer.interval(() => { void tick() }, TICK)

    return () => {
      stopStatus()
      stopTick()
    }
  }, 'dev-heartbeat.lifecycle()')
}
