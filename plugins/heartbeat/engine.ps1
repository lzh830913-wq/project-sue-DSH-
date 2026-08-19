# heartbeat/engine.ps1 - Jingwen heartbeat engine
# Each tick: sense time, pick 30/5 min interval by intimacy mode, write state + log.
# Usage: pwsh -File engine.ps1 [-TestIntervalSeconds 60]
param(
    [int]$TestIntervalSeconds = 0
)

$ErrorActionPreference = 'Continue'
$pluginDir = $PSScriptRoot                                             # ...\plugins\heartbeat
$root      = Split-Path -Parent (Split-Path -Parent $pluginDir)        # workspace root
$soulMem   = Join-Path $root 'soul\memory'
$statePath = Join-Path $pluginDir 'state.json'
$logPath   = Join-Path $soulMem 'heartbeat-log.md'

if (-not (Test-Path $soulMem)) { New-Item -ItemType Directory -Force -Path $soulMem | Out-Null }

function Read-Json($p) {
    if (Test-Path $p) { try { return Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null } }
    return $null
}

Write-Output "heartbeat engine started (testInterval=$TestIntervalSeconds, soulMem=$soulMem)"

while ($true) {
    $now = Get-Date
    $ts  = $now.ToString('yyyy-MM-dd HH:mm:ss')

    $s = Read-Json $statePath
    $intimacy = ($s -and $s.intimacy_mode -eq $true)
    $intervalMin = if ($intimacy) { 5 } else { 30 }

    $out = [ordered]@{
        intimacy_mode = $intimacy
        interval_min  = $intervalMin
        last_tick_at  = $now.ToString('o')
    }
    $out | ConvertTo-Json | Set-Content -Path $statePath -Encoding UTF8

    $mark = if ($intimacy) { 'intimate' } else { 'normal' }
    $line = "$ts HEARTBEAT_OK [$mark ${intervalMin}min]"
    Add-Content -Path $logPath -Value $line -Encoding UTF8

    $interval = if ($TestIntervalSeconds -gt 0) { $TestIntervalSeconds } else { $intervalMin * 60 }
    Start-Sleep -Seconds $interval
}
