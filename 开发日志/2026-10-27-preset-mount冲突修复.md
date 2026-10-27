# 开发日志 · 2026-10-27（jingwen-dev 预设选择失败修复）

> 一句话定位：**事故修复 + 根因定位**——「静雯开发模式」在选择器里选中后自动跳回，根因是 `tool-cordis` 的进程级 Inspect Provider 注册与默认 `cordis` 预设互斥；去掉该行即修复。

## 一句话

**同一进程只能有一个含 `@deepseek-ai/dsh-tool-cordis` 的预设活着**——`cordisInspect` 注册表是进程级单例、provider id 固定，默认 `cordis` 预设已占位；`jingwen-dev` 再挂就报 `Host Cordis inspect provider "Service" is already registered`，会话创建回滚（UI 表现为选中后「跳回」）。把 `jingwen-dev` 的 `tool-cordis` 行禁用后 mount 成功。

## 背景（为什么这么做）

- 老刘 10-27 新开会话，想选「静雯开发模式」（`jingwen-dev` preset，cordis 全能力 + time-context），发现选中后**自动跳掉**，其它模式（standard/code/minimal/cordis）都能选。
- 旁证：这一页会话（3080）实际跑在 `cordis` 上——**没有时间感知注入**，因为 time-context 只挂在 `jingwen-dev` 里。
- 该 preset 是 8 月末建好的旧拷贝：`C:\Users\lzh_6\.dsh\.agent-presets\jingwen-dev\agent.cordis.yml`（带 UTF-8 BOM、`enableRunInBackground` 旧写法、比当前 shipped cordis 多 time-context 段），从建好到现在从未成功挂载过。

## 根因（怎么定位到的）

1. **排除 discovery 层**：用 Node 直接调 `@deepseek-ai/dsh-agent-presets` 的 `scanRoot`/`discoverPresets` 跑健康检查（脚本 `.tmp-preset-check.mjs`）——`jingwen-dev` 不在 broken 列表，shape 检查通过。说明问题不在「文件解析」而在「实际 mount」。
2. **拿运行时真话**：临时定义一个 Host 动态插件（`pdiag-1/pkg-1`）注册 `preset_diag` 工具，直接调运行中的 `ctx.get('agentPresets').standingKeyFor('jingwen-dev')`——这是与「新会话创建」同一条 mount 路径。返回：
   ```
   failed to mount: failed to apply loader entry tool-cordis (@deepseek-ai/dsh-tool-cordis):
   Host Cordis inspect provider "Service" is already registered
   ```
3. **读源码确认机制**：`@deepseek-ai/dsh-cordis-host-runner/lib/types/inspect-registry.js`——`CordisInspectRegistryService extends Service`（`super(ctx, 'cordisInspect')`，注释明说 process-global），`register()` 按 manifest.id 去重；`@deepseek-ai/dsh-tool-cordis/lib/index.js:7080` 在 `apply` 里无条件注册 4 个固定 id 的 Host provider（`for (const provider of hostInspectProviders(ctx)) ctx.effect(() => ctx.cordisInspect.register(provider))`），**没有配置开关**。
4. 结论：`agentPresets` 的「行发布 root 服务」校验管不到这里——冲突发生在进程级 Inspect 注册表，与 preset scope 无关。

## 改动 / 机制

**文件**：`C:\Users\lzh_6\.dsh\.agent-presets\jingwen-dev\agent.cordis.yml`

- `- id: tool-cordis` 行加 `disabled: true`（loader 跳过该行、不 import、不 apply），并写清注释原因与替代路径。
- 其余行全部保留：`time-context`（`timeZone: Asia/Shanghai`）是本次目标能力，仍生效。
- `preset.yml` 描述同步改准：不再说「cordis 全部能力」，改为「常工具全家桶 + time-context，不含自指 Cordis 工具」。

**为什么是这个改法**：进程里必须保留 `cordis` 预设（它是默认、是运行本会话的 preset）；两个含 tool-cordis 的预设不可能共存，所以只能有一方砍掉这一行。砍 jingwen-dev 的一方代价最小——开发模式靠常规 coding 工具干活，动态插件工具要用时开 cordis 会话即可。

## 怎么验的

- `preset_diag action=mount presetId=jingwen-dev` → `{ ok: true, mountKey: 'jingwen-dev' }`（修复前同一调用报上面那条 already registered）。
- **不需要重启 3080 进程**：discovery 每次调用重读文件；`ensureStanding` 按 composition stamp（mtime+size）判断——文件改了，下一次会话创建会重新 mount。已在运行中的会话不受影响。
- 待老刘实机验：3080 新建会话 → 选「静雯开发模式」→ 应能正常进入，且该会话每轮带时间上下文。

## 文件清单

- 改动：`C:\Users\lzh_6\.dsh\.agent-presets\jingwen-dev\agent.cordis.yml`（tool-cordis → disabled）、`...\preset.yml`（描述）
- 备份：`I:\PJ sue\备份\jingwen-dev-preset-20261027\`（改前原样两份）
- 诊断件：`.tmp-preset-check.mjs`（临时，验证后删除）；动态插件 `pdiag-1`（诊断完 stop）

## 生效时机 / 边界

- **改 preset 必须新开会话才生效**（老规矩）；本次连「新开会话」都去掉了——因为 mount 是在会话创建时按 stamp 重挂。
- 本修复**不触碰** 3081 的 `.dsh`（那在 0.2.1-rc.2 上，两实例互不影响）。
- 若以后 3080 升级到 0.2.1：`dsh-cordis-host-runner` 的 Inspect registry 仍为进程级，**同样冲突预期存在**，届时需再次确认 tool-cordis 行保持禁用。
- 302 级注意：这个 preset 的 `agent.cordis.yml` 是旧版 shipped cordis 的拷贝，`backgroundMode: one-shot` vs `enableRunInBackground: false` 等差异暂不影响（都在 disabled 行上），升级 0.2.1 时建议整份重建。

## 教训

1. **「选择器里能选」≠「能挂上」**：preset 的 discovery 健康检查（shape）不覆盖实际 mount；真话只能在运行时 `standingKeyFor`/`mount` 里拿。
2. **进程级单例是预设隔离的盲区**：`ctx.cordisInspect` 不是 service scope 的东西，两个 preset 都想注册同名 provider 就必炸；以后加「cordis 的变体 preset」先检查有没有进程级注册。
3. **UI 吞错**：mount 失败时会话创建回滚、选择器跳回，界面上看不到原因——这种事以后先查 Host 侧日志/工具，别在 UI 上反复试。
