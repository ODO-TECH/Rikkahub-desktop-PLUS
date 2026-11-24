param([switch]$SkipTauri)
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
Run-Checked (Join-Path $alphaRoot 'pc-server') { bun build --compile --minify --keep-names --target=bun-windows-x64 --external=cpu-features --external=ssh2/lib/protocol/crypto/build/Release/sshcrypto.node server.ts --outfile ../dist/rikkahub-pc.exe }
Run-Checked (Join-Path $alphaRoot 'pc-server') { bun run scripts/sync-dist-assets.ts }
$sidecarDir = Join-Path $alphaRoot 'web-ui\src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $sidecarDir | Out-Null
Copy-Item (Join-Path $alphaRoot 'dist\rikkahub-pc.exe') (Join-Path $sidecarDir 'rikkahub-pc-x86_64-pc-windows-msvc.exe') -Force
if (-not $SkipTauri) {
    Run-Checked (Join-Path $alphaRoot 'web-ui') { cmd /c src-tauri\tauri-msvc.cmd build --bundles nsis }
    $tauriExe = Join-Path 'C:\rikkahub-build\release' 'RikkaHub.exe'
    if (-not (Test-Path $tauriExe)) { throw "Tauri shell not found at $tauriExe" }
    Copy-Item $tauriExe (Join-Path $alphaRoot 'dist\RikkaHub.exe') -Force
    Write-Host 'Built dist/rikkahub-pc.exe, dist/RikkaHub.exe (Tauri) and the NSIS installer. Package with python scripts/package-alpha.py.'
} else {
    Write-Host 'Built dist/rikkahub-pc.exe (Tauri build skipped).'
}
