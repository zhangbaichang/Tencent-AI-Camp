@echo off
setlocal EnableExtensions

title Pixel Sandbox - Environment Check

echo ========================================
echo Pixel Sandbox Environment Check
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 找不到 Node.js，请先安装 Node.js。
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 找不到 npm，请检查 Node.js PATH。
  echo.
  pause
  exit /b 1
)

echo Node.js:
call node -v
echo.
echo npm:
call npm -v
echo.
echo [OK] 环境检查完成。
echo.
pause
exit /b 0
