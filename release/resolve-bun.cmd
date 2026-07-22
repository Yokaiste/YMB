@echo off
call "%YMB_HOME%\app\release-info.cmd"
set "YMB_BUN="
set "YMB_ACTUAL_BUN="

if exist "%YMB_HOME%\runtime\bun.exe" set "YMB_BUN=%YMB_HOME%\runtime\bun.exe"
if defined YMB_BUN goto check_version

for /f "delims=" %%I in ('where.exe bun.exe 2^>nul') do if not defined YMB_BUN set "YMB_BUN=%%I"
if not defined YMB_BUN goto missing_bun

:check_version
for /f "delims=" %%V in ('"%YMB_BUN%" --version 2^>nul') do if not defined YMB_ACTUAL_BUN set "YMB_ACTUAL_BUN=%%V"
if not "%YMB_ACTUAL_BUN%"=="%YMB_REQUIRED_BUN%" goto wrong_bun
exit /b 0

:missing_bun
echo.
echo YMB needs Bun %YMB_REQUIRED_BUN%, but bun.exe was not found on PATH.
echo Download the recommended full YMB archive, which includes the correct Bun runtime:
echo %YMB_FULL_RELEASE_URL%
echo.
exit /b 1

:wrong_bun
echo.
echo YMB needs Bun %YMB_REQUIRED_BUN%, but found %YMB_ACTUAL_BUN% at:
echo %YMB_BUN%
echo Download the recommended full YMB archive, which includes the correct Bun runtime:
echo %YMB_FULL_RELEASE_URL%
echo.
exit /b 1
