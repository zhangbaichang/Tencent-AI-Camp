@echo off
setlocal
rem Requires NSSM installed by the server administrator. Does not download executables.
where nssm >nul 2>nul
if errorlevel 1 (
 echo Install NSSM and add it to PATH, then run this file as administrator.
 pause
 exit /b 1
)
for /f "delims=" %%J in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%J"
if not defined NODE_EXE exit /b 1
for %%R in ("%~dp0..\..") do set "APP_ROOT=%%~fR"
nssm install PixelSandbox "%NODE_EXE%" "%APP_ROOT%\server\server.js"
if errorlevel 1 exit /b 1
nssm set PixelSandbox AppDirectory "%APP_ROOT%"
echo Configure OP_PASSWORD in service environment before starting PixelSandbox.
pause
