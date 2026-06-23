# Run web API benchmark with long fetch timeouts (PowerShell).
# Usage: .\scripts\run-benchmark-web-api.ps1 thorough
#        .\scripts\run-benchmark-web-api.ps1 balanced carithers
param(
  [string]$Mode = "thorough",
  [string]$BaseUrl = "http://localhost:3000",
  [string]$ClientId = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

if (-not (Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match "next" })) {
  Write-Host "Tip: start dev server in another terminal: npm run dev" -ForegroundColor Yellow
}

$args = @("tsx", "scripts/benchmark-all-web-api.ts", $Mode, $BaseUrl)
if ($ClientId) { $args += $ClientId }

npx @args
exit $LASTEXITCODE
