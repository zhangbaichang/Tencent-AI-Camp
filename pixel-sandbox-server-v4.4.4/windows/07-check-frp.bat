@echo off
setlocal EnableExtensions

title Pixel Sandbox - Check SakuraFrp

set "ROOT=%~dp0.."
set "SERVER=%ROOT%\server"

if not exist "%SERVER%\sakura-frp.js" (
  echo [ERROR] 找不到 server\sakura-frp.js
  pause
  exit /b 1
)

cd /d "%SERVER%"
if errorlevel 1 (
  echo [ERROR] 无法进入 server 目录。
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 找不到 Node.js。
  pause
  exit /b 1
)

echo ========================================
echo SakuraFrp Public Address Check
echo ========================================
echo.

call node -e "const m=require('./sakura-frp'); console.log(JSON.stringify(m.getPublicAddressInfo(),null,2))"

echo.
pause
exit /b 0
