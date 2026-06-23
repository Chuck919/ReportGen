# Web-only benchmark via POST /api/benchmark-tax (dev server required).
# Usage: .\scripts\benchmark-tax-web.ps1 [mode] [baseUrl] [clientId?]
#   mode: thorough | balanced | fast | all  (all = run all three modes)
param(
  [string]$Mode = "thorough",
  [string]$Base = "http://localhost:3000",
  [string]$ClientId = ""
)

$clients = @(
  @{ id = "kcf"; years = @(2023, 2024, 2025) },
  @{ id = "carithers"; years = @(2021, 2022, 2023, 2024, 2025) },
  @{ id = "sssi"; years = @(2022, 2023, 2024) },
  @{ id = "arizona-sun"; years = @(2022, 2023, 2024, 2025) }
)

if ($ClientId) {
  $clients = $clients | Where-Object { $_.id -eq $ClientId }
}

$modes = if ($Mode -eq "all") { @("thorough", "balanced", "fast") } else { @($Mode) }

foreach ($runMode in $modes) {
  Write-Host "=== benchmark-tax-web mode=$runMode base=$Base ===`n"
  $rows = @()
  $fail = $false

  foreach ($c in $clients) {
    foreach ($year in $c.years) {
      Write-Host -NoNewline "[$($c.id) $year] "
      $body = "{`"clientId`":`"$($c.id)`",`"year`":$year,`"ocrMode`":`"$runMode`"}"
      try {
        $res = Invoke-RestMethod -Uri "$Base/api/benchmark-tax" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 900
        $rows += $res
        Write-Host "primary $($res.primaryPct.ToString('F1'))% all $($res.allPct.ToString('F1'))% ($([math]::Round($res.elapsedMs/1000))s)"
        if ($res.allMisses.Count) {
          Write-Host "  misses: $($res.allMisses -join '; ')"
          $fail = $true
        }
      } catch {
        Write-Host "FAIL $($_.Exception.Message)"
        $fail = $true
      }
    }
  }

  $outDir = Join-Path $PSScriptRoot "benchmark-output"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $outPath = Join-Path $outDir "benchmark-tax-web-$runMode-$(Get-Date -UFormat %s).json"
  $rows | ConvertTo-Json -Depth 6 | Set-Content $outPath
  Write-Host "`nWrote $outPath`n"
}

if ($fail) { exit 1 }
