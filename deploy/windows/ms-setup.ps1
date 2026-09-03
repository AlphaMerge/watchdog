<#
.SYNOPSIS
    Everything a Windows installation needs after its files are on disk (TASKS.md H-06).
.DESCRIPTION
    The Windows counterpart of deploy/setup.sh, and it exists for the same reason: the MSI and
    the hand-run PowerShell installer both have to register the services, open the firewall,
    place a configuration they must never overwrite, and check it before starting anything.
    Two copies of that would drift, and the one nobody exercises would be the one that is wrong.

        .\ms-setup.ps1 -Components core,probe
        .\ms-setup.ps1 -Components probe -NoStart

    Idempotent by construction, because every installer re-runs it on upgrade: services are
    reconfigured rather than duplicated, firewall rules are replaced by name, and an existing
    configuration file is kept with a timestamped backup beside it.

    **Services are wrapped by WinSW** (ADR-001 Decision 10), which needs WinSW.exe copied beside
    each service definition as ms-core.exe / ms-probe.exe. The MSI ships it; a hand install can
    pass -WinSw.
.NOTES
    Node.js 22 or newer must be on PATH or supplied with -NodeExe. Windows has no equivalent of
    "the distribution ships Node", so the path is explicit rather than assumed.
#>
[CmdletBinding()]
param(
    [string[]] $Components = @('core', 'probe'),
    [string]   $Prefix     = "$env:ProgramFiles\MonitoringSystem",
    [string]   $DataDir    = "$env:ProgramData\MonitoringSystem",
    [string]   $WinSw,
    [string]   $NodeExe,
    [switch]   $NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Die([string] $message) {
    Write-Error "error: $message"
    exit 1
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die 'must run elevated (Run as Administrator)'
}

# Same check, same threshold and same reasoning as the Linux setup: refuse with the version that
# was found rather than starting a service that cannot run.
$node = if ($NodeExe) { $NodeExe } else { (Get-Command node -ErrorAction SilentlyContinue)?.Source }
if (-not $node) { Die 'Node.js is required: install it, or pass -NodeExe C:\path\to\node.exe' }
$nodeMajor = [int] ((& $node -p 'process.versions.node.split(".")[0]') 2>$null)
if ($nodeMajor -lt 22) { Die "Node.js 22 or newer is required (found $(& $node -v))" }

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# **The MSI ships the application as one archive**, because Windows Installer cannot carry
# thirteen thousand components through the toolchain that builds it (`scripts/package-msi.sh`
# says why). Expanding it here rather than at MSI time keeps one place that knows the layout.
# Absent means this is a hand install from an unpacked tree, where the files are already in place.
$archive = Join-Path $Prefix 'app.zip'
if (Test-Path $archive) {
    Write-Host '==> expanding the application'
    foreach ($stale in @('app', 'web', 'bin', 'docs')) {
        $path = Join-Path $Prefix $stale
        # Removed first so an upgrade cannot leave a file the new release deleted — the same
        # reason install.sh clears /opt/ms/app before copying.
        if (Test-Path $path) { Remove-Item -Recurse -Force $path }
    }
    Expand-Archive -Path $archive -DestinationPath $Prefix -Force
}

# --- configuration, which an upgrade must never clobber -----------------------------------
foreach ($svc in $Components) {
    $target = Join-Path $DataDir "$svc.json"
    $example = Join-Path $Prefix "etc\$svc.json"
    if (-not (Test-Path $example)) { continue }

    if (Test-Path $target) {
        # A timestamped copy before anything else touches this directory, and the release's own
        # example beside it to diff against — the same contract H-03 gives on Linux.
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
        Copy-Item -Force $target "$target.$stamp.bak"
        Copy-Item -Force $example "$target.new"
        Write-Host "==> keeping existing $target (backed up, $svc.json.new beside it)"
    }
    else {
        Copy-Item -Force $example $target
        Write-Host "==> installing $target"
    }
}

# --- the firewall, which is the half the hand installer never did --------------------------
#
# **Inbound only, and only what actually listens.** A probe dials *out* to its core and needs no
# inbound rule at all; opening one would be granting reachability nothing uses. The core listens
# twice — the API and web UI, and the probe channel — and the ports come from the configuration
# rather than from constants here, because an operator who moved them would otherwise get rules
# for ports nothing is on and no rule for the ports something is.
if ($Components -contains 'core') {
    $configPath = Join-Path $DataDir 'core.json'
    $apiPort = 8080
    $probePort = 23560
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.api.port) { $apiPort = [int] $config.api.port }
        if ($config.probeEndpoint.port) { $probePort = [int] $config.probeEndpoint.port }
    }

    foreach ($rule in @(
            @{ Name = 'MonitoringSystem API'; Port = $apiPort },
            @{ Name = 'MonitoringSystem probe channel'; Port = $probePort })) {
        # Removed and recreated rather than edited: an upgrade that changed a port would
        # otherwise leave the old rule open, which is a hole nobody opened on purpose.
        Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $rule.Port -Profile Any | Out-Null
        Write-Host "==> firewall: allowed inbound TCP $($rule.Port) ($($rule.Name))"
    }
}

# --- will this configuration load under this build? ----------------------------------------
#
# Before anything is restarted, for the reason H-03 gives: the old service is still running, so a
# renamed or newly required setting is something an operator finds out about while they still
# have a working installation.
if (-not $NoStart) {
    $bad = $false
    foreach ($svc in $Components) {
        $configPath = Join-Path $DataDir "$svc.json"
        if (-not (Test-Path $configPath)) { continue }
        $entry = Join-Path $Prefix "app\$svc\dist\src\main.js"
        $output = & $node $entry config check --config $configPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "==> $configPath is not valid for this build:" -ForegroundColor Red
            $output | ForEach-Object { Write-Host "    $_" }
            $bad = $true
        }
    }
    if ($bad) {
        Die @'
The new application is installed and the services have NOT been restarted, so this host is still
running the previous version. Fix the configuration above, then:

    Start-Service ms-core, ms-probe
'@
    }
}

# --- services ------------------------------------------------------------------------------
foreach ($svc in $Components) {
    # WinSW finds its definition by basename, so ms-core.exe pairs with ms-core.xml. A bare
    # "$svc.exe" would be an executable with no service definition beside it.
    $serviceExe = Join-Path $Prefix "ms-$svc.exe"
    if ($WinSw -and (Test-Path $WinSw)) { Copy-Item -Force $WinSw $serviceExe }

    if (-not (Test-Path $serviceExe)) {
        Write-Warning @"
WinSW.exe is not at $serviceExe, so the $svc service was not registered.
Download it from https://github.com/winsw/winsw/releases, copy it there, then:

    "$serviceExe" install
"@
        continue
    }

    # `install` on an already-registered service updates it in place, which is what an upgrade
    # wants; `Get-Service` first only to decide what to say.
    $existing = Get-Service -Name "ms-$svc" -ErrorAction SilentlyContinue
    & $serviceExe install | Out-Null
    Write-Host "==> $(if ($existing) { 'reconfigured' } else { 'registered' }) service ms-$svc"

    if (-not $NoStart) {
        & $serviceExe restart | Out-Null
        Start-Sleep -Seconds 2
        $service = Get-Service -Name "ms-$svc" -ErrorAction SilentlyContinue
        if (-not $service -or $service.Status -ne 'Running') {
            Die "ms-$svc failed to start; see $DataDir\logs\$svc"
        }
        Write-Host "    ms-${svc}: $($service.Status)"
    }
}
