# CC Relay 开机自启一键安装（当前用户登录自启，无需管理员）
# 用法: powershell -ExecutionPolicy Bypass -File relay\scripts\install-autostart.ps1
$ErrorActionPreference = 'Stop'
$relay = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$port = 8787

Write-Host "== CC Relay 自启安装 ==" -ForegroundColor Cyan

# 1. Node 环境
try { $nodeVer = (node --version) 2>$null } catch { $nodeVer = $null }
if (-not $nodeVer) {
  Write-Host "[ERR] 未找到 node，请先安装 Node.js 18+" -ForegroundColor Red
  exit 1
}
Write-Host "[OK] node $nodeVer"

# 2. 依赖
if (-not (Test-Path "$relay\node_modules\tsx\dist\cli.mjs")) {
  Write-Host "[..] 首次安装依赖 (npm install)..."
  Push-Location $relay
  npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Write-Host "[ERR] npm install 失败" -ForegroundColor Red; Pop-Location; exit 1 }
  Pop-Location
}
Write-Host "[OK] 依赖就绪"

# 3. Token：环境变量 > data\relay-token.txt > devtoken
$token = $env:CCR_TOKEN
if (-not $token -and (Test-Path "$relay\data\relay-token.txt")) { $token = (Get-Content "$relay\data\relay-token.txt" -Raw).Trim() }
if (-not $token) { $token = 'devtoken' }

# 4. startup 快捷方式（路径写入 .lnk，仓库移动后重跑本脚本即可）
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'CC Relay Autostart.lnk'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"' + (Join-Path $relay 'scripts\start-relay.vbs') + '"'
$s.WorkingDirectory = $relay
$s.Description = 'CC Relay hidden autostart'
$s.Save()
Write-Host "[OK] 自启快捷方式: $lnk"

# 5. 防火墙（需要管理员；失败只提示不阻塞）
$fwName = "CC Relay $port"
$fwOk = $false
try {
  $existing = (netsh advfirewall firewall show rule name="$fwName" 2>$null | Select-String 'LocalPort|规则名称|Rule Name')
  if ($existing) {
    $fwOk = $true
    Write-Host "[OK] 防火墙规则已存在: $fwName"
  } else {
    netsh advfirewall firewall add rule name="$fwName" dir=in action=allow protocol=TCP localport=$port | Out-Null
    if ($LASTEXITCODE -eq 0) { $fwOk = $true; Write-Host "[OK] 已添加防火墙入站规则: $fwName" }
  }
} catch {}
if (-not $fwOk) {
  Write-Host "[!!] 防火墙规则未能自动添加（需要管理员）。局域网设备连不上时，用管理员运行:" -ForegroundColor Yellow
  Write-Host "     netsh advfirewall firewall add rule name=`"$fwName`" dir=in action=allow protocol=TCP localport=$port" -ForegroundColor Yellow
}

# 6. 连接信息
Write-Host ""
Write-Host "== 连接信息（给手机/手表用）==" -ForegroundColor Cyan
Write-Host "  Token: $token"
$ips = Get-NetIPAddress -AddressFamily IPv4 -EA SilentlyContinue |
  Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' }
foreach ($ip in $ips) {
  $tag = if ($ip.InterfaceAlias -match 'VMware|Virtual|Loopback|utun|TAP|TUN|VPN') { '（虚拟/VPN网卡，勿用）' } else { '' }
  Write-Host ("  入口  : http://{0}:{1}/m?token={2}  [{3}] {4}" -f $ip.IPAddress, $port, $token, $ip.InterfaceAlias, $tag)
}
Write-Host ""
Write-Host "手表端: 设置 -> 直连，地址填 <上面的IP>:$port，Token 填 $token"
Write-Host "立即启动（不等下次登录）:  wscript `"$relay\scripts\start-relay.vbs`""
Write-Host "诊断连接问题:              powershell -File `"$relay\scripts\relay-status.ps1`""
Write-Host "完整说明:                  $relay\使用说明.txt"
