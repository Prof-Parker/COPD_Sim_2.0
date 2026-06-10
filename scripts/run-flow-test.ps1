# Run static passage-flow validation (requires Node.js 18+)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Validator = Join-Path $Root "scripts\validate-flow.mjs"
$Twee = Join-Path $Root "COPD simulation 2.0.4.twee"

function Find-NodeExe {
    $candidates = @(
        "node",
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\node\node.exe"),
        (Join-Path $env:APPDATA "nvm\current\node.exe")
    )

    foreach ($candidate in $candidates) {
        if ($candidate -eq "node") {
            $cmd = Get-Command node -ErrorAction SilentlyContinue
            if ($cmd) {
                return $cmd.Source
            }
            continue
        }
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    return $null
}

$NodeExe = Find-NodeExe
if (-not $NodeExe) {
    Write-Warning "Node.js not found - skipping passage flow validation."
    Write-Warning "Install Node 18+ from https://nodejs.org/ then run: npm run test:flow"
    exit 0
}

Write-Host "Running passage flow validator..."
Write-Host ("  Node: " + $NodeExe)
Write-Host ("  Story: " + $Twee)
& $NodeExe $Validator $Twee
exit $LASTEXITCODE
