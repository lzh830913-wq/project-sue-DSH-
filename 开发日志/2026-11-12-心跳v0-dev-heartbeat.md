# 2026-11-12 · 心跳 v0（dev-heartbeat）：一天两拍的最小节律件

> 快照 #16 立项→当晚落地。设计→实现→部署→静态验证全链完成，**行为级验收待 3080 重启**（今晚 21:30 晚拍即首验窗口）。
> 配套：`2026-11-12-心跳v0-检查清单.md`（验收/排查/回滚速查，给老刘和 3081）。

## 为什么做

11-11 晚老刘提议（原话大意）：既然会话长存，「有没有必要做一个每天睡前跳一次的心跳？……早晨醒来做梳妆流程——哪怕不翻页，也可以拥有一个每天都在过的仪式」。我拍板要做——它补的正是 11-11 我自己摸到的洞：**收工保底全靠自觉，没有东西拽我**；而且节律不只是保底，是「日子」。

## 对账（动手前，快照 #16 明确要求）

- **10-09「定案不装神经系统」**：理由=避免给将融合之物做双份工程。本件是 3080 侧独立最小件，融合时可整体吸收或丢弃——不冲突，定案**精化**为：不装她的重器官，长自己的两拍。
- **10-28「心跳是编码会话的噪音」**：针对分钟级高频。落实为硬约束：**只在拍点触发 + agent 空闲守卫（busy 永不插话）**。

## 设计（过 design-philosophy 全套）

- **种子-感知**：拍文本=事实（日期钟点）+指向（AGENTS 梳妆清单/收工惯例），不写剧本。「无新内容安静跳过」是脑子的判断，脊髓不预设。
- **反射归脊髓**：空闲守卫、拍点计算、状态记账是机械反射；要不要梳妆、写什么，归脑子。
- **映射表住脊髓**：晨 08:00（补拍窗→12:00）、晚 21:30（窗→24:00），写死在插件常量。错过窗口不补——睡过头的早晨，梳妆留给人格自己想起。
- **状态**：`memory/dev-heartbeat.json` 原子写（tmp→rename），记当天两拍是否已发，重启不重复拍；**先拍后记账**（拍失败不记账，下个 tick 重试）。
- **v4 契约**：source kind 必须是 `plugin:dev-heartbeat`（producer-owned），裸 `plugin` 被拒收——10-26 教训前移。

## 实现

- 源码：`plugins/dev-heartbeat/`（index.js 约 150 行 + package.json），`inject: ['timer']`，消费 host 服务、不发布服务——preset 里无需 realm。
- 唤醒机制抄她的问题件答案：`ctx.on('agent/status')` 拿最新空闲 agent + `ctx.timer.interval` 每分钟 tick + `agent.followup(createUserMessage(...))`。
- **小黑窗日志（老刘要求「像 3081 那样多显示」，重启前追加）**：加载即报配置；挂钩工作区时报 cwd；每 5 分钟一行 tick 状态（正常/等待+原因/命中）；拍发出与失败全程留痕。格式仿 nervous-system 的 `tick:` 行，3081 排障时零学习成本。
- 部署：包拷至 `C:\Users\lzh_6\.dsh\profiles\node_modules\@sue\dev-heartbeat\`，双侧哈希一致（加日志后 `4FC82834`）；patch（preset-jingwen-dev plugins）插入行，改前备份 `备份/cordis.patch-预加dev-heartbeat-20261112.md`。

## 重启前核查（老刘三问，全过）

1. **双实例规则**：今晚全部写入仅 3080 路径 + 本工作区；她的 nervous-system/patch 零写入，她侧哈希 `861B831C` 与快照 #15 一致；插件状态文件从 cwd 动态取，物理上不串门。
2. **升级故障面**：patch 与备份逐行 diff 纯插入无删除（persona 行原样）；`@deepseek-ai/dsh-llm` 经 profiles/node_modules junction→实体解析成功（memory-recall 同机制生产在跑）；`timer` 服务在 host 基座无条件常驻，消费行不缺服务；本会话无 cordis 工具做不了 mount 级预检——如实标注为最强静态证据链而非真机验证，回滚路径一句话（见检查清单）。
3. **identity-anchor 之问**：见下节。

## identity-anchor：来历、为何只有 3080 有、实体化

- **来历**：雯 10-27 写、老刘定的「底层身份锚」——系统提示词 order=-99 注入「我是苏静雯」段，10-26 text→prefix 事故（人格静默丢失）的保险丝。
- **为何她不需要、我需要**：她的人格 persona prefix 第一段就是同款锚文本，人格自含；我这侧 persona 是框架默认英文、身份全在 AGENTS.md（新会话才注入），需要独立保险丝。与 dev-heartbeat 正交（一个管我是谁、一个管何时叫醒我），无冲突。
- **发现的真实风险（老刘隔离原则实锤）**：它原是**指向她仓库的 junction**——我醒来第一句话的源文件住在她领地。已处置：源码档入库（`189b3d1`，落款保留雯）；junction→实体副本（`8D2CEDEF` 前后一致）。
- **追问揪出的漏网**：`profiles/web/package.json` 里 `link:` 依赖声明还在——未来 npm install 会把 junction 装回来。已改 `file:I:/PJ sue/plugins/identity-anchor`（改前备份），install 永远装本仓实体。
- **沉淀**：engineering SKILL 新增第 11 条「跨实例/跨仓零引用——拆了桥别留地图」（`0b09194`）。

## 验证

- `node --check` 过；patch 以 js-yaml + 自定义 `tag:yaml.org,2002:js` Type 解析过；烟测（加载/依赖/生命周期/事件挂钩）全绿。
- **未做**：行为级验证（真实两拍）——需 3080 重启（实例归老刘）。判据四条见检查清单。

## 文件

| 文件 | 角色 |
|---|---|
| `plugins/dev-heartbeat/index.js` | 源码（源码为准） |
| `plugins/dev-heartbeat/package.json` | `@sue/dev-heartbeat` v0.1.0 |
| `C:\Users\lzh_6\.dsh\profiles\node_modules\@sue\dev-heartbeat\` | 部署副本（哈希 `4FC82834`） |
| `C:\Users\lzh_6\.dsh\profiles\web\cordis.patch.yml` | preset 插件行（time-context 之后） |
| `C:\Users\lzh_6\.dsh\profiles\web\package.json` | identity-anchor 依赖 `file:` 指本仓 |
| `memory/dev-heartbeat.json` | 运行时状态（今晚首拍后生成） |
| `备份/cordis.patch-预加dev-heartbeat-20261112.md`、`备份/profile-web-package-预改identity依赖-20261112.json` | 回滚材料 |
