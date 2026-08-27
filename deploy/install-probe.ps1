<#
.SYNOPSIS
    MonitoringSystem remote probe installer for Windows (TASKS.md R-07).

.DESCRIPTION
    Run from inside an unpacked probe-only package, in an elevated PowerShell:

        .\install-probe.ps1 -Enrolment web-dc2.enrol
        .\install-probe.ps1 -Enrolment web-dc2.enrol -Name web-dc2 -NoStart

    The bundle comes from the core host, which is where the probe-channel CA lives:

        sudo /opt/ms/bin/ms-enrol web-dc2 --out web-dc2.enrol

    The service is wrapped by WinSW (ADR-001 Decision 10), which needs WinSW.exe copied
    beside the shipped ms-probe.xml as ms-probe.exe. Point -WinSw at a downloaded copy and
    this script does that; supply nothing and it will say so rather than guess.

    Re-running upgrades in place: the configuration under ProgramData is never overwritten,
    and an enrolment already on disk is kept unless a new bundle is given.

.NOTES
    Node.js 22 or newer must be on PATH, or supplied with -NodeExe. Unlike the Linux package
    there is no system package manager assumption here — Windows has no equivalent of "the
    distribution ships Node", so the path is explicit.
#>
[CmdletBinding()]
param(
    [string] $Enrolment,
    [string] $Name,
    [string] $Prefix   = "$env:ProgramFiles\MonitoringSystem",
    [string] $DataDir  = "$env:ProgramData\MonitoringSystem",
    [string] $WinSw,
    [string] $NodeExe,
    [switch] $NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Die([string] $message) {
    Write-Error "error: $message"
    exit 1
}

# --- prerequisites ---------------------------------------------------------------------------

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die 'must run in an elevated PowerShell (Run as Administrator)'
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content (Join-Path $here 'VERSION') -Raw).Trim()

if (-not $NodeExe) {
    $found = Get-Command node -ErrorAction SilentlyContinue
    if (-not $found) { Die 'Node.js is required: install it, or pass -NodeExe C:\path\to\node.exe' }
    $NodeExe = $found.Source
}
if (-not (Test-Path $NodeExe)) { Die "no node.exe at $NodeExe" }

$nodeMajor = [int] (& $NodeExe -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 22) { Die "Node.js 22 or newer is required (found $(& $NodeExe -v))" }

# --- the enrolment is checked before anything is written ---------------------------------------
# A bundle that turns out to be unreadable halfway through would otherwise leave a half-installed
# service pointing at a CA that is not there, which starts, fails to connect, and reports a TLS
# error rather than the truth.

$configPath = Join-Path $DataDir 'probe.json'

if ($Enrolment) {
    if (-not (Test-Path $Enrolment)) { Die "no such enrolment bundle: $Enrolment" }
    $Enrolment = (Resolve-Path $Enrolment).Path

    $bundle = $null
    try {
        $bundle = Get-Content $Enrolment -Raw | ConvertFrom-Json
    } catch {
        Die "the enrolment bundle is not readable JSON: $($_.Exception.Message)"
    }

    $missing = @()
    if ($bundle.bundleVersion -ne 1) {
        $missing += "bundleVersion $($bundle.bundleVersion) is not supported by this installer"
    }
    if (-not $bundle.core.host)  { $missing += 'core.host' }
    if (-not $bundle.core.port)  { $missing += 'core.port' }
    if (-not $bundle.accessKey)  { $missing += 'accessKey' }
    foreach ($field in @('ca', 'cert', 'key')) {
        if (-not $bundle.tls.$field) { $missing += "tls.$field" }
    }
    if ($missing.Count -gt 0) {
        Die "the enrolment bundle is incomplete: $($missing -join ', ')"
    }
} elseif (-not (Test-Path $configPath)) {
    Die "no enrolment bundle given and no existing $configPath — run 'ms-enrol <name>' on the core host and pass the result with -Enrolment"
}

Write-Host "==> installing MonitoringSystem probe $version to $Prefix"

# --- application -------------------------------------------------------------------------------

foreach ($dir in @($Prefix, $DataDir, (Join-Path $DataDir 'tls'), (Join-Path $DataDir 'probe'),
                   (Join-Path $DataDir 'probe\spool'), (Join-Path $DataDir 'logs\probe'))) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

foreach ($stale in @('app', 'bin')) {
    $path = Join-Path $Prefix $stale
    if (Test-Path $path) { Remove-Item -Recurse -Force $path }
}
Copy-Item -Recurse -Force (Join-Path $here 'app') (Join-Path $Prefix 'app')
Copy-Item -Recurse -Force (Join-Path $here 'bin') (Join-Path $Prefix 'bin')
Set-Content -Path (Join-Path $Prefix 'VERSION') -Value $version

# WinSW resolves %BASE%\runtime\node.exe. Copying the interpreter beside the service rather than
# depending on PATH means a service that keeps working when somebody edits the system PATH, and a
# probe that runs under LocalSystem where the installing user's PATH does not apply at all.
$runtime = Join-Path $Prefix 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item -Force $NodeExe (Join-Path $runtime 'node.exe')

