@echo off
chcp 936 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion
title Pixel Sandbox 一键启动工具 (V4.4.4)

set "ROOT=%~dp0"
set "SERVER=%ROOT%server"
set "LOGDIR=%SERVER%\logs"
set "PORT=8080"

rem 无参数进入菜单；带参数直接执行对应命令
if "%~1"=="" goto menu
if /i "%~1"=="install"  goto cmd_install
if /i "%~1"=="start"    goto cmd_start
if /i "%~1"=="startbg"  goto cmd_startbg
if /i "%~1"=="stop"     goto cmd_stop
if /i "%~1"=="restart"  goto cmd_restart
if /i "%~1"=="status"   goto cmd_status
if /i "%~1"=="backup"   goto cmd_backup
if /i "%~1"=="frp"      goto cmd_frp
if /i "%~1"=="env"      goto cmd_env
echo [ERROR] 未知命令: %1
echo 可用: install start startbg stop restart status backup frp env
pause
goto :eof

:menu
cls
echo ========================================
echo   Pixel Sandbox 一键启动工具 (V4.4.4)
echo ========================================
echo.
echo   [1] 安装依赖 (npm install)
echo   [2] 启动服务器 (前台，关闭窗口即停止)
echo   [3] 启动服务器 (后台新窗口)
echo   [4] 停止服务器
echo   [5] 重启服务器
echo   [6] 查看运行状态
echo   [7] 备份世界
echo   [8] 检查 SakuraFrp 公网地址
echo   [9] 环境检测
echo   [0] 退出
echo.
set "C="
set /p "C=请选择 [0-9]: "
if not defined C goto menu
if "%C%"=="1" ( call :cmd_install & goto menu )
if "%C%"=="2" ( call :cmd_start   & goto menu )
if "%C%"=="3" ( call :cmd_startbg & goto menu )
if "%C%"=="4" ( call :cmd_stop    & goto menu )
if "%C%"=="5" ( call :cmd_restart & goto menu )
if "%C%"=="6" ( call :cmd_status  & goto menu )
if "%C%"=="7" ( call :cmd_backup  & goto menu )
if "%C%"=="8" ( call :cmd_frp     & goto menu )
if "%C%"=="9" ( call :cmd_env     & goto menu )
if "%C%"=="0" goto :eof
goto menu

:cmd_install
where node >nul 2>&1 || (echo [ERROR] 找不到 Node.js & pause & goto :eof)
where npm  >nul 2>&1 || (echo [ERROR] 找不到 npm & pause & goto :eof)
if not exist "%SERVER%\package.json" (echo [ERROR] 找不到 server\package.json & pause & goto :eof)
echo [INFO] 进入 %SERVER% 执行 npm install...
cd /d "%SERVER%" && call npm install
echo [OK] 依赖安装完成。
goto :eof

:cmd_start
if not exist "%SERVER%\server.js" (echo [ERROR] 找不到 server\server.js & pause & goto :eof)
if not exist "%SERVER%\node_modules\ws" (echo [WARN] 依赖未安装，请先选 [1] 安装依赖。 & pause & goto :eof)
cd /d "%SERVER%"
echo ========================================
echo Pixel Sandbox Server (V4.4.4)
echo 监听: 0.0.0.0:%PORT%
echo 日志: %LOGDIR%\
echo ========================================
echo [提示] 保持窗口打开 = 运行中；Ctrl+C 或关闭窗口 = 停止。
call node server.js
echo 服务器已退出，退出码 = %errorlevel%
pause
goto :eof

:cmd_startbg
if not exist "%SERVER%\server.js" (echo [ERROR] 找不到 server\server.js & pause & goto :eof)
if not exist "%SERVER%\node_modules\ws" (echo [WARN] 依赖未安装，请先选 [1]。 & pause & goto :eof)
start "Pixel Sandbox Server (V4.4.4)" /D "%SERVER%" cmd /k "node server.js"
echo [OK] 已在后台新窗口启动。日志: %LOGDIR%\
goto :eof

:cmd_stop
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('已停止 PID ' + $_.ProcessId) } } else { Write-Host '没有找到 Pixel Sandbox 服务进程。' }"
goto :eof

:cmd_restart
call :cmd_stop
timeout /t 1 >nul
call :cmd_startbg
echo [OK] 已重启。
goto :eof

:cmd_status
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' }; if ($p) { Write-Host ('[OK] 服务运行中，PID: ' + ($p.ProcessId -join ', ')) } else { Write-Host '[INFO] 服务未运行。' }"
goto :eof

:cmd_backup
if not exist "%SERVER%\world" (echo [ERROR] 找不到 world 目录: %SERVER%\world & pause & goto :eof)
set "BACKUP=%ROOT%world_backup"
if not exist "%BACKUP%" mkdir "%BACKUP%"
for /f "tokens=1-3 delims=/- " %%a in ("%date%") do set "DS=%%a-%%b-%%c"
set "DEST=%BACKUP%\%DS%"
if exist "%DEST%" (
  set "DEST=%BACKUP%\%DS%_%time:~0,2%%time:~3,2%%time:~6,2%"
  set "DEST=%DEST: =0%"
)
mkdir "%DEST%" 2>nul
xcopy "%SERVER%\world\*" "%DEST%\" /E /I /Y >nul
if errorlevel 1 (echo [ERROR] 世界备份失败。 & pause & goto :eof)
echo [OK] 备份完成: %DEST%
goto :eof

:cmd_frp
if not exist "%SERVER%\sakura-frp.js" (echo [ERROR] 找不到 server\sakura-frp.js & pause & goto :eof)
where node >nul 2>&1 || (echo [ERROR] 找不到 Node.js & pause & goto :eof)
cd /d "%SERVER%"
echo ========================================
echo SakuraFrp Public Address Check
echo ========================================
call node -e "const m=require('./sakura-frp'); console.log(JSON.stringify(m.getPublicAddressInfo(),null,2))"
goto :eof

:cmd_env
where node >nul 2>&1 || (echo [ERROR] 找不到 Node.js & pause & goto :eof)
where npm  >nul 2>&1 || (echo [ERROR] 找不到 npm & pause & goto :eof)
echo Node.js:
call node -v
echo.
echo npm:
call npm -v
echo.
echo [OK] 环境检查完成。
goto :eof
