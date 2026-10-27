@echo off
setlocal EnableExtensions

title Pixel Sandbox - Backup World

set "ROOT=%~dp0.."
set "SERVER=%ROOT%\server"
set "WORLD=%SERVER%\world"
set "BACKUP=%ROOT%\world_backup"

if not exist "%WORLD%" (
  echo [ERROR] 找不到 world 目录：
  echo "%WORLD%"
  echo.
  pause
  exit /b 1
)

if not exist "%BACKUP%" mkdir "%BACKUP%"

for /f "tokens=1-3 delims=/- " %%a in ("%date%") do set "DATESTAMP=%%a-%%b-%%c"
set "DEST=%BACKUP%\%DATESTAMP%"

if exist "%DEST%" (
  set "DEST=%BACKUP%\%DATESTAMP%_%time:~0,2%%time:~3,2%%time:~6,2%"
  set "DEST=%DEST: =0%"
)

mkdir "%DEST%" 2>nul
xcopy "%WORLD%\*" "%DEST%\" /E /I /Y >nul

if errorlevel 1 (
  echo [ERROR] 世界备份失败。
  pause
  exit /b 1
)

echo.
echo [OK] Backup complete:
echo "%DEST%"
echo.
pause
exit /b 0
