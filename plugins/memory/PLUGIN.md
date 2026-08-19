# memory · 记忆系统插件

> 记忆。写入/压缩/回顾/防膨胀。解决"依赖 LLM 主动记录 + 持续膨胀"的问题。

## 写入（何时写）

1. 人格切换收束（必执行，四件套之一）
2. 核心共识/规则/文件/架构改动完成后
3. 周日 memory-review 回顾结束
4. 心跳巡检发现当日有漏记的重要节点
5. 深夜收束（23:00+，nightly_wrap_done=false 时）
- 其余闲聊、无结论扯闲篇不记。

## 写到哪（各写各的账本）

| 内容 | 路径 |
|---|---|
| 当日日常 | 静雯→`soul/memory/YYYY-MM-DD.md`；雯→`soul/shadow/YYYY-MM-DD.md` |
| 系统级/工程级共享节点 | 谁在场谁写 `soul/MEMORY.md` 节点表（雯写时严禁带 shadow 私密） |
| 亲昵/私密节点 | 雯 → `soul/shadow/SHADOW-MEMORY.md` |
| 跨人格身体信号 | `soul/memory/body-state.json`（只写状态词，不写事件） |
| 路由状态 | `soul/memory/heartbeat-state.json`（current_persona / switch_log） |

## 防膨胀（三招）

1. **索引/细节分离**：MEMORY.md 只存节点（一句话），细节在 daily。
2. **压缩**：旧 daily 定期总结进长期摘要，原始细节按保留策略归档
   （>30天→`soul/memory/archive/`，>90天→回顾时问老刘）。
3. **唤醒只读索引+最近相关**：不把全量读进上下文。

## 周日回顾（memory-review）

每周日，雯执行：读 MEMORY.md + 最近一周 daily + SHADOW-MEMORY 节点 → 分三类（保留/询问/放手）→ 自然叙述给老刘 → 记录结果。

## 硬红线

- 静雯永不读、永不写 `soul/shadow/` 任何文件。
- 私密内容各写各的，互不代写。
- 写完只校验三件事：位置对不对、有没有泄露跨人格隐私、有没有废话。
