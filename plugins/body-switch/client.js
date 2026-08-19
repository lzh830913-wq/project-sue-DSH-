/**
 * nervous-system client half —— 切换后自动把界面切到新人格的子 session。
 *
 * 装载方式：双面包（package.json 声明 dsh.client + exports["./client"]），
 * 本文件是 client bundle（由 client-modules 服务经 /plugins/<id>/client.js 下发，
 * 在浏览器里以 window.__ModuleLoader__.load 装载，无需 build/tsdown）。
 *
 * 逻辑：订阅 session 列表（ctx.sessions.list）。当出现一个「带 parentId 且非
 * subagent」的新会话时，就 sessions.open 切过去——人格切换的子 session 正是这种
 * （ctx.agents.create 带 parentSession，seed 为空）。首帧只记录存量、不动作，
 * 避免冷启动时误切到历史 fork 子会话。
 */
window.__ModuleLoader__.load({
  id: "@sue/nervous-system",
  factory: () => {
    const module = { exports: {} }

    function apply(ctx) {
      const sessions = ctx.sessions
      let initialized = false
      const seen = new Set()

      ctx.effect(() => sessions.list.subscribe(() => {
        const snap = sessions.list.getSnapshot()
        if (!initialized) {
          for (const id of snap.ids) seen.add(id)
          initialized = true
          return
        }
        for (const id of snap.ids) {
          if (seen.has(id)) continue
          seen.add(id)
          const summary = snap.byId[id]
          if (summary !== undefined && summary.parentId !== undefined && summary.origin !== "subagent") {
            sessions.open(id)
          }
        }
        for (const id of seen) {
          if (snap.ids.indexOf(id) === -1) seen.delete(id)
        }
      }), "nervous-system.client: auto-open")
    }

    module.exports = { apply, inject: ["sessions"] }
    return module.exports
  }
})
