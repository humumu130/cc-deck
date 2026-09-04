@echo off
rem CC Deck relay - remote PC launcher (cloud bridge mode)
rem Cloud bridge params default to the public CC Deck bridge; override via env
rem before running (set CCR_CLOUD_URL / CCR_CLOUD_TOKEN) to use your own bridge.
cd /d "%~dp0relay"
if not exist node_modules (
  echo [1/2] Installing dependencies, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install FAILED. Check network / Node.js version.
    pause
    exit /b 1
  )
)
echo [2/2] Starting relay (LAN :8787 + cloud bridge)...
set CCR_TOKEN=devtoken
if "%CCR_CLOUD_URL%"=="" set CCR_CLOUD_URL=wss://cc.humumu.online/cloud
if "%CCR_CLOUD_TOKEN%"=="" set CCR_CLOUD_TOKEN=ccdeck-public-9f3k2m7v
node node_modules\tsx\dist\cli.mjs src\index.ts
echo Relay exited.
pause
