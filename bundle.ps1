<#
.SYNOPSIS
    Joins apps-script\*.gs into one file, dist\Code.gs, and copies it to the clipboard,
    ready to paste into the Apps Script editor (Extensions > Apps Script > Code.gs).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\bundle.ps1
#>
$ErrorActionPreference = 'Stop'
$src  = Join-Path $PSScriptRoot 'apps-script'
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$order = 'Menu', 'Settings', 'Import', 'Reconcile', 'InventoryRisk', 'Summary', 'Matching', 'SheetIO', 'Utils'
$parts = foreach ($name in $order) {
    $file = Join-Path $src "$name.gs"
    "// ===== $name.gs " + ('=' * (70 - $name.Length))
    [IO.File]::ReadAllText($file).TrimEnd()
    ''
}
$header = "// Bundled from apps-script/*.gs by bundle.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Edit the source files, not this one.`r`n"
$text = $header + ($parts -join "`r`n")
$out = Join-Path $dist 'Code.gs'
[IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding $false))
Set-Clipboard -Value $text
"Wrote dist\Code.gs ($([math]::Round($text.Length / 1KB)) KB) and copied it to the clipboard."
