# Manage Windows prevent-sleep helper (start/stop/status)
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status')]
    [string]$Command = 'status'
)

$DataDir = Join-Path $env:USERPROFILE '.wechat-claude-code'
$PidFile = Join-Path $DataDir 'prevent-sleep.pid'
$Worker = Join-Path $PSScriptRoot 'prevent-sleep-worker.ps1'

function Get-AwakeProcess() {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $raw) { return $null }
    $awakePid = [int]$raw
    $proc = Get-Process -Id $awakePid -ErrorAction SilentlyContinue
    if ($proc) { return $proc }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $null
}

function Start-Awake {
    if (Get-AwakeProcess) {
        Write-Host 'Prevent-sleep already running'
        return
    }
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    $proc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-File', $Worker) `
        -PassThru
    Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
    Write-Host "Prevent-sleep started (PID: $($proc.Id))"
}

function Stop-Awake {
    $proc = Get-AwakeProcess
    if ($proc) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Prevent-sleep stopped (PID: $($proc.Id))"
    } else {
        Write-Host 'Prevent-sleep not running'
    }
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
}

function Show-AwakeStatus {
    $proc = Get-AwakeProcess
    if ($proc) {
        Write-Host "Prevent-sleep: running (PID: $($proc.Id))"
    } else {
        Write-Host 'Prevent-sleep: not running'
    }
}

switch ($Command) {
    'start' { Start-Awake }
    'stop' { Stop-Awake }
    'status' { Show-AwakeStatus }
}
