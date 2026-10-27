@echo off
rem Run HDD from source in a normal desktop session.
rem
rem Double-click this file in Explorer (or run it from a plain Windows Terminal) when a terminal
rem reports "Electron exited with code 2147483651": that code means the terminal could not create
rem a window, which is what a process started inside the DSH sandbox gets.
rem
rem Arguments are passed through, so "start-dev.cmd --fresh" starts from a clean scratch store.

setlocal
cd /d "%~dp0app"

node scripts\dev.cjs %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" exit /b 0

echo.
echo HDD did not start. Read the message above.
pause
exit /b %RC%
