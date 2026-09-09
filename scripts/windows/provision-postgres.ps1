<#
.SYNOPSIS
  Prepares PostgreSQL with TimescaleDB on Windows — the operator's prerequisite (`S-11`).

.DESCRIPTION
  The Windows counterpart of `scripts/smoke/provision-postgres.sh`, and it exists for the same
  reason that one does: the installer sets up MonitoringSystem, and the documentation tells an
  operator to have PostgreSQL ready first. `S-11` is the ticket that asks whether that is even
  possible on Windows, and the half nobody could answer was whether TimescaleDB's `setup.exe`
  composes with a PostgreSQL somebody installed themselves.

  **This script has never been run.** Nothing in this repository can run it: the toolchain is a
  Linux container, PowerShell publishes no arm64 image, and the one job that could — CI's
  `windows-latest` runner — is switched off. `P-53` parse-checks it in the ordinary test suite,
  and a parse check is not a run. Until CI goes green, treat every step here as a proposal.

  **What is evidence rather than guesswork.** `setup.exe` is a Go program, and its own strings
  give its interface: `-pgconfig` ("Path to pg_config binary"), `-quiet`, `-no-tune` and the
  `-tune-*` trio, with "ERROR: path to pg_config cannot be empty" when it is not told. It copies
  the extension to `pg_config --pkglibdir` and `--sharedir` — asked of *that server's* own
  `pg_config` rather than assumed — which is why pointing it at the right binary is the whole of
  making it land where a running server looks. See
  `docs/findings/2026-09-03-timescaledb-on-windows.md`.

  **What is still assumption.** That the service is named `postgresql*`, that a restart is enough
  for `shared_preload_libraries` to take, and that the account running this can write
  `postgresql.conf`. Each is discovered rather than hardcoded, and each failure says which one it
  was, because the first run is where those get settled.

.PARAMETER PgConfig
  Path to `pg_config.exe`. Discovered from PATH, then from the installed service, when omitted.

.PARAMETER TimescaleVersion
  The TimescaleDB release to install. Pinned rather than "latest": an installation whose
  extension version changes because somebody cut a release is not reproducible.

.PARAMETER Database
  The database to create and enable the extension in.

.PARAMETER Role
  The login role to create for it.
#>
[CmdletBinding()]
param(
  [string] $PgConfig = '',
  [string] $TimescaleVersion = '2.30.0',
  [string] $Database = 'monitoring',
  [string] $Role = 'monitoring',
  [string] $RolePassword = 'monitoring'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Message) Write-Host "==> $Message" }

# --- 1. Find the server we are extending -------------------------------------------------------
# `pg_config` is the whole interface `setup.exe` wants, and it is also how every path below is
# discovered. Refusing to guess is deliberate: a wrong `pg_config` installs the extension into a
# PostgreSQL that nothing is running, which looks exactly like a successful install.
if ($PgConfig -eq '') {
  $onPath = Get-Command pg_config.exe -ErrorAction SilentlyContinue
  if ($null -ne $onPath) {
    $PgConfig = $onPath.Source
  }
  else {
    # The service's image path names the binary directory, which is where `pg_config.exe` lives.
    $service = Get-CimInstance Win32_Service -Filter "Name LIKE 'postgresql%'" |
      Select-Object -First 1
    if ($null -eq $service) {
      throw 'no pg_config.exe on PATH and no postgresql* service — install PostgreSQL first'
    }
    $binDir = Split-Path -Parent ($service.PathName -replace '^"([^"]+)".*$', '$1')
    $PgConfig = Join-Path $binDir 'pg_config.exe'
  }
}
if (-not (Test-Path $PgConfig)) { throw "pg_config not found at $PgConfig" }
Write-Step "using pg_config at $PgConfig"

$binDir = Split-Path -Parent $PgConfig
$versionLine = & $PgConfig --version                    # e.g. "PostgreSQL 17.4"
if ($versionLine -notmatch 'PostgreSQL\s+(\d+)') { throw "could not read a major version from '$versionLine'" }
$major = $Matches[1]
Write-Step "PostgreSQL major version $major"

