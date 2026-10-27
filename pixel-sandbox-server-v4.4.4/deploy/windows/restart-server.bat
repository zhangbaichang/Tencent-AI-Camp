@echo off
setlocal
where nssm >nul 2>nul
if errorlevel 1 (
 echo For a console server, press Ctrl+C in its window and run start-server.bat.
 pause
 exit /b 1
)
nssm restart PixelSandbox
pause
