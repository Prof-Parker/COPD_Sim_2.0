# Compile COPD simulation 2.0.4.twee -> index.html (SugarCube 2)
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$TweegoDir = "C:\Users\robin\OneDrive - Shasta College\Simulation Creation\Twine Simulation App\tweego-2.1.1-windows-x64"
$Tweego = Join-Path $TweegoDir "tweego.exe"
$Twee = Join-Path $Root "COPD simulation 2.0.4.twee"
$Out = Join-Path $Root "index.html"

if (-not (Test-Path -LiteralPath $Tweego)) {
    Write-Error "tweego.exe not found at: $Tweego"
}
if (-not (Test-Path -LiteralPath $Twee)) {
    Write-Error "Source not found: $Twee"
}

# Story formats shipped with this Tweego install (shared with your other project)
$env:TWEEGO_PATH = $TweegoDir

Write-Host "Compiling: $Twee"
Write-Host "Output:    $Out"
& $Tweego -f sugarcube-2 -o $Out $Twee
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
Write-Host "Done."
