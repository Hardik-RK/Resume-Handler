# Starts the mock CRM and the local server (real model, FAKE Drive, mock CRM sink) as background processes.
# Reads .env.local (create it with scripts/make-env-local.ps1). Stop with scripts/stop-local.ps1.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.local'
if (-not (Test-Path $envFile)) { throw '.env.local missing: run scripts/make-env-local.ps1 first' }
foreach ($line in Get-Content $envFile -Encoding UTF8) {
  if ($line -match '^\s*#' -or $line -notmatch '^([A-Z0-9_]+)=(.*)$') { continue }
  Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
}
foreach ($v in 'INTAKE_DATA_DIR', 'INTAKE_CONFIG_DIR', 'MOCK_CRM_DATA_DIR') {
  Set-Item -Path "env:$v" -Value ([IO.Path]::GetFullPath((Join-Path $root (Get-Item "env:$v").Value)))
}
$logs = Join-Path $root '.intake-data/local-logs'; New-Item -ItemType Directory -Force $logs | Out-Null
$pids = Join-Path $root '.intake-data/local.pids'
if (Test-Path $pids) { & (Join-Path $PSScriptRoot 'stop-local.ps1') }
if (-not (Test-Path (Join-Path $root 'packages/web/dist/index.html'))) { Push-Location $root; npm run build; Pop-Location }
$tsx = Join-Path $root 'packages/cli/node_modules/tsx/dist/cli.mjs'
function Launch($name, $cwd, $script) {
  $p = Start-Process node -ArgumentList "`"$tsx`"", "`"$script`"" -WorkingDirectory $cwd -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs "$name.out.log") -RedirectStandardError (Join-Path $logs "$name.err.log")
  "$name=$($p.Id)" | Add-Content $pids
}
Launch 'mock-crm' (Join-Path $root 'packages/mock-crm') (Join-Path $root 'packages/mock-crm/src/server.ts')
foreach ($i in 1..40) { try { Invoke-WebRequest "http://127.0.0.1:$env:MOCK_CRM_PORT/" -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
Launch 'server' (Join-Path $root 'packages/cli') (Join-Path $root 'packages/cli/src/local-run.ts')
foreach ($i in 1..60) { try { Invoke-WebRequest "http://127.0.0.1:$env:INTAKE_PORT/hello" -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
Write-Host "Page:     http://127.0.0.1:$env:INTAKE_PORT/#token=$env:INTAKE_TOKEN   (token is in .env.local as INTAKE_TOKEN)"
Write-Host "Mock CRM: http://127.0.0.1:$env:MOCK_CRM_PORT/"
Write-Host "Samples:  $(Join-Path $root 'sample-resumes')  (drop the zip or the files in resumes/)"
Write-Host "Logs:     $logs   Stop: scripts/stop-local.ps1"
