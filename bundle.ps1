<#
.SYNOPSIS
    Joins apps-script\*.gs into one file, dist\Code.gs, and copies it to the clipboard,
    ready to paste into the Apps Script editor (Extensions > Apps Script > Code.gs).
    The manifest (apps-script\appsscript.json) is pasted separately, only when it changes.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\bundle.ps1
#>
$ErrorActionPreference = 'Stop'
$src  = Join-Path $PSScriptRoot 'apps-script'
$dist = Join-Path $PSScriptRoot 'dist'

$order = 'Menu', 'Schedule', 'Settings', 'Import', 'Reconcile', 'Tracking', 'InventoryRisk',
         'Summary', 'Report', 'Matching', 'SheetIO', 'Utils'

# Fail before writing anything if a module exists that the bundle would leave out.
$missing = Get-ChildItem $src -Filter *.gs | Where-Object { $order -notcontains $_.BaseName }
if ($missing) { throw "Add to `$order in bundle.ps1: $($missing.Name -join ', ')" }

New-Item -ItemType Directory -Force $dist | Out-Null
$parts = foreach ($name in $order) {
    "// ===== $name.gs " + ('=' * (70 - $name.Length))
    [IO.File]::ReadAllText((Join-Path $src "$name.gs")).TrimEnd()
    ''
}
$header = "// Bundled from apps-script/*.gs by bundle.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Edit the source files, not this one.`r`n"
$text = $header + ($parts -join "`r`n")
$out = Join-Path $dist 'Code.gs'
[IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding $false))
Set-Clipboard -Value $text
"Wrote dist\Code.gs ($([math]::Round($text.Length / 1KB)) KB) and copied it to the clipboard."
