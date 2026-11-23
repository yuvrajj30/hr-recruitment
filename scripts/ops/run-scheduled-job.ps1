# Runs CafeOS housekeeping for Windows Task Scheduler, logs each step to a monthly log file, and tells the user on
# screen when something failed.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\run-scheduled-job.ps1 -Job daily
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\run-scheduled-job.ps1 -Job check
# daily  runs, strictly one after the other (each step runs even if an earlier one failed):
#          1. npm run privacy:retention       removes candidates due under their organisation's retention period,
#                                              deletes their files, retries failed file deletions
#          2. npm run backup:daily            backs up the real database (pg_dump, read-only) and the file store,
#                                              each verified; people removed in step 1 are not in it
#          3. npm run backup:expiry -- --apply deletes backups older than 30 days (the newest verified pair stays)
#          4. npm run backup:status           checks the newest verified backups are less than 26 hours old
# check  only step 4 (run at sign-in, so backups that never ran are noticed too)
# The single steps can also be run on their own: -Job retention | backup | backup-expiry.
# The jobs print only counts and backup file names, never candidate names or emails.
# Logs: %USERPROFILE%\hr-recruitment-logs\<step>-<yyyy-MM>.log; last result: %USERPROFILE%\hr-recruitment-logs\STATUS.txt
param(
  [Parameter(Mandatory = $true)][ValidateSet('daily', 'check', 'retention', 'backup', 'backup-expiry')][string]$Job
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $env:USERPROFILE 'hr-recruitment-logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
Set-Location $project
# The backup script refuses to run when this is already set in the environment (an interactive safety check); the
# scheduled run must always use the value in .env.
Remove-Item Env:MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue

$steps = @{
  'retention' = @('run', 'privacy:retention')
  'backup' = @('run', 'backup:daily')
  'backup-expiry' = @('run', 'backup:expiry', '--', '--apply')
  'check' = @('run', 'backup:status')
}
$order = switch ($Job) {
  'daily' { @('retention', 'backup', 'backup-expiry', 'check') }
  default { @($Job) }
}

function Invoke-Step([string]$name) {
  $log = Join-Path $logDir ("{0}-{1}.log" -f $name, (Get-Date -Format 'yyyy-MM'))
  $started = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  # Windows PowerShell 5.1 turns each stderr line of a native program into an error record; with 'Stop' the first
  # one would end this script before the log is written. Collect everything as text instead, and keep the exit code.
  $code = 1
  $output = ''
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $npmArgs = $steps[$name]
    $output = & npm.cmd @npmArgs 2>&1 | ForEach-Object { "$_" } | Out-String
    $code = $LASTEXITCODE
  } catch {
    $output = "the step could not be started: $($_.Exception.GetType().Name)"
  } finally {
    $ErrorActionPreference = $prev
  }
  # Keep only the step's own lines (drop npm's banner), and never write a connection string.
  $lines = ($output -split "`r?`n") | Where-Object { $_ -and $_ -notmatch '^\s*>' } | ForEach-Object { $_ -replace 'postgres(ql)?://\S+', '<url>' }
  Add-Content -Path $log -Encoding utf8 -Value ("[{0}] {1} exit={2}" -f $started, $name, $code)
  foreach ($l in $lines) { Add-Content -Path $log -Encoding utf8 -Value ("    " + $l) }
  return [pscustomobject]@{ Name = $name; Code = $code; Lines = $lines }
}

$results = foreach ($s in $order) { Invoke-Step $s }
$failed = @($results | Where-Object { $_.Code -ne 0 })
# A failed daily run stays reported until a daily run succeeds: the sign-in check repeats it instead of hiding it.
$dailyStatus = Join-Path $logDir 'STATUS-daily.txt'
if ($Job -eq 'check' -and (Test-Path $dailyStatus) -and ((Get-Content $dailyStatus -Raw) -like 'FAILED*')) {
  $failed += [pscustomobject]@{ Name = 'last daily run'; Code = 1; Lines = @((Get-Content $dailyStatus -Raw).Trim()) }
}
$when = Get-Date -Format 'yyyy-MM-dd HH:mm'
$status = if ($failed.Count -eq 0) { "OK $when ($Job): " + (($results | ForEach-Object { $_.Name }) -join ', ') }
          else { "FAILED $when ($Job): " + (($failed | ForEach-Object { "$($_.Name) (exit $($_.Code))" }) -join ', ') }
Set-Content -Path (Join-Path $logDir "STATUS-$Job.txt") -Encoding utf8 -Value $status
if ($failed.Count -gt 0) {
  # Shown on the signed-in user's screen (the task runs in their session). It closes by itself after an hour.
  # CAFEOS_NO_POPUP=1 (tests) skips it.
  if ($env:CAFEOS_NO_POPUP -eq '1') { exit 1 }
  $detail = ($failed | ForEach-Object { "- $($_.Name): " + (($_.Lines | Select-Object -Last 3) -join ' / ') }) -join "`n"
  try {
    (New-Object -ComObject WScript.Shell).Popup("CafeOS housekeeping needs attention:`n`n$detail`n`nLogs: $logDir", 3600, 'CafeOS', 48) | Out-Null
  } catch { }
  exit 1
}
exit 0
