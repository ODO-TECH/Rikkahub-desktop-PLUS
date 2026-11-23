$ErrorActionPreference = 'Stop'
$alphaRoot = Split-Path -Parent $PSScriptRoot
function Run-Checked([string]$directory, [scriptblock]$action) {
    Push-Location $directory
    try { & $action; if ($LASTEXITCODE -ne 0) { throw "Build failed in $directory" } }
    finally { Pop-Location }
}
Run-Checked (Join-Path $alphaRoot 'pc-server') { bun install --frozen-lockfile }
Run-Checked (Join-Path $alphaRoot 'web-ui') { bun install --frozen-lockfile }
Run-Checked (Join-Path $alphaRoot 'web-ui') { bun run build }
Run-Checked (Join-Path $alphaRoot 'pc-server') { bun run scripts/ensure-build-dirs.ts }
Run-Checked (Join-Path $alphaRoot 'pc-server') { bun run scripts/build-bash-bundle.ts }
Run-Checked (Join-Path $alphaRoot 'pc-server') { bun build --compile --minify --keep-names --target=bun-windows-x64 server.ts --outfile ../dist/rikkahub-pc.exe }
Run-Checked (Join-Path $alphaRoot 'pc-server') { bun run scripts/sync-dist-assets.ts }
$shellDist = [IO.Path]::GetFullPath((Join-Path $alphaRoot 'desktop-shell\dist'))
if (-not $shellDist.StartsWith($alphaRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Invalid shell output directory' }
Run-Checked (Join-Path $alphaRoot 'desktop-shell') { cmd /c build.cmd }
Write-Host 'Built dist/rikkahub-pc.exe and desktop-shell/dist/RikkaHub.exe. Package with python scripts/package-alpha.py.'
