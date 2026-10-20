<#
.SYNOPSIS
    Stops and deregisters what ms-setup.ps1 registered (H-06).
.DESCRIPTION
    The uninstall half, kept beside the install half so the two cannot disagree about what was
    created. Run by the MSI on removal, and safe to run by hand.

        .\ms-teardown.ps1 -Components core,probe

    **What it does not remove is the point.** ProgramData holds the configuration, the
    credential-vault key and the probe's spool, and the vault key is unrecoverable — every stored
    credential goes with it. Removing that as a side effect of removing the application would
    destroy data nobody asked to destroy, so this leaves it exactly where the Linux packages
    leave /etc/ms and /var/lib/ms-*, and says so.
#>
[CmdletBinding()]
param(
    [string[]] $Components = @('core', 'probe'),
    [string]   $Prefix     = "$env:ProgramFiles\MonitoringSystem",
    [string]   $DataDir    = "$env:ProgramData\MonitoringSystem"
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

foreach ($svc in $Components) {
    $service = Get-Service -Name "ms-$svc" -ErrorAction SilentlyContinue
    if (-not $service) { continue }

    # WinSW finds its definition by basename, so ms-core.exe pairs with ms-core.xml. A bare
    # "$svc.exe" would be an executable with no service definition beside it.
    $serviceExe = Join-Path $Prefix "ms-$svc.exe"
    if (Test-Path $serviceExe) {
        # WinSW's own stop honours the graceful shutdown the service definition asks for; a
        # Stop-Service would not wait the same way.
        & $serviceExe stop | Out-Null
        & $serviceExe uninstall | Out-Null
    }
    else {
        Stop-Service -Name "ms-$svc" -Force -ErrorAction SilentlyContinue
        sc.exe delete "ms-$svc" | Out-Null
    }
    Write-Host "==> removed service ms-$svc"
}

if ($Components -contains 'core') {
    foreach ($name in @('MonitoringSystem API', 'MonitoringSystem probe channel')) {
        if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
            Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
            Write-Host "==> removed firewall rule: $name"
        }
    }
}

# The expanded application, which the MSI does not track file by file — see package-msi.sh.
foreach ($tree in @('app', 'web', 'bin', 'docs')) {
    $path = Join-Path $Prefix $tree
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue
        Write-Host "==> removed $path"
    }
}

Write-Host @"

$DataDir was left in place. It holds the configuration, the credential-vault key and the spool —
and without the vault key no stored credential can ever be decrypted again. Remove it when you
mean to, not as a side effect of removing the application.
"@
