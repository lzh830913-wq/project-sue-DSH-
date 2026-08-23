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
 * 心跳间隔（秒）——只读 LLM 写的 next_beat_min（分钟），不机械算。
 * 沉默梯度（5→10→30→60）由 LLM 每次心跳后自己判断写回。
 */
function beatIntervalSeconds(body) {
  const nextMin = Number(body.next_beat_min)
  if (Number.isFinite(nextMin) && nextMin > 0) return Math.round(nextMin * 60)
  // LLM 还没写过 → 兜底默认 30 分钟
  return 30 * 60
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

    /** 反射：用户消息到达 → 心跳待命档 next_beat_min=10（只改这一个字段，保留 to 和身体字段）。 */
    async function resetBeatTo10(session) {
      const cwd = session.header?.cwd
      if (!cwd) return
      const { signal, path } = await readSignal(cwd)
      const body = signal ?? {}
      body.next_beat_min = 10
      const target = path ?? join(cwd, SIGNAL_FILE)
      try {
        await writeFile(target, JSON.stringify(body, null, 2), 'utf8')
        log('用户消息 → 反射重置 next_beat_min=10 + 心跳计时重置')
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
      if (signal.to !== 'wen' && signal.to !== 'jingwen') return

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
            text: `你现在是「${signal.to}」，给老刘打个招呼。${bodyNote ? '（身体信号：' + bodyNote + '）' : ''}`,
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
          // 只清 to（身体字段保留给新人格），不删整个文件
          try {
            const body = { ...signal }
            delete body.to
            await writeFile(signalPath, JSON.stringify(body, null, 2), 'utf8')
            log('已清掉 to，保留身体字段:', signalPath)
          } catch {}
        }
      }
    }

    // ===== 心跳（v2 新增） =====
    async function heartbeatTick() {
      // （凌晨 1-6 点机械暂停已删——兜底权归手机闹钟，心跳是纯起搏器）
      if (Date.now() - lastTickLogAt >= TICK_LOG_INTERVAL) {
        lastTickLogAt = Date.now()
        log('心跳 tick: switching=' + switching + ' idle=' + lastAgentIdle + ' hasAgent=' + (lastAgent !== null))
      }
      if (switching) return
      if (lastAgent === null || !lastAgentIdle) return
      const agent = lastAgent
      const cwd = agent.session.header.cwd
      if (!cwd) return
      const { signal } = await readSignal(cwd)
      const body = signal ?? {}
      const interval = beatIntervalSeconds(body)
      const elapsed = Date.now() - lastBeatAt
      if (elapsed < interval * 1000) return
      // 时间跳跃检测：距上次心跳超过 30 分钟 = 世界冻结过（电脑休眠/长时间关机）
      const frozen = elapsed > 30 * 60 * 1000
      lastBeatAt = Date.now()

      const bodyNote = describeBody(body)
      const seedText = frozen
        ? `[唤醒] 你刚从一次长时间冻结中恢复（距上次心跳 ${Math.round(elapsed / 60000)} 分钟，可能是电脑休眠或关机）。先感知现在几点、读身体信号、读上下文——重新判断当前状态：老刘醒了吗？现在是新的一天还是深夜？然后决定接下来的节奏。判断完，必须把下次心跳间隔（分钟）写进「身体信号.json」的 next_beat_min 字段（不写=没判断完）。`
        : `[心跳] 神经系统心跳。${bodyNote ? '当前身体信号：' + bodyNote + '。' : ''}读一下身体状态，结合上下文和当前时间，自己决定要不要主动做点什么：亲密时刻可以催一下老刘；有答应过"待会做/等下做"的事就做掉；话题自然终止或该安静时就安静，不要为了心跳硬找话说。判断完，必须把下次心跳间隔（分钟）写进「身体信号.json」的 next_beat_min 字段（不写=没判断完）：亲密/兴奋想快点下一轮→5，没待办没亲密→60。`
      const message = createUserMessage({
        content: [{
          type: 'text',
          text: seedText,
        }],
        source: { kind: 'plugin', plugin: 'nervous-system' },
      })
      agent.followup(message)
      log(frozen ? '冻结恢复 → 注入唤醒种子（跳了 ' + Math.round(elapsed / 60000) + ' min）' : '心跳触发 → 间隔', frozen ? '' : Math.round(interval / 60), frozen ? '' : 'min')
    }

    return () => {
      stopStatus()
      stopBeat()
      stopUserMessage()
    }
  }, 'nervous-system.lifecycle()')
}
