@echo off
rem Cloud Code Relay - office PC launcher (cloud bridge mode)
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
set CCR_CLOUD_URL=ws://REMOVED:8790/cloud
set CCR_CLOUD_TOKEN=REMOVED
node node_modules	sx\dist\cli.mjs src\index.ts
echo Relay exited.
pause
