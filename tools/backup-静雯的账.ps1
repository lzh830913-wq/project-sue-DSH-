# backup-静雯的账.ps1 —— 3080 每日跨盘备份（2026-11-13 立，范式学 3081 的 memory/tools/backup-我的账.ps1）
#
# 定位（她的话原样适用）：git 治"改坏了能回滚"，robocopy 治"盘坏了还有一份"。
# 3080 精简版：一天一次独立快照目录（~18MB）+ 滚动保留 14 份。
#
# 备份包含：soul/（日记+MEMORY.md，git 外的记忆层）、memory/（rofm 归档+心跳状态）、
#           全部源码/skills/日志、.git（回滚能力本身）
# 排除：    备份\（273MB 本地备份，不搬运"备份的备份"）、.dsh*（运行时，升级可再生）
# 计划任务：每天 12:40（错开 3081 的 12:20，避免同时 IO）

$ErrorActionPreference = 'Stop'
$src = 'I:\PJ sue'
$dstRoot = 'G:\苏静雯3080\我的账备份'
$keep = 14
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$dst = Join-Path $dstRoot $stamp
$log = Join-Path $dstRoot "backup-$stamp.log"

New-Item -ItemType Directory -Path $dst -Force | Out-Null

robocopy $src $dst /E /R:2 /W:5 /NFL /NDL /NP /XD '备份' '.dsh-wen-dev' > $log

# robocopy 退出码 <8 都算成功（0=全拷 1=有拷贝 2=有多余）
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE（详见 $log）" }

# 滚动清理：只留最近 $keep 份快照目录
Get-ChildItem $dstRoot -Directory |
  Where-Object { $_.Name -match '^\d{8}-\d{4}$' } |
  Sort-Object Name -Descending |
  Select-Object -Skip $keep |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

"Copied at $stamp, robocopy code $LASTEXITCODE, kept $keep snapshots" >> $log
exit 0