# --- 2. Fetch the extension for exactly that major version -------------------------------------
# **The asset is per major version and the set changes.** PostgreSQL 15 had a Windows build
# through 2.28.3 and none since 2.29.0, so an installation on an unsupported major has to be told
# that in a sentence rather than by a 404 in the middle of an install (`S-11`).
$asset = "timescaledb-postgresql-$major-windows-amd64.zip"
$url = "https://github.com/timescale/timescaledb/releases/download/$TimescaleVersion/$asset"
$work = Join-Path $env:TEMP "timescaledb-$TimescaleVersion-pg$major"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Path $work | Out-Null
$zip = Join-Path $work $asset

Write-Step "downloading $asset"
try {
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
}
catch {
  throw ("TimescaleDB $TimescaleVersion publishes no Windows build for PostgreSQL $major " +
    "($url). Install a major version it does publish, or pin a release that covers this one.")
}
Expand-Archive -Path $zip -DestinationPath $work -Force

$setup = Get-ChildItem -Path $work -Recurse -Filter setup.exe | Select-Object -First 1
if ($null -eq $setup) { throw "no setup.exe in $asset" }

# --- 3. Install it beside that server ----------------------------------------------------------
# `-quiet` answers the prompts; `-no-tune` skips `timescaledb-tune.exe`, because tuning a server
# is the operator's decision and a provisioning script that rewrites somebody's memory settings
# without being asked is a bad neighbour. The conf edit below is the minimum this product needs.
Write-Step 'running setup.exe'
& $setup.FullName -pgconfig $PgConfig -quiet -no-tune
if ($LASTEXITCODE -ne 0) { throw "setup.exe exited $LASTEXITCODE" }

# --- 4. Preload it, and accept the licence it needs --------------------------------------------
# Exactly what migration 004's own error message tells an operator to do, and the same two lines
# the Linux provisioner writes. `timescaledb.license = timescale` is not optional here: native
# compression is Timescale Community rather than Apache, and 004 refuses to apply without it
# (`CLAUDE.md`, ADR-001 Decision 4).
$psql = Join-Path $binDir 'psql.exe'
$confFile = (& $psql -U postgres -tAc 'SHOW config_file').Trim()
if ([string]::IsNullOrWhiteSpace($confFile)) { throw 'could not ask the server for its config_file' }
Write-Step "editing $confFile"

$conf = Get-Content -Path $confFile -Raw
if ($conf -notmatch "(?m)^\s*shared_preload_libraries\s*=.*timescaledb") {
  Add-Content -Path $confFile -Value "shared_preload_libraries = 'timescaledb'"
}
if ($conf -notmatch "(?m)^\s*timescaledb\.license\s*=") {
  Add-Content -Path $confFile -Value "timescaledb.license = 'timescale'"
}

# --- 5. Restart, and wait for it to mean something ---------------------------------------------
$service = Get-Service -Name 'postgresql*' | Select-Object -First 1
if ($null -eq $service) { throw 'no postgresql* service to restart' }
Write-Step "restarting $($service.Name)"
Restart-Service -Name $service.Name -Force

$isReady = Join-Path $binDir 'pg_isready.exe'
$ready = $false
foreach ($attempt in 1..30) {
  & $isReady -q
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'postgres did not become ready after the restart' }

# --- 6. The role and the database ---------------------------------------------------------------
# Idempotent in the same shape as the Linux script: this runs again on an upgrade, and a
# provisioning step that fails the second time is a provisioning step nobody dares re-run.
function Invoke-Sql { param([string] $Sql, [string] $Db = 'postgres')
  $out = & $psql -U postgres -d $Db -tAc $Sql
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $Sql" }
  return ($out | Out-String).Trim()
}

if ((Invoke-Sql "SELECT 1 FROM pg_roles WHERE rolname = '$Role'") -ne '1') {
  Invoke-Sql "CREATE ROLE $Role LOGIN PASSWORD '$RolePassword'" | Out-Null
}
if ((Invoke-Sql "SELECT 1 FROM pg_database WHERE datname = '$Database'") -ne '1') {
  Invoke-Sql "CREATE DATABASE $Database OWNER $Role" | Out-Null
}
Invoke-Sql 'CREATE EXTENSION IF NOT EXISTS timescaledb' $Database | Out-Null

$installed = Invoke-Sql "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'" $Database
Write-Host "postgres ready with timescaledb $installed"
