@echo off
setlocal enabledelayedexpansion

rem Try to stop using bot.pid first
if exist bot.pid (
  set /p BOT_PID=<bot.pid
  echo Stopping WhatsApp bot process !BOT_PID! using bot.pid...
  taskkill /f /pid !BOT_PID! >nul 2>&1
  del bot.pid >nul 2>&1
)

rem Find any process listening on port 7860
echo Checking for any process holding port 7860...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7860 ^| findstr LISTENING') do (
  set "PORT_PID=%%a"
  if not "!PORT_PID!"=="" (
    echo Found process !PORT_PID! holding port 7860. Terminating...
    taskkill /f /pid !PORT_PID! >nul 2>&1
  )
)

echo WhatsApp bot stopped successfully.
pause
