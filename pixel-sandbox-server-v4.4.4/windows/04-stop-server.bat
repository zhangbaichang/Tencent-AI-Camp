@echo off
setlocal EnableExtensions

title Pixel Sandbox - Stop Server

echo 正在查找 Pixel Sandbox Node.js 服务进程...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*pixel-sandbox*' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('已停止 PID ' + $_.ProcessId) } } else { Write-Host '没有找到 Pixel Sandbox 服务进程。' }"

echo.
echo [提示] 服务器运行日志位于: server\logs\
echo.
pause
exit /b 0
