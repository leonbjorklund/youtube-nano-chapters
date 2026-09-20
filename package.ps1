$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & node --test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed. No release package was created.' }

    $manifest = Get-Content -Raw -LiteralPath 'manifest.json' | ConvertFrom-Json
    $files = @('manifest.json', 'popup.html', 'popup.js', 'chapters.js', 'generation.js')
    $files += $manifest.icons.PSObject.Properties.Value
    foreach ($file in $files) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Missing runtime file: $file"
        }
    }

    $output = Join-Path $PSScriptRoot 'dist'
    [IO.Directory]::CreateDirectory($output) | Out-Null
    $zipPath = Join-Path $output "youtube-nano-chapters-$($manifest.version).zip"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = [IO.File]::Create($zipPath)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, (Join-Path $PSScriptRoot $file), $file,
                [IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally {
        $archive.Dispose()
        $stream.Dispose()
    }
    Write-Output $zipPath
} finally {
    Pop-Location
}
