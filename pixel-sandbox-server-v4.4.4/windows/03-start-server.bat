@echo off
setlocal EnableExtensions

title Pixel Sandbox Server (V4.4.3 增强版)

set "ROOT=%~dp0.."
set "SERVER=%ROOT%\server"

if not exist "%SERVER%\server.js" (
  echo [ERROR] 找不到 server\server.js
  echo "%SERVER%\server.js"
  pause
  exit /b 1
)

if not exist "%SERVER%\node_modules\ws" (
  echo [Pixel Sandbox] 依赖未安装。
  echo 请先运行 windows\02-install-depend.bat
  echo.
  pause
  exit /b 1
)

cd /d "%SERVER%"
if errorlevel 1 (
  echo [ERROR] 无法进入 server 目录。
  pause
  exit /b 1
)

echo ========================================
echo Pixel Sandbox Server (V4.4.3 增强版)
echo ========================================
echo Node.js:
call node -v
echo.
echo 服务器目录:
echo   %SERVER%
echo.
echo 日志目录（服务器 / 管理登录 / 玩家操作 按日分文件）:
echo   %SERVER%\logs\
echo.
echo 监听地址: 0.0.0.0:8080
echo ========================================
echo.
echo [提示] 保持此窗口打开 = 服务器运行中；关闭窗口 = 停止服务器。
echo [提示] 所有服务器与玩家操作日志已自动写入 %SERVER%\logs\
echo.

call node server.js
set "EXITCODE=%errorlevel%"

echo.
echo ========================================
echo 服务器进程已退出。退出码 = %EXITCODE%
echo 运行日志请查看: %SERVER%\logs\
echo ========================================
pause
exit /b %EXITCODE%
