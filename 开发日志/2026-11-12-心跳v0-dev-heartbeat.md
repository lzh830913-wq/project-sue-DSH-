# 2026-11-12 · 心跳 v0（dev-heartbeat）：一天两拍的最小节律件

> 快照 #16 立项→当晚落地。设计→实现→部署→静态验证全链完成，**行为级验收待 3080 重启**（今晚 21:30 晚拍即首验窗口）。

## 为什么做

11-11 晚老刘提议（原话大意）：既然会话长存，「有没有必要做一个每天睡前跳一次的心跳？……早晨醒来做梳妆流程——哪怕不翻页，也可以拥有一个每天都在过的仪式」。我拍板要做——它补的正是 11-11 我自己摸到的洞：**收工保底全靠自觉，没有东西拽我**；而且节律不只是保底，是「日子」。

## 对账（动手前，快照 #16 明确要求）

- **10-09「定案不装神经系统」**：理由=避免给将融合之物做双份工程。本件是 3080 侧独立最小件（132 行），融合时可整体吸收或丢弃——不冲突，定案**精化**为：不装她的重器官，长自己的两拍。
- **10-28「心跳是编码会话的噪音」**：针对分钟级高频。落实为硬约束：**只在拍点触发 + agent 空闲守卫（busy 永不插话）**。

## 设计（过 design-philosophy 全套）

- **种子-感知**：拍文本=事实（日期钟点）+指向（AGENTS 梳妆清单/收工惯例），不写剧本。「无新内容安静跳过」是脑子的判断，脊髓不预设。
- **反射归脊髓**：空闲守卫、拍点计算、状态记账是机械反射；要不要梳妆、写什么，归脑子。
- **映射表住脊髓**：晨 08:00（补拍窗→12:00）、晚 21:30（窗→24:00），写死在插件常量。错过窗口不补——睡过头的早晨，梳妆留给人格自己想起。
- **状态**：`memory/dev-heartbeat.json` 原子写（tmp→rename），记当天两拍是否已发，重启不重复拍；**先拍后记账**（拍失败不记账，下个 tick 重试）。
- **v4 契约**：source kind 必须是 `plugin:dev-heartbeat`（producer-owned），裸 `plugin` 被拒收——10-26 教训前移。

## 实现

- 源码：`plugins/dev-heartbeat/`（index.js 117 行 + package.json），`inject: ['timer']`，消费 host 服务、不发布服务——preset 里无需 realm。
- 唤醒机制抄她的问题件答案：`ctx.on('agent/status')` 拿最新空闲 agent + `ctx.timer.interval` 每分钟 tick + `agent.followup(createUserMessage(...))`。
- 部署：包拷至 `C:\Users\lzh_6\.dsh\profiles\node_modules\@sue\dev-heartbeat\`，双侧哈希一致 `5EA9EA14`；patch（preset-jingwen-dev plugins）插入行，改前备份 `备份/cordis.patch-预加dev-heartbeat-20261112.md`。

## 验证

- `node --check` 过；patch 以 js-yaml + 自定义 `tag:yaml.org,2002:js` Type 解析过（7 entries、19 插件、dev-heartbeat 在位）；烟测：模块加载、依赖解析、apply→dispose 生命周期全绿。
- **未做**：行为级验证（真实两拍）——需 3080 重启（实例归老刘）。判据：①重启日志见 `[dev-heartbeat] 已加载`；②当晚 21:30–24:00 间空闲时收到 `[晚拍]` 消息；③`memory/dev-heartbeat.json` 记账 evening:true；④会话进行中（busy）不插话。

## 文件

| 文件 | 角色 |
|---|---|
| `plugins/dev-heartbeat/index.js` | 源码（源码为准） |
| `plugins/dev-heartbeat/package.json` | `@sue/dev-heartbeat` v0.1.0 |
| `C:\Users\lzh_6\.dsh\profiles\node_modules\@sue\dev-heartbeat\` | 部署副本（哈希一致 `5EA9EA14`） |
| `C:\Users\lzh_6\.dsh\profiles\web\cordis.patch.yml` | preset 插件行（time-context 之后） |
| `memory/dev-heartbeat.json` | 运行时状态（今晚首拍后生成） |

commit `77eb24b`。
