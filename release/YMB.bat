@echo off
setlocal
set "YMB_HOME=%~dp0"
call "%YMB_HOME%app\resolve-bun.cmd"
if errorlevel 1 exit /b 1

if "%~1"=="" goto shell

"%YMB_BUN%" "%YMB_HOME%app\ymb.js" %*
set "YMB_EXIT_CODE=%errorlevel%"
endlocal & exit /b %YMB_EXIT_CODE%

:shell
endlocal
cmd.exe /D /K call "%~dp0app\shell-init.cmd"
