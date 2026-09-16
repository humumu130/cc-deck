; CC Deck NSIS 安装钩子（tauri.conf.json bundle.windows.nsis.installerHooks 挂载）
; 手机扫码配对走 relay 8787/TCP 入站——Windows 防火墙默认拦 inbound，公司机/域策略机必拦
; （2026-09-16 用户报"手机扫 relay 码没反应"）。installMode 保持用户级（用户公司机无管理员
; 权限，perMachine 直接装不上）——netsh 放行仅在安装进程恰好有提升时生效（nsExec 失败
; 静默跳过不阻塞安装）；无管理员权限的机器配对走云桥码（出站 wss，不依赖入站放行）。
; 先删后加：升级重装时幂等，不堆重复规则
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="CC Deck Relay"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="CC Deck Relay" dir=in action=allow protocol=TCP localport=8787 profile=any'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="CC Deck Relay"'
!macroend
