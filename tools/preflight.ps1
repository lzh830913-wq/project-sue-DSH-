# preflight.ps1 -- pre-restart self-check (2026-11-20)
# Usage: run before restarting DSH; only restart when all green.
# Origin: 11-20 incident -- patch referenced @sue/dev-reflex but the package
#         was in the wrong node_modules location; after restart the whole
#         profile failed to mount ("never started"). The patient on the
#         operating table cannot take their own pulse. This script is the
#         "can you see whether it will start" action.
# NOTE: keep this file pure ASCII (engineering rule 10).

$ErrorActionPreference = 'Stop'
$patch = 'C:\Users\lzh_6\.dsh\profiles\web\cordis.patch.yml'
$pkgRoot = 'C:\Users\lzh_6\.dsh\profiles\node_modules\@sue'
$srcRoot = 'I:\PJ sue\plugins'

if (-not (Test-Path $patch)) { Write-Host "[FAIL] patch not found: $patch"; exit 1 }

$names = Select-String -Path $patch -Pattern "'@sue/([a-z0-9-]+)'" -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
  Sort-Object -Unique

if (-not $names) { Write-Host '[WARN] no @sue package rows in patch'; exit 0 }

$fail = 0
foreach ($n in $names) {
  $dir = Join-Path $pkgRoot $n
  if (-not (Test-Path $dir)) {
    Write-Host "[FAIL] $n not in $pkgRoot (patch has the name, disk has no thing)"
    $fail++
    continue
  }
  $pj = Join-Path $dir 'package.json'
  if (-not (Test-Path $pj)) { Write-Host "[FAIL] $n missing package.json"; $fail++; continue }
  $main = (Get-Content $pj -Raw -Encoding UTF8 | ConvertFrom-Json).main
  if ($main -and -not (Test-Path (Join-Path $dir $main))) {
    Write-Host "[FAIL] $n entry $main missing"; $fail++; continue
  }
  $srcIdx = Join-Path $srcRoot "$n\index.js"
  $dstIdx = Join-Path $dir 'index.js'
  if ((Test-Path $srcIdx) -and (Test-Path $dstIdx)) {
    $same = (Get-FileHash $srcIdx).Hash -eq (Get-FileHash $dstIdx).Hash
    if (-not $same) { Write-Host "[WARN] $n deploy copy differs from source (copy first, then restart)"; $fail++; continue }
  }
  Write-Host "[OK] $n"
}

if ($fail -gt 0) { Write-Host ""; Write-Host "$fail problem(s) -- fix before restart."; exit 1 }
Write-Host ""; Write-Host "ALL GREEN. Safe to restart."
