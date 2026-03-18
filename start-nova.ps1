# =============================================================================
# start-nova.ps1 — Nova OS Startup Launcher
# =============================================================================
#
# Launches two persistent PowerShell windows:
#   1. Nova Server  — runs `bun dev` with auto-restart on crash
#   2. Nova Tunnel  — runs cloudflared with auto-restart on disconnect
#
# Usage:
#   Manual     → Right-click this file → "Run with PowerShell"
#   Scheduled  → Task Scheduler → action: powershell.exe
#                Arguments: -ExecutionPolicy Bypass -File "C:\Users\HessTheMess\MentraNova\start-nova.ps1"
#
# =============================================================================

# ── Paths ─────────────────────────────────────────────────────────────────────

$NovaRoot     = "C:\Users\HessTheMess\MentraNova\NovaOS-Mentra-App"
$TunnelConfig = "$env:USERPROFILE\.cloudflared\config.yml"
$TunnelName   = "nova-tunnel-local"

# ── Server loop ───────────────────────────────────────────────────────────────
# Runs inside a separate PowerShell window.
# bun dev starts the Nova server. If it exits for any reason, it restarts.

$serverScript = @"
`$host.UI.RawUI.WindowTitle = 'Nova Server'
Set-Location '$NovaRoot'

while (`$true) {
    Write-Host ''
    Write-Host '[ Nova ] Server starting...' -ForegroundColor Cyan
    bun dev
    Write-Host ''
    Write-Host '[ Nova ] Server crashed or exited. Restarting in 2s...' -ForegroundColor Yellow
    Start-Sleep -Seconds 2
}
"@

# ── Tunnel loop ───────────────────────────────────────────────────────────────
# Runs inside a separate PowerShell window.
# cloudflared connects the tunnel. If it disconnects, it restarts.

$tunnelScript = @"
`$host.UI.RawUI.WindowTitle = 'Nova Tunnel'

while (`$true) {
    Write-Host ''
    Write-Host '[ Tunnel ] Starting cloudflared...' -ForegroundColor Green
    cloudflared tunnel --config '$TunnelConfig' run $TunnelName
    Write-Host ''
    Write-Host '[ Tunnel ] Disconnected or exited. Restarting in 3s...' -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}
"@

# ── Launch ────────────────────────────────────────────────────────────────────
# Encode both scripts as Base64 so they survive being passed as arguments.

$serverEnc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($serverScript))
$tunnelEnc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($tunnelScript))

Write-Host ""
Write-Host "[ Nova ] Launching server window..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-EncodedCommand", $serverEnc

# Brief pause so the server gets a head start before the tunnel connects.
Start-Sleep -Seconds 2

Write-Host "[ Nova ] Launching tunnel window..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-EncodedCommand", $tunnelEnc

Write-Host ""
Write-Host "[ Nova ] Both processes launched." -ForegroundColor White
Write-Host "         Server and tunnel are running in their own windows." -ForegroundColor Gray
Write-Host "         This launcher window can be closed." -ForegroundColor Gray
Write-Host ""
