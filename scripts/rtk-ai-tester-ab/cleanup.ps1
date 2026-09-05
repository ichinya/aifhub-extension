[CmdletBinding(SupportsShouldProcess = $true)]
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = 'Stop'
$experimentRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
if ((Split-Path -Leaf $experimentRoot) -notlike 'aifhub-rtk-ab-*') {
    throw 'Expected a specifically named aifhub-rtk-ab-* experiment directory'
}
if (-not (Test-Path -LiteralPath (Join-Path $experimentRoot 'aggregate.json'))) {
    throw 'Aggregate evidence must exist before deleting raw evidence'
}

# Keep pinned downloads, reference snapshots, fixtures and aggregate results.
# -WhatIf prints the exact targets without removing anything.
foreach ($name in @('jobs', 'sandboxes', 'pi-config', 'tee')) {
    $target = [IO.Path]::GetFullPath((Join-Path $experimentRoot $name))
    if (-not $target.StartsWith($experimentRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Cleanup path escapes experiment directory'
    }
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $resolved = (Resolve-Path -LiteralPath $target).ProviderPath
    if ($resolved -ne $target) { throw 'Unexpected resolved path' }
    $item = Get-Item -LiteralPath $target -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing to remove a junction or symlink'
    }
    if ($PSCmdlet.ShouldProcess($target, 'Remove temporary raw experiment artifacts')) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}
foreach ($item in @(Get-ChildItem -LiteralPath $experimentRoot -File | Where-Object Name -Like 'preflight-rtk.db*')) {
    if (-not $item.FullName.StartsWith($experimentRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Database path escapes experiment directory'
    }
    if ($PSCmdlet.ShouldProcess($item.FullName, 'Remove temporary RTK database')) {
        Remove-Item -LiteralPath $item.FullName -Force
    }
}
