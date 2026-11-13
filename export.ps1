<#
.SYNOPSIS
    Runs every query in sql\ against SQL Server and writes one CSV per query to data\.

.DESCRIPTION
    01_po_lines.sql -> data\po_lines.csv, and so on (the number prefix is dropped).
    CSVs are UTF-8 without BOM, comma-separated, with invariant-culture numbers
    (decimal point, not comma), so Google Sheets imports them the same way on any PC.
    Uses Windows authentication and only the .NET SqlClient built into Windows,
    so no extra PowerShell modules are needed.

    -CopyTo also copies each CSV into another folder. Point it at a folder synced by
    Google Drive for desktop and the Sheet's import picks up fresh data with no manual upload.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\export.ps1
    powershell -ExecutionPolicy Bypass -File .\export.ps1 -Server "MYPC\SQLEXPRESS"
    powershell -ExecutionPolicy Bypass -File .\export.ps1 -CopyTo "G:\My Drive\po-recon-csv"
#>
param(
    [string]$Server   = '.\SQLEXPRESS',
    [string]$Database = 'AdventureWorks2022',
    [string]$SqlDir   = (Join-Path $PSScriptRoot 'sql'),
    [string]$OutDir   = (Join-Path $PSScriptRoot 'data'),
    [string]$CopyTo   = ''
)

if ($CopyTo -and -not (Test-Path $CopyTo -PathType Container)) {
    throw "CopyTo folder not found: $CopyTo"
}

$ErrorActionPreference = 'Stop'
$invariant = [Globalization.CultureInfo]::InvariantCulture
$utf8NoBom = New-Object Text.UTF8Encoding $false

function ConvertTo-CsvField($value) {
    if ($null -eq $value -or $value -is [DBNull]) { return '' }
    if ($value -is [IFormattable]) { $text = $value.ToString($null, $invariant) }
    else                           { $text = [string]$value }
    if ($text -match '[",\r\n]') { $text = '"' + $text.Replace('"', '""') + '"' }
    return $text
}

New-Item -ItemType Directory -Force $OutDir | Out-Null

$connection = New-Object System.Data.SqlClient.SqlConnection(
    "Server=$Server;Database=$Database;Integrated Security=True;TrustServerCertificate=True")
$connection.Open()
try {
    foreach ($file in Get-ChildItem $SqlDir -Filter *.sql | Sort-Object Name) {
        $command = $connection.CreateCommand()
        $command.CommandText    = Get-Content $file.FullName -Raw -Encoding UTF8
        $command.CommandTimeout = 120

        $table  = New-Object System.Data.DataTable
        $reader = $command.ExecuteReader()
        $table.Load($reader)
        $reader.Close()

        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add((@($table.Columns | ForEach-Object { ConvertTo-CsvField $_.ColumnName }) -join ','))
        foreach ($row in $table.Rows) {
            $lines.Add((@($row.ItemArray | ForEach-Object { ConvertTo-CsvField $_ }) -join ','))
        }

        $name = $file.BaseName -replace '^\d+_', ''
        $path = Join-Path $OutDir "$name.csv"
        [IO.File]::WriteAllLines($path, $lines, $utf8NoBom)
        '{0,-30} {1,6} rows  ->  data\{2}.csv' -f $file.Name, $table.Rows.Count, $name
        if ($CopyTo) { Copy-Item $path (Join-Path $CopyTo "$name.csv") -Force }
    }
}
finally {
    $connection.Close()
}
if ($CopyTo) { "Copied to $CopyTo" }
