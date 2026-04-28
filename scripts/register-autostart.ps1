# One-time installer: registers a Windows Scheduled Task that launches
# DelayPredict at user logon. Run this once (no admin required) — task runs
# under your own user account.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/register-autostart.ps1
#
# To remove later:
#   Unregister-ScheduledTask -TaskName "DelayPredict" -Confirm:$false

$ErrorActionPreference = "Stop"

$TaskName  = "DelayPredict"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher  = Join-Path $ScriptDir "start-delaypredict.ps1"

if (!(Test-Path $Launcher)) {
  throw "Launcher not found at $Launcher"
}

# Build the task
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Register (overwrite if it exists)
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Auto-start DelayPredict + Tailscale funnel at logon" `
  -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName'."
Write-Host "It will run at next logon. To run it now without rebooting:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host ""
Write-Host "To unregister later:"
Write-Host "  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
