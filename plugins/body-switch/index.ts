/**
 * body-switch — 身体系统 · 人格切换插件（第三稿）
 *
 * 三个 TODO 已查清 + TODO 4 挖出两个更深事实：
 *
 * 已确认的 API：
 *  - 工具注册：defineTool + toolCtx.tools.register（agent/created 时挂到 agent.ctx）
 *  - 当前 session：execute(args, exec) 里 exec.agent / exec.agent.session
 *  - 主动唤醒：agent.followup(message)；定时靠 schedule/change 事件 + createAfterScheduleRecord
 *  - 新建子 agent：ctx.agents.create({ sessionId, meta:{ parentSession, seedLength, cwd }, seed })
 *  - fork 会话：ctx.sessions.fork(source, boundary) —— 边界必须是"已完成的回合"，不能卡在开放回合里
 *
 * 两个仍需工程处理的点（诚实标注）：
 *  A) fork 边界：工具是"回合中途"被调用的，fork 不能发生在这里。需等回合结束后，
 *     在最后一个 turn/end 边界处 fork（用 agent.runMaintenance / whenIdle 或 schedule 的 followup 延迟执行）。
 *  B) 旧 agent 的 dispose：AgentHandle 是"能力"，只有创建它的持有者（UI/ACP 桥）能关掉，
 *     插件（工具）拿不到旧 agent 的 handle。所以"关旧 agent + 把会话切到子 agent"这一步，
 *     要和 UI/会话引用层配合，不是插件单方面能完成的。
 *
 * 本稿把 A、B 的实现位置标出来，等构建阶段与 UI 会话层对齐后补全。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAfterScheduleRecord, allocateScheduleId, foldScheduleEvents } from '@deepseek-ai/dsh-schedule'

export const name = 'body-switch'
export const inject = ['agents', 'sessions', 'tools', 'sessionPersistence']

interface SwitchArgs {
  to: 'wen' | 'jingwen'
  relay_summary: string
}

/** 找最后一个"已完成的回合"边界（fork 必须落在 turn/end 上，不能卡在开放回合）。 */
function lastCompletedTurnSeq(session: { events: readonly { type: string }[] }): number {
  for (let i = session.events.length - 1; i >= 0; i--) {
    if (session.events[i].type === 'turn/end') return i
  }
  return 0
}

export function apply(ctx: Context) {
  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return

      const cleanup = agent.ctx.effect(() => {
        const disposeTool = agent.ctx.tools.register(defineTool({
          name: 'persona_switch',
          description:
            '切换表里人格：收束当前人格 → 上下文隔离（fork 新 session）→ 在新 session 里定时唤醒新人格、主动打招呼。' +
            'to 为 wen 或 jingwen；relay_summary 是接力摘要（受控的桥）。',
          parameters: {
            to: { type: 'string', required: true, enum: ['wen', 'jingwen'] },
            relay_summary: { type: 'string', required: true, description: '接力摘要，写入新 session 种子' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                to: { type: 'string', required: true },
                child_session: { type: 'string', required: true },
              },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args: SwitchArgs, exec) {
            const current = exec.agent
            const session = current.session

            // 1) 上下文隔离：fork 子 session（边界 = 最后一个完成的回合，见 A）
            const boundary = lastCompletedTurnSeq(session)
            const child = ctx.sessions.fork(session, boundary)

            // 2) 新建子 agent 绑定子 session（TODO B：旧 agent 的 dispose 需 UI 层配合）
            const childHandle = await ctx.agents.create({
              sessionId: child.id,
              meta: { parentSession: session.id, seedLength: boundary, cwd: session.header.cwd },
              seed: child.events,
            })

            // 3) 在子 session 造"唤醒"提醒：1 秒后触发，schedule 运行时会对子 agent followup
            const folded = foldScheduleEvents(child.events, child.header.seedLength ?? 0)
            const id = allocateScheduleId(folded)
            const prompt = `你现在是「${args.to}」。接力摘要：${args.relay_summary}。醒来，向老刘自然打招呼。`
            const record = createAfterScheduleRecord(id, prompt, 1, Date.now())
            child.append('schedule/change', { version: 1, operation: 'create', schedule: record })

            // 4) 提示 UI 把当前会话切到子会话（子 agent 即将主动开口）
            return { ok: true, to: args.to, child_session: String(child.id) }
          },
          presentCall: (args) => ({ card: 'generic', title: '切换人格', kind: 'other', rawInput: (args as SwitchArgs).to }),
        }))

        return () => { disposeTool() }
      }, 'body-switch.tool()')

      return cleanup
    })

    return () => { stopCreated() }
  }, 'body-switch.lifecycle()')
}
