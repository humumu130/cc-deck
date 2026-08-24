$c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  $p = $c.OwningProcess
  Write-Host "killing pid=$p"
  Stop-Process -Id $p -Force
  Start-Sleep -Milliseconds 800
} else {
  Write-Host "no listener on 8787"
}
Start-Process cmd -ArgumentList '/k set CCR_TOKEN=devtoken&& cd /d D:\dev\cc-watch\relay && npm run dev 2>&1 | node scripts/tee-log.mjs data\relay-console.log'
Write-Host "relay restarted"
