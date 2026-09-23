// @sue/memory-recall — 记忆召回：跨会话全文搜索 + 会话内事件深挖。
// 把手薄层：底层是 DSH 的 sessionQuery 服务（SQLite FTS5 全文索引，openAt: first-search）。
// 挂载：profile patch insert（所有预设共享）。索引入库与查询均在本机，不出机器。
// 已知边界（静雯 2026-09-23 实测核验）：① 连续汉字会被 FTS5 当作单个 token——插件已做双字分词降级重试，但查询时主动用空格分隔更准；② 被读取文件的正文（tool/result 内容）不在索引范围。
export const name = 'memory-recall'
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['sessionQuery', 'tools']
const fmtTime = t => {
  try { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') } catch { return String(t) }
}
const clean = s => (s || '').replace(/\s+/g, ' ')
/** 连续汉字按双字切分（降级重试用）：「人格融合」→「人格 融合」。 */
function cjkPairSplit(q) {
  return q.replace(/([\u4e00-\u9fff]{2})(?=[\u4e00-\u9fff])/g, '$1 ').replace(/\s+/g, ' ').trim()
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'memory_search_sessions',
    description: 'Cross-session full-text search over ALL past conversation logs (the accurate "database" side of memory). Use this to recall exact past discussions, decisions, reasons, and their original context — e.g. "why did we implement X this way". Returns the best-matching excerpt per session. 中文查询请用空格分隔关键词（如「人格 融合」）；0 命中时会自动按双字分词降级重试。被读取文件的正文不在索引范围。',
    parameters: {
      query: { type: 'string', required: true, description: 'Full-text keywords (literal text match, whitespace-flexible)' },
      limit: { type: 'number', description: 'Max sessions returned (default 8, cap 20)' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args) {
      const limit = Math.min(args.limit ?? 8, 20)
      let page = await ctx.sessionQuery.searchSessions({ query: args.query, limit })
      let degraded = ''
      if (page.items.length === 0) {
        const alt = cjkPairSplit(args.query)
        if (alt !== args.query) {
          page = await ctx.sessionQuery.searchSessions({ query: alt, limit })
          degraded = `\n(原查询 0 命中，已自动按双字分词降级重试：「${alt}」)`
        }
      }
      const out = page.items.map(h => {
        const bm = h.bestMatch || {}
        return [
          `session ${h.header?.id ?? '?'}`,
          `  title: ${h.header?.title || '(untitled)'}`,
          `  best match @ ${fmtTime(bm.time)}`,
          `  excerpt: ${clean(bm.snippet).slice(0, 320)}`,
        ].join('\n')
      })
      return `hits: ${out.length}${page.nextCursor ? ' (more pages available — narrow the query)' : ''}${degraded}\n\n${out.join('\n\n') || '(no matches)'}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search_events',
    description: 'Full-text search WITHIN one specific session (dig into details after memory_search_sessions locates the session). Returns matching events with excerpts and timestamps. 中文查询请用空格分隔关键词；0 命中时自动按双字分词降级重试。',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target session id (from memory_search_sessions)' },
      query: { type: 'string', required: true, description: 'Full-text keywords' },
      limit: { type: 'number', description: 'Max events (default 10, cap 30)' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args) {
      const limit = Math.min(args.limit ?? 10, 30)
      let page = await ctx.sessionQuery.searchEvents({ sessionId: args.sessionId, query: args.query, limit })
      let degraded = ''
      if (page.items.length === 0) {
        const alt = cjkPairSplit(args.query)
        if (alt !== args.query) {
          page = await ctx.sessionQuery.searchEvents({ sessionId: args.sessionId, query: alt, limit })
          degraded = `\n(原查询 0 命中，已自动按双字分词降级重试：「${alt}」)`
        }
      }
      const out = page.items.map(ev => `[seq ${ev.seq} · ${fmtTime(ev.time)} · ${ev.surface}] ${clean(ev.snippet).slice(0, 280)}`)
      return `hits: ${out.length}${page.nextCursor ? ' (more pages)' : ''}${degraded}\n\n${out.join('\n---\n') || '(no matches)'}`
    },
  }))
}
