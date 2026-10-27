@echo off
setlocal EnableExtensions

title Pixel Sandbox - Restart Server

call "%~dp0\04-stop-server.bat"

set "ROOT=%~dp0.."
set "SERVER=%ROOT%\server"

if not exist "%SERVER%\server.js" (
  echo [ERROR] 找不到 server\server.js
  pause
  exit /b 1
)

if not exist "%SERVER%\node_modules\ws" (
  echo [ERROR] 依赖未安装，请先运行 02-install-depend.bat
  pause
  exit /b 1
)

cd /d "%SERVER%"
if errorlevel 1 (
  echo [ERROR] 无法进入 server 目录。
  pause
  exit /b 1
)

echo 正在启动 Pixel Sandbox Server (V4.4.4 增强版)...
start "Pixel Sandbox Server (V4.4.4)" /D "%SERVER%" cmd /k "node server.js"

echo.
echo [OK] Server 已启动。运行日志: %SERVER%\logs\
echo.
exit /b 0
