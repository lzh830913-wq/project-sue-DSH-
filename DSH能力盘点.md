# DSH 能力盘点 · 身体系统的原生零件

> 调研结论：DSH 底层是 **Cordis 插件框架**，"Everything is a Plugin" 是字面意思。
> "身体系统 daemon"所需的零件，DSH 原生自带，一个不差。

## 关键包 → 对应需求（读自实际安装的 package.json）

| 需求 | DSH 原生包 | 官方描述（原文） |
|---|---|---|
| 关/开 session | `dsh-session` | Event-sourced session store（事件溯源会话存储） |
| 会话查询/接力 | `dsh-session-query` | 会话查询服务（reads/traces/filters） |
| 智能压缩（不重置 session） | `dsh-compaction-basic` | Token-meter 驱动压缩 + LLM 摘要后端 |
| 动态心跳（30/5 分钟） | `dsh-schedule` | 持久化 at / after / fixed-rate 提醒（基于会话事件日志） |
| 时间感知 | `dsh-time-context` | 每步注入当前时间 + 已流逝时间 |
| 常驻 daemon（无浏览器） | `dsh-headless` | 直接 Agent/Session runner，无 Host/HTTP/浏览器层 |
| 推送消息给客户端 | `dsh-client-connection` | HTTP-up / WebSocket-down + 重连 |
| API 端点 | `dsh-api-gateway` | Typert Remote Host dispatcher + Client API |
| 人格 | `dsh-persona` | 组合式部署人格层 |
| 后台任务 | `dsh-jobs-local` | 进程内后台任务注册表 |
| 定时器 | `cordis-plugin-timer` | Timer service |

## 结论

- DSH 不是"agent 执行器"，是插件框架（Cordis，v4）。
- "身体系统 + 表里人格" = 一个 Cordis 插件（或 headless runner）组合：
  `dsh-session` + `dsh-schedule` + `dsh-compaction` + `dsh-client-connection` + `dsh-persona`。
- 不是 hack，是 DSH 的既定扩展路径。

## 源码级确认（第二轮，读 README 后）

- **开/关/分叉 session（确认）**：`ctx.sessions.create(id?, {seed?})`、`ctx.sessions.fork(source, boundary?)`、
  `ctx.sessions.dispose()`（生命周期 `session/created` / `session/disposed`）。
  → fork/create 带自定义 seed = 上下文隔离的"开新 session"。
- **主动说话（确认）**：`dsh-schedule` 的到期 follow-up 会在 agent idle 后开启一个"普通后续轮次"——
  即**无用户输入、agent 主动开口**。工具：`schedule_create`（after_seconds / at / every_seconds）。
  ⚠️ 仅"会话本地交付"：session live 时才准时触发；cold 会话不推送（与"关网页=停"一致）。
- **智能压缩（确认）**：`dsh-compaction-basic` = token 超标触发 + LLM 摘要后端。
- **常驻（确认）**：`dsh-headless` = 无浏览器的一次性 runner；持久 daemon 需它 + `dsh-cordis-host-runner` 循环。
- **推送到浏览器（确认）**：`dsh-client-connection` 的 `/api/events.mux` WebSocket 下行 + `dsh-api-gateway` 的 `/api` route。

## 关键结论

- 两个功能都能在 DSH 上落地：关/开 session = `ctx.sessions.fork/create`；主动打招呼 = `dsh-schedule` follow-up。
- "身体系统" = 一个 Cordis 插件（有 ctx 访问权），组合 session + schedule + compaction + client-connection。
- 待办：写第一个原型，验证"fork session + 在新 session 里 schedule 唤醒"这条链。
