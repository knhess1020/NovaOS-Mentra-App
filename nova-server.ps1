# nova-server.ps1 — Nova server loop
# Called by start-nova.ps1 — do not run this directly from Task Scheduler.

$host.UI.RawUI.WindowTitle = "Nova Server"

$bun  = "C:\Users\HessTheMess\.bun\bin\bun.exe"
$root = "C:\Users\HessTheMess\MentraNova\NovaOS-Mentra-App"

Set-Location $root

while ($true) {
    Write-Host ""
    Write-Host "[ Nova ] Server starting..." -ForegroundColor Cyan
    & $bun dev
    Write-Host ""
    Write-Host "[ Nova ] Server crashed or exited. Restarting in 2s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 2
}
