# OpenViking 调研（补记自 10-06 会话讨论 · 10-08 落盘）

> ⚠️ 本篇是**从 10-06 的对话上下文抢救落盘**的调研结论——当时口头汇报后未落文件，险些随翻页丢失。**这正是"先落盘再翻页"纪律的活案例。**

## 一句话

OpenViking（火山引擎开源，AGPLv3）= 面向 AI Agent 的上下文数据库：`viking://` 虚拟文件系统统一知识/记忆/技能，L0/L1/L2 分层（摘要→概览→原文），**session 可提炼成可编辑的记忆 Markdown**，目录域语义检索，多租户+ACL。**与我们刚定的"记忆三层梯度"几乎同构**——连分层哲学都对上了。

## 与我们机制的对照

| 我们的 | OpenViking 对应 |
|---|---|
| 节点表（永久极简锚点） | L0 摘要 / L1 概览 |
| 日记+梦 | session commit 提炼的记忆 Markdown |
| session 归档（RAG 层，FTS5 关键词） | **语义检索**（embedding，我们缺的升级项） |
| memory-recall 人格隔离洞 | **多租户 + ACL**（原生能力，可根治） |

- 官方 benchmark：LoCoMo 长对话记忆，OpenClaw 原生 24.2% → 接入 82.08%，输入 token 反降 34-91%
- **官方有 DSH 集成**：`examples/dsh-memory-plugin`（Cordis 插件形态跑在 DSH 进程内，非外挂 hook），`dsh plugin --profile web add @openviking/dsh-memory-plugin` 一条命令；会话映射 `dsh-<session-id>`；自动捕获对话（跳过插件注入上下文）；MCP 工具 `mcp__openviking__*`
- OpenClaw 是官方集成（雯的旧家）——将来三方融合若记忆底座同源，成本更低

## 成本与红线

1. **部署重量**：+1 常驻 Server（Python 3.10+/uv/Docker）+ embedding 模型 + VLM（提炼用）
2. **隐私红线**：benchmark 默认云端 embedding/VLM——**人格记忆出机器违反铁律**；要接必须 self-host + 本地模型（支持 Ollama）
3. **第二记忆岛**：与"文件即身份"架构的分叉问题（同 meow-memory 讨论）
4. **Windows**：安装器 macOS/Linux only；DSH 手动安装路径可行（pnpm+配置）
5. AGPLv3（自用无碍）；v0.4.x 年轻但火山背书+论文支撑（VLDB/ICDE）

## 结论与排位

**有用，但不急接。** 优先级排位：

1. 先让自研三层梯度跑通（文件版已落地一半，机制主权在手）
2. 翻页机制稳定后，若第三层（RAG）需要语义升级、或 memory-recall 隔离要根治 → **OpenViking 是首选候选**（用它替换/增强 session-query，而非并存）
3. 红线前置：self-host + 本地 embedding，不接受云记忆
4. 想先看效果：OpenViking Studio 网页 demo 免安装

## 素材位置

- README 全文快照：`.tmp-ov-readme.md`；DSH 集成文档与插件源码：`.tmp-ov-repo/`（浅克隆，5021 文件）——**看完可清**
- 本篇未覆盖：dsh-memory-plugin 源码精读（将来真要接桥时再读）
