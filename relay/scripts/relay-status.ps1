# CC Relay 连接诊断：逐项检查并在末尾给出针对性排查建议
# 用法: powershell -ExecutionPolicy Bypass -File relay\scripts\relay-status.ps1
$relay = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$port = 8787
$fail = @()

Write-Host "== CC Relay 诊断 ==" -ForegroundColor Cyan

# 1. 进程/端口
$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  $started = if ($p) { $p.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '?' }
  Write-Host "[OK] 端口 $port 监听中  pid=$($c.OwningProcess) 进程=$($p.ProcessName) 启动于 $started"
} else {
  Write-Host "[XX] 端口 $port 无监听 —— relay 没在运行" -ForegroundColor Red
  $fail += 'not-running'
}

# 2. HTTP 存活探测（401/404 也证明服务活着）
$httpCode = $null
try {
  $r = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 3
  $httpCode = $r.StatusCode
} catch {
  if ($_.Exception.Response) { $httpCode = [int]$_.Exception.Response.StatusCode }
}
if ($httpCode) { Write-Host "[OK] HTTP 存活 (status $httpCode)" }
elseif (-not $c) { Write-Host "[--] HTTP 探测跳过（进程未运行）" -ForegroundColor DarkGray }
else { Write-Host "[XX] 端口在监听但 HTTP 无响应 —— 可能是刚启动或挂死" -ForegroundColor Red; $fail += 'http-dead' }

# 3. Token（手机/手表连不上最常见原因：token 不一致）
$token = $env:CCR_TOKEN
$src = '环境变量'
if (-not $token -and (Test-Path "$relay\data\relay-token.txt")) { $token = (Get-Content "$relay\data\relay-token.txt" -Raw).Trim(); $src = 'data\relay-token.txt' }
if (-not $token) { $token = 'devtoken'; $src = '默认值' }
Write-Host "[OK] 当前 Token ($src): $token"
Write-Host "     注意: 若 relay 是手动窗口启动的，其窗口里 set 的 token 以上面手机端实际使用的为准"

# 4. 本机 IP（给手机/手表填地址用）
Write-Host ""
Write-Host "== 本机地址候选 ==" -ForegroundColor Cyan
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' }
foreach ($ip in $ips) {
  $tag = if ($ip.InterfaceAlias -match 'VMware|Virtual|Loopback|utun|TAP|TUN|VPN') { '虚拟/VPN网卡，勿用' } else { '可用' }
  Write-Host ("  {0,-16} [{1}] {2}" -f $ip.IPAddress, $ip.InterfaceAlias, $tag)
}

# 5. 防火墙
$fwName = "CC Relay $port"
$fw = netsh advfirewall firewall show rule name="$fwName" 2>$null | Select-String 'LocalPort|规则名称|Rule Name|Enabled|已启用'
if ($fw) {
  Write-Host ""
  Write-Host "[OK] 防火墙放行规则存在: $fwName"
} else {
  Write-Host ""
  Write-Host "[!!] 无防火墙放行规则: 其他设备将连不上 $port（本机不受影响）" -ForegroundColor Yellow
  Write-Host "    管理员运行: netsh advfirewall firewall add rule name=`"$fwName`" dir=in action=allow protocol=TCP localport=$port"
  $fail += 'firewall'
}

# 6. 自启是否安装
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'CC Relay Autostart.lnk'
if (Test-Path $lnk) { Write-Host "[OK] 开机自启已安装: $lnk" }
else { Write-Host "[--] 未安装自启（可选）: powershell -File `"$relay\scripts\install-autostart.ps1`"" -ForegroundColor DarkGray }

# 7. 日志尾部
Write-Host ""
Write-Host "== 最近日志 ==" -ForegroundColor Cyan
foreach ($f in @("$relay\data\relay-autostart.log", "$relay\data\relay-console.log")) {
  if (Test-Path $f) {
    Write-Host "--- $(Split-Path $f -Leaf) (最后 8 行) ---" -ForegroundColor DarkGray
    Get-Content $f -Tail 8 | ForEach-Object { if ($_.Length -gt 160) { $_.Substring(0, 160) + '...' } else { $_ } }
  }
}

# 8. 结论
Write-Host ""
Write-Host "== 排查建议 ==" -ForegroundColor Cyan
if ($fail -contains 'not-running') {
  Write-Host "  relay 未运行 -> wscript `"$relay\scripts\start-relay.vbs`" 立即启动；看 relay-autostart.log 是否有报错"
}
if ($fail -contains 'http-dead') {
  Write-Host "  进程挂死 -> 跑 relay\scripts\restart-relay.ps1 强制重启"
}
if ($fail -contains 'firewall') {
  Write-Host "  手机/手表连不上但本机正常 -> 先补防火墙规则（见上方命令）"
}
if (-not $fail) {
  Write-Host "  本机一切正常。若手机/手表仍连不上，依次确认："
  Write-Host "  1) 手机/手表与电脑同一网络（WiFi 名称相同；手表走蓝牙共享网络时手机别离开电脑）"
  Write-Host "  2) 填的 IP 是上面标'可用'的那个，端口 $port，Token 一字不差"
  Write-Host "  3) 手机浏览器先开 http://<IP>:$port/m?token=$token 验证网络可达，再回到 App/手表"
}
