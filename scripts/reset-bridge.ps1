# Reset wechat-claude-code bridge (keeps config.json)
param(
    [switch]$KeepLogs
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $env:USERPROFILE '.wechat-claude-code'
$BackupDir = Join-Path $DataDir ("backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))

Write-Host '=== WeChat bridge reset ===' -ForegroundColor Cyan

& (Join-Path $ProjectDir 'scripts\daemon.ps1') stop 2>$null

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$toBackup = @('accounts', 'sessions', 'msg-dedup', 'pending-queue', 'get_updates_buf', 'bridge.pid', 'wechat-claude-code.pid')
if (-not $KeepLogs) { $toBackup += 'logs' }
foreach ($name in $toBackup) {
    $src = Join-Path $DataDir $name
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $BackupDir $name) -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Get-ChildItem $DataDir -Filter 'get_updates_buf_*' -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $BackupDir $_.Name) -Force
}

$configPath = Join-Path $DataDir 'config.json'
$savedConfig = $null
if (Test-Path $configPath) {
    $savedConfig = Get-Content $configPath -Raw -Encoding UTF8
}

Remove-Item (Join-Path $DataDir 'accounts\*') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DataDir 'sessions\*') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DataDir 'msg-dedup\*') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DataDir 'pending-queue\*') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DataDir 'get_updates_buf') -Force -ErrorAction SilentlyContinue
Get-ChildItem $DataDir -Filter 'get_updates_buf_*' -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item (Join-Path $DataDir 'bridge.pid') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DataDir 'wechat-claude-code.pid') -Force -ErrorAction SilentlyContinue
if (-not $KeepLogs) {
    Remove-Item (Join-Path $DataDir 'logs\*') -Force -ErrorAction SilentlyContinue
}

if ($savedConfig) {
    [System.IO.File]::WriteAllText($configPath, $savedConfig)
} else {
    $default = '{"workingDirectory":"D:\\pmp-athena","pythonBin":"D:/miniconda/python.exe"}'
    [System.IO.File]::WriteAllText($configPath, $default)
}

Write-Host "Backup: $BackupDir" -ForegroundColor Green
Write-Host 'Local bind data cleared. config.json kept.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Yellow
Write-Host '  cd C:\Users\gwhea\.claude\skills\wechat-claude-code'
Write-Host '  npm run setup'
Write-Host '  npm run daemon -- start'
Write-Host '  Send: menu in the NEW WeChat chat'
