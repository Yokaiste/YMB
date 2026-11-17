@echo off
setlocal EnableExtensions
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0.github\scripts\dev-launch.ps1" %*
exit /b %errorlevel%