# --- enrolment ---------------------------------------------------------------------------------

if ($Enrolment) {
    Write-Host '==> applying the enrolment bundle'
    $tls = Join-Path $DataDir 'tls'
    # -NoNewline: a PEM ends with its own newline, and appending another produces a file OpenSSL
    # reads but some parsers do not.
    Set-Content -Path (Join-Path $tls 'ca.crt')    -Value $bundle.tls.ca   -NoNewline
    Set-Content -Path (Join-Path $tls 'probe.crt') -Value $bundle.tls.cert -NoNewline
    Set-Content -Path (Join-Path $tls 'probe.key') -Value $bundle.tls.key  -NoNewline

    # The private key is readable by Administrators and SYSTEM — the account the service runs as
    # — and by nobody else. Inheritance is broken first, or the parent's grants survive the
    # removal and the file stays readable by Users.
    $keyPath = Join-Path $tls 'probe.key'
    $acl = Get-Acl $keyPath
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($account in @('SYSTEM', 'Administrators')) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            $account, 'FullControl', 'Allow')))
    }
    Set-Acl -Path $keyPath -AclObject $acl

    if (-not $Name) { $Name = $bundle.probeName }
}

# --- configuration -------------------------------------------------------------------------------

if (Test-Path $configPath) {
    Write-Host "==> keeping existing $configPath"
    Copy-Item -Force (Join-Path $here 'etc\probe.json') "$configPath.new"
    if ($Enrolment) {
        # An upgrade carrying a new bundle still has to point at the core the bundle names —
        # usually *why* a second bundle was issued — so the endpoint and key are updated while
        # every tuning setting the operator changed is left alone.
        Write-Host '==> updating the core endpoint and access key from the bundle'
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        $cfg.core.host      = $bundle.core.host
        $cfg.core.port      = $bundle.core.port
        $cfg.core.accessKey = $bundle.accessKey
        Set-Content -Path $configPath -Value ($cfg | ConvertTo-Json -Depth 12)
    }
} else {
    Write-Host "==> installing $configPath"
    $cfg = Get-Content (Join-Path $here 'etc\probe.json') -Raw | ConvertFrom-Json
    $cfg.core.host      = $bundle.core.host
    $cfg.core.port      = $bundle.core.port
    $cfg.core.accessKey = $bundle.accessKey
    $cfg.core.tls.caFile   = Join-Path $DataDir 'tls\ca.crt'
    $cfg.core.tls.certFile = Join-Path $DataDir 'tls\probe.crt'
    $cfg.core.tls.keyFile  = Join-Path $DataDir 'tls\probe.key'
    $cfg.service.dataDir   = Join-Path $DataDir 'probe'
    $cfg.probe.spoolDir    = Join-Path $DataDir 'probe\spool'
    # The name an operator will see in the approval queue. The shipped example says "Local
    # probe", which would put every enrolled machine in that queue under the same name — the one
    # moment a name has to be right.
    if ($Name) { $cfg.probe.displayName = $Name }
    Set-Content -Path $configPath -Value ($cfg | ConvertTo-Json -Depth 12)
}

# --- service -------------------------------------------------------------------------------------

$serviceXml = Join-Path $Prefix 'ms-probe.xml'
Copy-Item -Force (Join-Path $here 'deploy\winsw\ms-probe.xml') $serviceXml

$serviceExe = Join-Path $Prefix 'ms-probe.exe'
if ($WinSw) {
    if (-not (Test-Path $WinSw)) { Die "no WinSW executable at $WinSw" }
    Copy-Item -Force $WinSw $serviceExe
}

if (-not (Test-Path $serviceExe)) {
    Write-Warning @"
WinSW.exe was not supplied, so the Windows service was not registered.

  Download WinSW (https://github.com/winsw/winsw/releases), then either re-run this
  script with -WinSw C:\path\to\WinSW.exe, or copy it yourself:

      copy WinSW.exe "$serviceExe"
      "$serviceExe" install
      "$serviceExe" start

Everything else is installed: the application, the enrolment and $configPath.
"@
    exit 0
}

Write-Host '==> registering the Windows service'
& $serviceExe install | Out-Null

if (-not $NoStart) {
    Write-Host '==> starting ms-probe'
    & $serviceExe start | Out-Null
    Start-Sleep -Seconds 2
    $service = Get-Service -Name 'ms-probe' -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -ne 'Running') {
        Die "ms-probe failed to start; see $DataDir\logs\probe"
    }
    Write-Host "    ms-probe: $($service.Status)"
}

$coreHost = (Get-Content $configPath -Raw | ConvertFrom-Json).core.host

Write-Host @"

MonitoringSystem probe $version installed.

  configuration   $configPath
  application     $Prefix
  logs            $DataDir\logs\probe

This probe is connecting to $coreHost and will wait there: a probe that has
reached the core is not yet a probe that may scan. Approve it by name on the
core's probes page, and delete the enrolment bundle from both machines.
"@
