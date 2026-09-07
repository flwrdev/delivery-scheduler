<#
.SYNOPSIS
  Binubura ang HTTP disk cache ng automation browsers nang HINDI ginagalaw ang
  mga profile (kaya buo ang cookies, login, at laman ng cart).

.DESCRIPTION
  Ang mga MCP browser ay nakaturo ang --disk-cache-dir sa labas ng kanilang
  user-data-dir, kaya ligtas na burahin ang cache nang hiwalay. Gamitin ito kapag
  pinaghihinalaan mong luma ang nakikitang tema o asset (ang cache ang madalas na
  dahilan kung bakit napagkakamalang live ang isang lumang bersyon, kaya mali ang
  sinusukat).

  Ang cookies at session ay NASA loob ng profile at hindi ginagalaw dito.

.EXAMPLE
  pwsh -File scripts/clear-browser-cache.ps1
#>

$root = 'C:\Users\janbr\AppData\Local\Temp\chrome-mcp-cache'

$running = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like '*ToolsChromeForTesting*' })
if ($running.Count -gt 0) {
    Write-Host "May $($running.Count) na automation-browser na proseso pa. Isara muna ang browser (o tapusin ang MCP session) bago linisin - naka-lock ang cache habang bukas."
    exit 1
}

if (-not (Test-Path $root)) {
    Write-Host "Walang cache na mabubura: $root"
    exit 0
}

foreach ($dir in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue) {
    $kb = [math]::Round((Get-ChildItem $dir.FullName -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum / 1KB, 1)
    Remove-Item $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Nalinis: $($dir.Name)  ($kb KB)"
}

Write-Host 'Tapos. Buo pa rin ang mga profile (cookies / login / cart).'
