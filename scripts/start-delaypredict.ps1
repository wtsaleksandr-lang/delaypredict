# Launches DelayPredict in production mode + ensures the Tailscale Funnel is configured.
# Called by the scheduled task at user logon. Designed to be idempotent.
#
# Logs to: %LOCALAPPDATA%\DelayPredict\start.log

$ErrorActionPreference = "Continue"

$AppRoot   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir    = Join-Path $env:LOCALAPPDATA "DelayPredict"
$LogFile   = Join-Path $LogDir "start.log"
$AppLog    = Join-Path $LogDir "app.log"
$Tailscale = "C:\Program Files\Tailscale\tailscale.exe"
$AppPort   = 5000
$BasePath  = "/delaypredict"

if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

function Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts $msg" | Tee-Object -FilePath $LogFile -Append | Out-Null
}

Log "starting from $AppRoot"

# 1. Make sure no stale instance is bound to our port
$existing = Get-NetTCPConnection -LocalPort $AppPort -ErrorAction SilentlyContinue
if ($existing) {
  $pids = $existing | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) {
    try {
      Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
      Log "killed stale PID $p on port $AppPort"
    } catch {}
  }
  Start-Sleep -Seconds 2
}

# 2. Launch the production server
Push-Location $AppRoot
try {
  Log "spawning: npm run start (logs → $AppLog)"
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = "cmd.exe"
  $startInfo.Arguments = "/c npm run start >> `"$AppLog`" 2>&1"
  $startInfo.WorkingDirectory = $AppRoot
  $startInfo.WindowStyle = "Hidden"
  $startInfo.CreateNoWindow = $true
  $startInfo.UseShellExecute = $false
  [System.Diagnostics.Process]::Start($startInfo) | Out-Null
} catch {
  Log "failed to spawn: $_"
} finally {
  Pop-Location
}

# 3. Tailscale: ensure path-based funnel is in place under /delaypredict/
if (Test-Path $Tailscale) {
  try {
    & $Tailscale serve --bg --https=443 --set-path=$BasePath/ "http://localhost:$AppPort" 2>&1 | Out-Null
    & $Tailscale funnel --bg --https=443 "$BasePath/" 2>&1 | Out-Null
    Log "tailscale serve+funnel for $BasePath/ → :$AppPort configured"
  } catch {
    Log "tailscale config failed: $_"
  }
} else {
  Log "tailscale not installed at $Tailscale"
}

Log "done"
