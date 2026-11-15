# Stops the processes recorded by start-local.ps1.
$root = Split-Path -Parent $PSScriptRoot
$pids = Join-Path $root '.intake-data/local.pids'
if (Test-Path $pids) {
  foreach ($l in Get-Content $pids) { $id = ($l -split '=')[1]; if ($id) { taskkill /PID $id /T /F | Out-Null; Write-Host "stopped $l" } }
  Remove-Item $pids
} else { Write-Host 'nothing recorded' }
