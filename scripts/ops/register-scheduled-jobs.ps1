# Creates (or updates) the CafeOS housekeeping tasks in Windows Task Scheduler for the current user:
#   "CafeOS daily housekeeping"   daily 10:00   run-scheduled-job.ps1 -Job daily
#        retention, then the day's backup, then backup expiry, then the freshness check, strictly in that order
#        (so people removed today are not in today's backup, and the steps never run at the same time)
#   "CafeOS backup check"         at sign-in    run-scheduled-job.ps1 -Job check
#        warns on screen when the newest verified backups are over 26 hours old (also when the daily task never ran)
# They run while this user is signed in (no password is stored). If the computer was off or asleep at 10:00, the
# daily task runs as soon as it can. A run that takes over two hours is stopped; a second copy never starts.
# Earlier separate tasks (candidate retention, daily backup, backup expiry) are removed.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\register-scheduled-jobs.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\register-scheduled-jobs.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-scheduled-job.ps1'
$project = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$folder = '\CafeOS\'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$jobs = @(
  @{ Name = 'CafeOS daily housekeeping'; Job = 'daily'; Trigger = (New-ScheduledTaskTrigger -Daily -At '10:00'); Limit = 2 },
  @{ Name = 'CafeOS backup check'; Job = 'check'; Trigger = (New-ScheduledTaskTrigger -AtLogOn -User $user); Limit = 1 }
)
foreach ($old in @('CafeOS candidate retention', 'CafeOS daily backup', 'CafeOS backup expiry')) {
  if (Get-ScheduledTask -TaskPath $folder -TaskName $old -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskPath $folder -TaskName $old -Confirm:$false
    Write-Output "removed earlier task: $old"
  }
}
foreach ($j in $jobs) {
  if ($Remove) {
    Unregister-ScheduledTask -TaskPath $folder -TaskName $j.Name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "removed: $($j.Name)"
    continue
  }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $project `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Job {1}' -f $runner, $j.Job)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours $j.Limit) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskPath $folder -TaskName $j.Name -Action $action -Trigger $j.Trigger -Settings $settings -Principal $principal `
    -Description "CafeOS housekeeping ($($j.Job)). Logs and STATUS.txt: %USERPROFILE%\hr-recruitment-logs" -Force | Out-Null
  Write-Output "registered: $($j.Name)"
}
