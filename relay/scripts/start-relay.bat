@echo off
setlocal EnableExtensions
rem ============================================================
rem CC Relay autostart supervisor (launched hidden via start-relay.vbs, or manually)
rem  - if port 8787 is already listening: assume relay running, exit (no double-start)
rem  - auto restart 5s after crash
rem  - Token priority: env CCR_TOKEN > data\relay-token.txt > devtoken
rem  - Logs: data\relay-console.log (relay output, rotate at 5MB)
rem          data\relay-autostart.log (start/stop record)
rem ============================================================
cd /d "%~dp0.." || exit /b 1

if not defined CCR_TOKEN if exist "data\relay-token.txt" set /p CCR_TOKEN=<"data\relay-token.txt"
if not defined CCR_TOKEN set "CCR_TOKEN=devtoken"
rem 空闲回落阈值 60s（默认 90s，用户要求更快回落）
if not defined CCR_NOHOOK_IDLE_MS set "CCR_NOHOOK_IDLE_MS=60000"
rem 云桥：存在 cloud-url.txt 即启用出站云客户端（阿里云 ECS :8790，2026-08-31 上线）
if not defined CCR_CLOUD_URL if exist "data\cloud-url.txt" set /p CCR_CLOUD_URL=<"data\cloud-url.txt"
if not defined CCR_CLOUD_TOKEN if exist "data\cloud-bridge-token.txt" set /p CCR_CLOUD_TOKEN=<"data\cloud-bridge-token.txt"

where node >nul 2>&1 || (echo [ERR] node not found in PATH >"data\relay-autostart.log" & exit /b 1)
if not exist "node_modules\tsx\dist\cli.mjs" (
  echo [%date% %time%] node_modules missing, running npm install >>"data\relay-autostart.log"
  call npm install --no-fund --no-audit >>"data\relay-autostart.log" 2>&1
)

call :log "supervisor starting (dir=%CD%)"

:loop
call :portbusy
if %ERRORLEVEL%==0 (
  if not defined RELAUNCHED (
    call :log "port 8787 already listening - relay already running, exit"
    exit /b 0
  )
  call :log "port 8787 taken over by another instance, stop supervising"
  exit /b 0
)

call :rotate
call :log "starting relay..."
node node_modules\tsx\dist\cli.mjs src\index.ts 2>&1 | node scripts\tee-log.mjs data\relay-console.log
call :log "relay exited, restart in 5s"
set "RELAUNCHED=1"
timeout /t 5 /nobreak >nul
goto loop

:portbusy
rem netstat state word LISTENING is English on all Windows locales
netstat -an | findstr /c:":8787 " | findstr /c:"LISTENING" >nul 2>&1
exit /b %ERRORLEVEL%

:rotate
if exist "data\relay-console.log" for %%F in ("data\relay-console.log") do if %%~zF GTR 5242880 move /y "data\relay-console.log" "data\relay-console.old.log" >nul
exit /b 0

:log
echo [%date% %time%] %~1 >>"data\relay-autostart.log"
exit /b 0
