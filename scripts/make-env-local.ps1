# Builds .env.local (gitignored) for scripts/start-local.ps1: a local server on 127.0.0.1 with your own model key, a fake
# Drive and the mock downstream system. The key is taken from $env:INTAKE_OPENROUTER_API_KEY if set, otherwise asked for
# (hidden input). Prints names only, never values. Existing file is kept unless -Force.
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root '.env.local'
if ((Test-Path $out) -and -not $Force) { Write-Host '.env.local exists (use -Force to rebuild).'; exit 0 }
$key = $env:INTAKE_OPENROUTER_API_KEY
if (-not $key) {
  $sec = Read-Host 'Model API key (hidden)' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $key) { throw 'No model API key given.' }
function Rand($n) { -join ((1..$n) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
$lines = @(
  '# Local hand-testing config. GITIGNORED. Contains a real model key: never commit, paste or screenshot.',
  'INTAKE_AUTH=token',
  "INTAKE_TOKEN=local-$(Rand 16)",
  'INTAKE_HOST=127.0.0.1',
  'INTAKE_PORT=47851',
  'INTAKE_DATA_DIR=./.intake-data/local',
  'INTAKE_CONFIG_DIR=./.intake-data/local-config',
  "INTAKE_SECRETS_KEY=$(Rand 32)",
  "INTAKE_OPENROUTER_API_KEY=$key",
  'MOCK_CRM_PORT=47901',
  'MOCK_CRM_DATA_DIR=./.intake-data/mock-crm',
  "MOCK_CRM_INGESTION_TOKEN=mock-$(Rand 16)"
)
[IO.File]::WriteAllLines($out, $lines, (New-Object Text.UTF8Encoding $false))
Write-Host "Wrote .env.local with names: $((($lines | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object { ($_ -split '=')[0] }) -join ', '))"
Write-Host ("Model key: set, ends ..." + $key.Substring([Math]::Max(0, $key.Length - 4)))
