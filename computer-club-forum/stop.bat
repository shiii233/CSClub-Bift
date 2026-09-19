@echo off
REM Computer Club Forum - local stop script (ASCII only, codepage-safe)
setlocal
cd /d "%~dp0"

set PORTNUM=8210
for /f %%P in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORTNUM% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do set PID=%%P

if "%PID%"=="" (
  echo [i] Nothing is listening on port %PORTNUM%.
  pause
  exit /b 0
)

echo Stopping PID=%PID% (listening on port %PORTNUM%) ...
taskkill /PID %PID% /F
echo.
echo Stopped. Double-click start.bat to run it again.
pause
