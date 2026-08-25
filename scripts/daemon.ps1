# wechat-claude-code Windows daemon manager
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
    [string]$Command = 'start'
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $env:USERPROFILE '.wechat-claude-code'
$LogDir = Join-Path $DataDir 'logs'
$PidFile = Join-Path $DataDir 'wechat-claude-code.pid'
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { $NodeExe = 'C:\nvm4w\nodejs\node.exe' }

function Test-BridgeProcess([string]$CmdLine) {
    if ([string]::IsNullOrWhiteSpace($CmdLine)) { return $false }
    return ($CmdLine -match 'dist[/\\]main\.js\s+start')
}

function Get-BridgeProcesses() {
    Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { Test-BridgeProcess $_.CommandLine }
}

function Sync-PidFile {
    $procs = @(Get-BridgeProcesses)
    if ($procs.Count -eq 0) {
        if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
        return
    }
    Set-Content -Path $PidFile -Value $procs[0].ProcessId -Encoding ascii
}

function Stop-Bridge {
    & (Join-Path $PSScriptRoot 'prevent-sleep.ps1') stop | Out-Null
    $procs = @(Get-BridgeProcesses)
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $lockFile = Join-Path $DataDir 'bridge.pid'
    if (Test-Path $lockFile) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
    if ($procs.Count -gt 0) {
        Write-Host "Stopped bridge ($($procs.Count) process(es))"
    } else {
        Write-Host 'Bridge not running'
    }
}

function Start-Bridge {
    Sync-PidFile
    $existing = @(Get-BridgeProcesses)
    if ($existing.Count -gt 0) {
        Write-Host "Already running (PID: $($existing[0].ProcessId))"
        & (Join-Path $PSScriptRoot 'prevent-sleep.ps1') start | Out-Null
        return
    }

    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $stdout = Join-Path $LogDir 'stdout.log'
    $stderr = Join-Path $LogDir 'stderr.log'

    $proc = Start-Process -FilePath $NodeExe `
        -ArgumentList 'dist\main.js', 'start' `
        -WorkingDirectory $ProjectDir `
        -WindowStyle Minimized `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru

    Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
    Start-Sleep -Seconds 2

    Sync-PidFile
    $live = @(Get-BridgeProcesses)
    if ($live.Count -ge 1) {
        $pid = $live[0].ProcessId
        Write-Host "Started wechat-claude-code daemon (PID: $pid)"
        Write-Host "Logs: $LogDir"
        & (Join-Path $PSScriptRoot 'prevent-sleep.ps1') start | Out-Null
    } else {
        Write-Host 'Failed to start. Check stderr.log:'
        if (Test-Path $stderr) { Get-Content $stderr -Tail 20 }
        exit 1
    }
}

function Show-Status {
    Sync-PidFile
    $procs = @(Get-BridgeProcesses)
    if ($procs.Count -eq 0) {
        Write-Host 'Not running'
    } else {
        Write-Host "Running ($($procs.Count) instance(s)):"
        $procs | ForEach-Object { Write-Host "  PID $($_.ProcessId)" }
    }
    & (Join-Path $PSScriptRoot 'prevent-sleep.ps1') status
}

function Show-Logs {
    foreach ($name in @('bridge-*.log', 'stdout.log', 'stderr.log')) {
        $files = Get-ChildItem -Path $LogDir -Filter $name -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
        foreach ($f in ($files | Select-Object -First 1)) {
            Write-Host "=== $($f.Name) ==="
            Get-Content $f.FullName -Tail 30
            Write-Host ''
        }
    }
}

switch ($Command) {
    'start' { Start-Bridge }
    'stop' { Stop-Bridge }
    'restart' { Stop-Bridge; Start-Sleep -Seconds 1; Start-Bridge }
    'status' { Show-Status }
    'logs' { Show-Logs }
}
