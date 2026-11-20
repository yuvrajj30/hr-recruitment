# Runs one CafeOS housekeeping job for Windows Task Scheduler and appends its result to a monthly log file.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\run-scheduled-job.ps1 -Job retention
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\run-scheduled-job.ps1 -Job backup-expiry
# retention      npm run privacy:retention            (removes candidates due under each organisation's retention
#                                                      period, deletes their files, retries failed file deletions)
# backup-expiry  npm run backup:expiry -- --apply     (deletes backups older than 30 days; the newest dump stays)
# The jobs print only counts and backup file names, never candidate names or emails.
# Logs: %USERPROFILE%\hr-recruitment-logs\<job>-<yyyy-MM>.log
param(
  [Parameter(Mandatory = $true)][ValidateSet('retention', 'backup-expiry')][string]$Job
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $env:USERPROFILE 'hr-recruitment-logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ("{0}-{1}.log" -f $Job, (Get-Date -Format 'yyyy-MM'))
$started = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

Set-Location $project
$npmArgs = if ($Job -eq 'retention') { @('run', 'privacy:retention') } else { @('run', 'backup:expiry', '--', '--apply') }
# Windows PowerShell 5.1 turns each stderr line of a native program into an error record; with 'Stop' the first one
# would end this script before the log is written. Collect everything as text instead, and keep the exit code.
$code = 1
$output = ''
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $output = & npm.cmd @npmArgs 2>&1 | ForEach-Object { "$_" } | Out-String
  $code = $LASTEXITCODE
} catch {
  $output = "the job could not be started: $($_.Exception.GetType().Name)"
} finally {
  $ErrorActionPreference = $prev
}
# Keep only the job's own lines (drop npm's banner), and never write a connection string.
$lines = ($output -split "`r?`n") | Where-Object { $_ -and $_ -notmatch '^\s*>' } | ForEach-Object { $_ -replace 'postgres(ql)?://\S+', '<url>' }
Add-Content -Path $log -Encoding utf8 -Value ("[{0}] {1} exit={2}" -f $started, $Job, $code)
foreach ($l in $lines) { Add-Content -Path $log -Encoding utf8 -Value ("    " + $l) }
exit $code
