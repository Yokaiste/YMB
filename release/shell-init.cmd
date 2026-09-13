@echo off
for %%I in ("%~dp0..") do set "YMB_HOME=%%~fI"
set "YMB_CLI=%YMB_HOME%\app\ymb.js"
cd /d "%YMB_HOME%"
call "%YMB_HOME%\app\resolve-bun.cmd"
if errorlevel 1 exit /b 1

doskey help="%YMB_BUN%" "%YMB_CLI%" help $*
doskey version="%YMB_BUN%" "%YMB_CLI%" --version $*
doskey init="%YMB_BUN%" "%YMB_CLI%" init $*
doskey doctor="%YMB_BUN%" "%YMB_CLI%" doctor $*
doskey validate="%YMB_BUN%" "%YMB_CLI%" validate $*
doskey list="%YMB_BUN%" "%YMB_CLI%" list $*
doskey explain="%YMB_BUN%" "%YMB_CLI%" explain $*
doskey find="%YMB_BUN%" "%YMB_CLI%" find $*
doskey build="%YMB_BUN%" "%YMB_CLI%" build $*
doskey sync="%YMB_BUN%" "%YMB_CLI%" sync $*
doskey recover="%YMB_BUN%" "%YMB_CLI%" recover $*
doskey cleanup="%YMB_BUN%" "%YMB_CLI%" cleanup $*
doskey ymb="%YMB_BUN%" "%YMB_CLI%" $*

prompt [YMB] $P$G
echo YMB portable shell. Type help at any time; type exit to close.
"%YMB_BUN%" "%YMB_CLI%" --help
