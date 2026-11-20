# Creates (or updates) the two daily CafeOS housekeeping tasks in Windows Task Scheduler for the current user:
#   "CafeOS candidate retention"  daily 10:00   scripts\ops\run-scheduled-job.ps1 -Job retention
#   "CafeOS backup expiry"        daily 10:15   scripts\ops\run-scheduled-job.ps1 -Job backup-expiry
# They run while this user is signed in (no password is stored). If the computer was off or asleep at that time,
# the task runs as soon as it can. A run that takes over an hour is stopped; a second copy never starts.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\register-scheduled-jobs.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\register-scheduled-jobs.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-scheduled-job.ps1'
$project = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$folder = '\CafeOS\'
$jobs = @(
  @{ Name = 'CafeOS candidate retention'; Job = 'retention'; At = '10:00' },
  @{ Name = 'CafeOS backup expiry'; Job = 'backup-expiry'; At = '10:15' }
)
foreach ($j in $jobs) {
  if ($Remove) {
    Unregister-ScheduledTask -TaskPath $folder -TaskName $j.Name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "removed: $($j.Name)"
    continue
  }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $project `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Job {1}' -f $runner, $j.Job)
  $trigger = New-ScheduledTaskTrigger -Daily -At $j.At
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskPath $folder -TaskName $j.Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "CafeOS housekeeping ($($j.Job)). Logs: %USERPROFILE%\hr-recruitment-logs" -Force | Out-Null
  Write-Output "registered: $($j.Name) daily at $($j.At)"
}
