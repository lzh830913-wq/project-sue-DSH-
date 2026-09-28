# 开发日志 · 2026-09-27（三）：meow-memory 调研——能不能直接用？

> 类型：**调研**（无机制改动）。当天所写。
> 触发：老刘发现插件 `dsh-meow-memory`，问"是不是更适合你的开发工作"。
> 判定标准（老刘原话）：**"如果可以直接用就直接用；如果有冲突，那我宁愿不用——我们的系统并不复杂。"**

## 一句话

**结论：可以直接用，不干扰人格、不干扰心跳、DSH 本体也没有它会撞的 dream 机制。** 但要先定两条边界（`.gitignore` 记忆目录、接受 system prompt 变大），且它的「搜原始日志」建议是错的（不能照用）。

## 它是什么（实读源码确认）

- 仓库：[Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)（MIT，npm 名 `meow-memory`，中文 README）
- **七层结构化记忆**，每层一张 SQLite 表：`soul`(关于 AI 自身) / `user`(用户信息与偏好) / `project`(含 overview·structure·decisions·quotes·ops·todo 子类) / `fact`(原子事实) / `lesson`(教训与纠正) / `topic`(进行中的话题) / `rules`(设计原则与准则)
- **存储**：`<工作区>/.dsh-meow/memory.db`（`node:sqlite`，WAL + `busy_timeout=5000`，**多实例共享同一 db 是设计内场景**）+ 全局目录 `~/.dsh-meow`（日志、window-index、实例级 prompt 覆盖）
- **注入**：静态 `meow-memory:guide` section 进 system prompt（固定文本，KV 缓存友好）；**首轮**注入 soul/user/rules(importance≥2) 全量 + 记忆导引；**第二轮起**每条用户消息按关键词 BM25 命中 top-2（打分 = 交集 × idf × 覆盖率 × 艾宾浩斯衰减 × importance × title 加成）
- **dream（记忆整理）**：窗口空闲 ≥180 分钟且**非 API 峰时**（默认北京时间 09:00–12:00、14:00–18:00 及各自前 15 分钟抑制）；由**该窗口的主 agent 自己**分三轮整理（原子记忆 → topic → 项目总结）；`/dream` 命令或 `memory_dream` 工具可手动触发
- **工具**：`memory_remember` / `memory_search` / `memory_project` / `memory_find_similar` / `memory_read` / `memory_update` / `memory_dream`
- **压缩后重注入**：会话被 compact 后，下一轮自动补回长期记忆快照 + 本会话查阅过的项目全景
- 自带 228 项测试；客户端有折叠 UI、会话列表月牙图标、设置页「喵记忆」标签
- 兼容性：声明支持 **0.1.5**（含 0.1.5-rc.1）且向下兼容，**已实测 0.1.1-rc.2**（＝我们当前版本）

## 查证：会不会干扰我们的系统（逐条）

### 1. DSH 本体有没有 dream？——**没有**

扫过 0.1.1-rc.2 的 197 个官方包：**无任何 dream / 记忆整合类插件**。DSH 自带与记忆相关的只有 `dsh-session-query` / `dsh-session-query-sqlite`（原始日志检索，即我们在用的那套）。
→ **dream 是 meow 独有概念，不存在与 DSH 机制相撞的问题。**

### 2. 会不会干扰人格？——**不会**

- 它是**记忆服务**，不改 `agent.cordis.yml` 的 persona、不改 `AGENTS.md`、不改 `soul/` 目录任何文件。
- 它的 `soul` 层是"关于 AI 自身的记忆条目"，与我们的身份推理链（表/里、时间感知、领地铁律）**不同层**。
- **唯一实际影响 = 上下文变大**：`system-guide.md` 7573 字节进 system prompt（固定文本，其声明 KV 缓存友好）；首轮注入 soul/user/rules 全量。这是 token 成本，不是人格干扰。

### 3. 会不会干扰心跳？——**不会（已查我们的代码）**

风险点是真实的：**dream 会往主会话日志里 `steer` 消息**（其源码注释：「dream 的组消息 steer 进主会话（组消息落主 log）」），而我们有铁律「心跳绝不插进正在进行的对话」。

但我们的反射（`plugins/body-switch/index.js:176-177`）：

```js
if (event.type !== 'user/message') return
if (event.data?.source?.kind !== 'user') return     // 只认真实用户消息
```

meow 的注入是 `{kind:'plugin'}` 来源 → **我们的心跳看不见它们，不会误重置 `lastBeatAt`**。天然隔离，零改动。

**仍待实测的一点**：dream（空闲 3h 触发）与我们的心跳（扑空 10/30/60 分钟档）都在乎"空闲"，**同一时刻会不会互相扰动**（agent 被 dream 拉出 idle 时，心跳 tick 是否少一拍）。

### 4. 工具名会不会撞？——**不会**

它：`memory_remember` / `memory_search` / `memory_project` / …
我们：`memory_search_sessions` / `memory_search_events`
→ 前缀相近但**全名不冲突**，可并存。

### 5. 它和我们的 memory-recall 是什么关系？——**互补，不是替代**

| | 我们（`session-query-sqlite` + `memory-recall`） | meow-memory |
|---|---|---|
| 存什么 | **原始会话日志全文索引**（逐条事件） | **模型蒸馏出的结构化条目** |
| 能答 | 「当时原话是什么」「上下文」 | 「关于 X 我记住了什么」 |
| 写入者 | 系统自动，无遗漏 | LLM 判断是否值得记（**会漏**） |
| 取证能力 | ✅（今晚就是靠日志时间戳定位会话卡死时刻） | ❌ |

→ **蒸馏层不能替代原始层**；两者并存价值最大。

## ⚠️ 一条必须记住的坏建议

它的 `system-guide.md` 第 75-77 行教模型这样搜聊天原文：

```js
node -e "console.log(require('node:zlib').zstdDecompressSync(...).toString())" <文件>
```

**这条是错的**——`zstdDecompressSync` 在 DSH 的多帧 `.jsonl.zstd` 上**只解第一帧**（171 字节的会话头），照它做会"搜了但没有结果"（我们在 2026-09-27 实测过，见 `2026-09-27-收图能力修复.md` 的 zstd 教训）。
→ 若采用 meow，**原始日志取证仍走我们自己的方式**，不要用它的示范命令。

## 采用的前置条件（两条边界）

1. **`.gitignore` 加 `.dsh-meow/`** —— 记忆数据不进库（与 `soul/` 同理）。
2. **接受上下文变大**（guide + 首轮全量注入 + 每轮命中 top-2）。

**回滚极干净**：profile patch 一行 + 一个包目录，摘掉即可，不动我们任何现有文件。

**安装**（README 给的一键方式，需重启 3080 且**新开会话**才加载）：

```powershell
dsh plugin --profile web add github:Phant0Meow/dsh-meow-memory
```

**装上后要验三件事**：① 黑窗有无插件报错（**记住了 9/23 fail-fast 教训：一个插件能拖垮整棵树**）；② `.dsh-meow` 确实没进 git；③ 首轮注入只加它的记忆块、没碰我们的 persona。

## 状态

**调研完成，未采用——老刘"想下再决定"（2026-09-27 夜）。**

## 教训 / 备注

- **"能不能直接用"要能一句话回答**：这次能给出结论，靠的是把"会不会撞"拆成四条可查证的问题（DSH 有没有同名机制 / 碰不碰 persona / 心 ble 反射认不认它的消息 / 工具名撞不撞），而不是泛泛说"可能有风险"。
- 读源码时顺手核对了**它给模型的示范命令**——发现了那条 zstd 错误。**第三方插件的 prompt 也要当代码审**。
