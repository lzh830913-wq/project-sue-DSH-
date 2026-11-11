// @sue/memory-recall — 记忆召回：跨会话全文搜索 + 会话内事件深挖。
// 把手薄层：底层是 DSH 的 sessionQuery 服务（SQLite FTS5 全文索引，openAt: first-search）。
// 挂载：profile patch insert（所有预设共享）。索引入库与查询均在本机，不出机器。
// 已知边界（静雯 2026-09-23 实测核验）：① 连续汉字会被 FTS5 当作单个 token——插件已做双字分词降级重试；② 被读取文件的正文（tool/result 内容）不在索引范围。
// ★ 2026-11-11 多词修复（10-09 诊断、11-11 拍板）：FTS5 把整串查询当短语——多词=零命中（只剩自回显假阳性）。
//   修法：插件侧拆词 → 逐词检索 → 会话/事件级合并（全中 > 任一中）。工具描述同步修正（旧文案是反向指引）；fmtTime 改本地时区（旧为 UTC）。
export const name = 'memory-recall'
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['sessionQuery', 'tools']
const fmtTime = t => {
  // 2026-11-11：旧版 toISOString() 显示的是 UTC（"12:33"实为北京 20:33）——改本地时区
  try {
    const d = new Date(t)
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch { return String(t) }
}
const clean = s => (s || '').replace(/\s+/g, ' ')
/** 连续汉字按双字切分（降级重试用）：「人格融合」→「人格 融合」。 */
function cjkPairSplit(q) {
  return q.replace(/([\u4e00-\u9fff]{2})(?=[\u4e00-\u9fff])/g, '$1 ').replace(/\s+/g, ' ').trim()
}
/** 拆词（2026-11-11）：按空白切分去重。多词不再整串进 FTS5（短语语义=零命中），改逐词检索后合并。 */
const splitTerms = q => [...new Set((q || '').trim().split(/\s+/).filter(Boolean))]

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'memory_search_sessions',
    description: 'Cross-session full-text search over ALL past conversation logs (the accurate "database" side of memory). Use this to recall exact past discussions, decisions, reasons, and their original context — e.g. "why did we implement X this way". Returns the best-matching excerpt per session. 多词查询自动拆词分别检索、按会话合并（全中优先于任一中）；单词查询直接命中更准；0 命中时自动按双字分词降级重试。被读取文件的正文不在索引范围。',
    parameters: {
      query: { type: 'string', required: true, description: 'Full-text keywords; multiple terms are split and merged per session' },
      limit: { type: 'number', description: 'Max sessions returned (default 8, cap 20)' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args) {
      const limit = Math.min(args.limit ?? 8, 20)
      const terms = splitTerms(args.query)
      let items = []
      let note = ''
      let more = ''
      if (terms.length <= 1) {
        let page = await ctx.sessionQuery.searchSessions({ query: args.query, limit })
        if (page.items.length === 0) {
          const alt = cjkPairSplit(args.query)
          if (alt !== args.query) {
            page = await ctx.sessionQuery.searchSessions({ query: alt, limit })
            note = `\n(原查询 0 命中，已自动按双字分词降级重试：「${alt}」)`
          }
        }
        more = page.nextCursor ? ' (more pages available — narrow the query)' : ''
        items = page.items.map(h => ({ header: h.header, bestMatch: h.bestMatch, hit: 1, of: 1 }))
      } else {
        // 多词（2026-11-11）：逐词查（每词放宽到 20），按会话合并——全中 > 任一中，同档按最新命中时间
        const perTerm = []
        for (const term of terms) perTerm.push(await ctx.sessionQuery.searchSessions({ query: term, limit: 20 }))
        const bySess = new Map()
        perTerm.forEach(page => {
          for (const h of page.items) {
            const id = h.header?.id ?? '?'
            let e = bySess.get(id)
            if (!e) { e = { header: h.header, bestMatch: h.bestMatch, hit: 0, best: -1 }; bySess.set(id, e) }
            e.hit += 1
            const t = Date.parse(h.bestMatch?.time ?? '')
            if (Number.isFinite(t) && t > e.best) { e.best = t; e.bestMatch = h.bestMatch }
          }
        })
        items = [...bySess.values()]
          .sort((a, b) => (b.hit - a.hit) || ((b.best || 0) - (a.best || 0)))
          .slice(0, limit)
          .map(e => ({ header: e.header, bestMatch: e.bestMatch, hit: e.hit, of: terms.length }))
        const full = items.filter(e => e.hit === terms.length).length
        note = `\n(多词合并：${terms.length} 词，全中 ${full} / 共 ${items.length})`
      }
      const out = items.map(h => {
        const bm = h.bestMatch || {}
        return [
          `session ${h.header?.id ?? '?'}`,
          `  title: ${h.header?.title || '(untitled)'}`,
          `  best match @ ${fmtTime(bm.time)}` + (h.of > 1 ? `  [${h.hit}/${h.of} 词]` : ''),
          `  excerpt: ${clean(bm.snippet).slice(0, 320)}`,
        ].join('\n')
      })
      return `hits: ${out.length}${more}${note}\n\n${out.join('\n\n') || '(no matches)'}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search_events',
    description: 'Full-text search WITHIN one specific session (dig into details after memory_search_sessions locates the session). Returns matching events with excerpts and timestamps. 多词查询自动拆词分别检索、按事件合并（全中优先）；0 命中时自动按双字分词降级重试。',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target session id (from memory_search_sessions)' },
      query: { type: 'string', required: true, description: 'Full-text keywords; multiple terms are split and merged per event' },
      limit: { type: 'number', description: 'Max events (default 10, cap 30)' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args) {
      const limit = Math.min(args.limit ?? 10, 30)
      const terms = splitTerms(args.query)
      let items = []
      let note = ''
      const fmtEv = ev => `[seq ${ev.seq} · ${fmtTime(ev.time)} · ${ev.surface}]` + (ev._of > 1 ? ` [${ev._hit}/${ev._of} 词]` : '') + ` ${clean(ev.snippet).slice(0, 280)}`
      if (terms.length <= 1) {
        let page = await ctx.sessionQuery.searchEvents({ sessionId: args.sessionId, query: args.query, limit })
        if (page.items.length === 0) {
          const alt = cjkPairSplit(args.query)
          if (alt !== args.query) {
            page = await ctx.sessionQuery.searchEvents({ sessionId: args.sessionId, query: alt, limit })
            note = `\n(原查询 0 命中，已自动按双字分词降级重试：「${alt}」)`
          }
        }
        note = page.nextCursor ? ' (more pages)' : note
        items = page.items.map(ev => ({ ...ev, _hit: 1, _of: 1 }))
      } else {
        const perTerm = []
        for (const term of terms) perTerm.push(await ctx.sessionQuery.searchEvents({ sessionId: args.sessionId, query: term, limit: 30 }))
        const bySeq = new Map()
        perTerm.forEach(page => {
          for (const ev of page.items) {
            let e = bySeq.get(ev.seq)
            if (!e) { e = { ...ev, _hit: 0, _of: terms.length }; bySeq.set(ev.seq, e) }
            e._hit += 1
          }
        })
        items = [...bySeq.values()].sort((a, b) => (b._hit - a._hit) || (b.seq - a.seq)).slice(0, limit)
        note = `\n(多词合并：${terms.length} 词)`
      }
      const out = items.map(fmtEv)
      return `hits: ${out.length}${note}\n\n${out.join('\n---\n') || '(no matches)'}`
    },
  }))
}
