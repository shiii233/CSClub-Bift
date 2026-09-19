@echo off
REM Computer Club Forum - local start script (ASCII only, codepage-safe)
setlocal
cd /d "%~dp0"

set PORTNUM=8210

REM Warn if the port is already in use, to avoid starting twice
for /f %%P in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORTNUM% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do (
  if not "%%P"=="" (
    echo [i] Port %PORTNUM% is already in use by PID %%P - the forum is probably running.
    echo     Open http://127.0.0.1:%PORTNUM% in your browser.
    pause
    exit /b 0
  )
)

echo Starting Computer Club Forum (MySQL storage)...
echo Closing this window stops the service. Log: logs\forum.log
echo Note: run "npm install mysql2 --registry=https://registry.npmmirror.com" first if the driver is missing.
echo.
set FORUM_LOG=%~dp0logs\forum.log
if not exist logs mkdir logs
node server.mjs
echo.
echo Service exited (exit code %ERRORLEVEL%).
pause
