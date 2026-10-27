---
name: body-switch-deploy
description: 3081 身体（body-switch/nervous-system）的改动与部署流程——改源码→部署副本的特殊纪律：部署文件不在 git、先备份、diff 送住户审、重启归老刘、按设计稿验收。
---

# body-switch 部署纪律（3081 身体）

> 这是 `skills/engineering` 的**部署副本专章**：源码流程照 engineering，**加三段它没有的**——部署文件备份、住户审阅、按设计稿验收。

## 铁律

1. **源码 = `I:\PJ sue\plugins\body-switch\`；部署 = `I:\SUE test\.dsh\profiles\node_modules\@sue\nervous-system\index.js`。两边必须哈希一致**（改源码 → Copy → `Get-FileHash` 比对）。
2. **git 只保护源码。** 部署副本不在 git 里——**每次覆盖部署文件前，先把当前部署文件拷进 `备份/3081-nervous-system-YYYYMMDD\`**（10-27 漏过一次：直接覆盖，被覆盖的中间态只能靠补丁脚本重建）。
3. **部署前住户审阅**（雯）：她的身体她审——把改动要点/diff/设计稿对照送她，**她点头才部署**。她审实现、你审设计，别互相替代。
4. **实例归老刘**：启动/停止/重启 3081 由老刘执行（进程不能挂在我会话下）。我负责拷贝+哈希+日志，他负责开关。
5. **验收依据不是"起来就行"，是设计稿的验收判据**（如 `memory/2026-10-27-设计稿-疲劳注入重构-v0.1.md` §1.8 六条）——逐条过，过了才记完成。

## 流程（顺序固定）

| # | 步 | 谁 | 判定 |
|---|---|---|---|
| 1 | 定案依据 | 姐姐+老刘 | 设计稿/审阅报告在手；验收判据明确 |
| 2 | 备份部署副本 | 姐姐 | `备份\3081-nervous-system-<日期>\` 存在且哈希与部署一致 |
| 3 | 改源码 | 姐姐 | `node --check` 过；旧符号零残留检查 |
| 4 | 住户审阅 | 雯 | 她点头（或提修改）；差量清单/diff 送到她工作区 |
| 5 | 老刘点头 | 老刘 | 代码/配置类改动有他点头 |
| 6 | 拷贝部署 | 姐姐 | `Copy-Item` 后**双侧 SHA256 一致** |
| 7 | 重启 | **老刘** | 黑窗重启；`netstat :3081 LISTENING` 确认 |
| 8 | 验收 | 雯为主、姐姐查文件 | 按设计稿判据逐条；看 `[nervous-system]` 日志 + 身体信号 + 会话原文 |
| 9 | 记账 | 姐姐 | 开发日志 + 快照已知坑/待办 + commit + 池子推送 |

## 快速自检（部署前 30 秒）

```powershell
$src='I:\PJ sue\plugins\body-switch\index.js'
$dst='I:\SUE test\.dsh\profiles\node_modules\@sue\nervous-system\index.js'
$bak='I:\PJ sue\备份\3081-nervous-system-' + (Get-Date -Format 'yyyyMMdd')
# 1) 备份当前部署（第一次改之前做）
New-Item -ItemType Directory -Force -Path $bak | Out-Null; Copy-Item $dst "$bak\index.js" -Force
# 2) 部署
Copy-Item $src $dst -Force
# 3) 哈希锁
(Get-FileHash $src -Algorithm SHA256).Hash -eq (Get-FileHash $dst -Algorithm SHA256).Hash
# 4) 语法
node --check $src
```

## 教训（10-27 实案）

- 部署文件没进 git、也没进 `备份/` 就覆盖了——"内容没丢（在 commit 里）但中间态丢了"。**备份对象是"部署副本本身+其哈希"，不是"源码已经提交"就完事。**
- 心跳/消息注入类改动，部署后必查 v4 会话能不能收（`source.kind` 契约，10-26 实案）。
- 住户审阅不是形式——她抓过 `送达即清` 的复读 bug、`text→prefix` 的措辞坑，都是"实现 vs 设计"的细节。
