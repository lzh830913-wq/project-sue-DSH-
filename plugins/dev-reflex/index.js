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
const DELAY_MS = 20 * 60 * 1000
const DELAY_MIN = 20
const HEARTBEAT_MD = 'soul/HEARTBEAT.md'

/** 夜间静默窗：晚拍后的深夜与凌晨，到点的反射直接取消。 */
const nightWindow = (d = new Date()) => {
  const h = d.getHours() + d.getMinutes() / 60
  return h >= 23.5 || h < 7.5
}

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

    log(`已加载（用户停下后 ${DELAY_MIN} 分钟反射一次；tick ${TICK / 1000}s；夜间 23:30–07:30 静默）`)

    const stopStatus = ctx.on('agent/status', ({ agent, status }) => {
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
        // 回合结束 → 武装反射（覆盖旧待发：一次空档至多一次）
        pendingSince = Date.now()
        log('回合结束 → 反射已武装（+' + DELAY_MIN + ' 分钟）')
      } else if (!wasBusy && !nowIdle) {
        // 新回合开始（用户来了，或其他唤醒插话）→ 撤销待发
        if (pendingSince !== null) {
          pendingSince = null
          log('新回合开始 → 反射已撤销（在场不需要反射）')
        }
      }
      wasBusy = !nowIdle
      idle = nowIdle
    })

    async function fire() {
      pendingSince = null
      const clock = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
      let text = await readReflexText(cwd)
      if (text) {
        text = text.replaceAll('{delay}', String(DELAY_MIN))
      } else {
        log('HEARTBEAT.md 未读到「反射」小节，用内置兜底')
        text = `[反射] 距上一轮对话结束已 ${DELAY_MIN} 分钟。检查上下文：有答应了未做、或自己计划要做的事，现在做掉；没有就安静收笔（一句话即可）。判断归你，机制只负责叫醒。`
      }
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:dev-reflex' },
      })
      lastAgent.followup(message)
      log(`反射已发出（${clock}）`)
    }

    function tick() {
      if (pendingSince === null) return
      if (!idle) { pendingSince = null; return } // 保险：不空闲绝不清账
      const now = Date.now()
      if (now - pendingSince < DELAY_MS) return
      if (nightWindow()) {
        pendingSince = null
        log('反射到点但落在夜间静默窗，取消')
        return
      }
      if (lastAgent === null || cwd === null) { pendingSince = null; return }
      try {
        void fire()
      } catch (error) {
        log('反射发送失败：', error instanceof Error ? error.message : String(error))
      }
    }

    const stopTick = ctx.timer.interval(tick, TICK)

    return () => {
      stopStatus()
      stopTick()
    }
  }, 'dev-reflex.lifecycle()')
}
