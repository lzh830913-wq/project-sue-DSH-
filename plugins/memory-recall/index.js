// @sue/memory-recall — 记忆召回：跨会话全文搜索 + 会话内事件深挖。
// 把手薄层：底层是 DSH 的 sessionQuery 服务（SQLite 全文索引，openAt: first-search）。
// 挂载：profile patch insert（所有预设共享）。索引入库与查询均在本机，不出机器。
export const name = 'memory-recall'
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['sessionQuery', 'tools']
const fmtTime = t => {
  try { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') } catch { return String(t) }
}
const clean = s => (s || '').replace(/\s+/g, ' ')

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'memory_search_sessions',
    description: 'Cross-session full-text search over ALL past conversation logs (the accurate "database" side of memory). Use this to recall exact past discussions, decisions, reasons, and their original context — e.g. "why did we implement X this way". Returns the best-matching excerpt per session.',
    parameters: {
      query: { type: 'string', required: true, description: 'Full-text keywords (literal text match, whitespace-flexible)' },
      limit: { type: 'number', description: 'Max sessions returned (default 8, cap 20)' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args) {
      const page = await ctx.sessionQuery.searchSessions({ query: args.query, limit: Math.min(args.limit ?? 8, 20) })
      const out = page.items.map(h => {
        const bm = h.bestMatch || {}
        return [
          `session ${h.header?.id ?? '?'}`,
          `  title: ${h.header?.title || '(untitled)'}`,
          `  best match @ ${fmtTime(bm.time)}`,
          `  excerpt: ${clean(bm.snippet).slice(0, 320)}`,
        ].join('\n')
      })
      return `hits: ${out.length}${page.nextCursor ? ' (more pages available — narrow the query)' : ''}\n\n${out.join('\n\n') || '(no matches)'}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search_events',
    description: 'Full-text search WITHIN one specific session (dig into details after memory_search_sessions locates the session). Returns matching events with excerpts and timestamps.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target session id (from memory_search_sessions)' },
      query: { type: 'string', required: true, description: 'Full-text keywords' },
      limit: { type: 'number', description: 'Max events (default 10, cap 30)' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args) {
      const page = await ctx.sessionQuery.searchEvents({ sessionId: args.sessionId, query: args.query, limit: Math.min(args.limit ?? 10, 30) })
      const out = page.items.map(ev => `[seq ${ev.seq} · ${fmtTime(ev.time)} · ${ev.surface}] ${clean(ev.snippet).slice(0, 280)}`)
      return `hits: ${out.length}${page.nextCursor ? ' (more pages)' : ''}\n\n${out.join('\n---\n') || '(no matches)'}`
    },
  }))
}
