@echo off
setlocal EnableExtensions

title Pixel Sandbox - Install Dependencies

set "ROOT=%~dp0.."
set "SERVER=%ROOT%\server"

echo ==========================================
echo Pixel Sandbox - Install Dependencies
echo ==========================================
echo.
echo Server directory:
echo "%SERVER%"
echo.

if not exist "%SERVER%\package.json" (
  echo [ERROR] 找不到 server\package.json
  echo "%SERVER%\package.json"
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 找不到 Node.js。
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 找不到 npm。
  echo.
  pause
  exit /b 1
)

cd /d "%SERVER%"
if errorlevel 1 (
  echo [ERROR] 无法进入 server 目录。
  echo.
  pause
  exit /b 1
)

echo [INFO] Node.js version:
call node -v
echo.
echo [INFO] npm version:
call npm -v
echo.
echo [INFO] Installing dependencies...
echo.

call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed.
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo Dependencies installed successfully
echo ==========================================
echo.
pause
exit /b 0
