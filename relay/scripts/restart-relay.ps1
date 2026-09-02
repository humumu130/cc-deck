# 重启 relay：只杀监听进程，等 start-relay.bat 守护脚本 5s 后自动拉起
# （守护路径带 CCR_CLOUD_URL 等完整环境；此前直接 npm run dev 会丢云桥且残留 cmd 窗口）
# Get-NetTCPConnection 在本机偶发查不到，用 netstat 兜底（LISTENING 关键词各语言版本一致）
$line = (netstat -ano | Select-String ':8787\s.*LISTENING' | Select-Object -First 1)
if ($line) {
  $p = ($line.ToString().Trim() -split '\s+')[-1]
  Write-Host "killing pid=$p"
  Stop-Process -Id ([int]$p) -Force
} else {
  Write-Host "no listener on 8787"
}

$ok = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 800
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8787/health -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}
if ($ok) {
  Write-Host "relay restarted by supervisor"
} else {
  # 守护脚本不在（未开机自启/被手动关）：隐藏拉起 vbs 再等一轮
  Write-Host "supervisor not running, launching start-relay.vbs"
  Start-Process wscript -ArgumentList '"D:\dev\cc-watch\relay\scripts\start-relay.vbs"'
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 1000
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8787/health -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
  }
  if ($ok) { Write-Host "relay started" } else { Write-Host "ERROR: relay failed to start" }
}
