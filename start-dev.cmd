@echo off
rem Run HDD from source in a normal desktop session.
rem
rem If a launch prints "Electron exited with code 2147483651" (0x80000003), the checkout's files
rem are probably labeled Low integrity, which Electron refuses to start from. Check and repair
rem are in README 3.2 and docs/COMMANDS.md section 8. This launcher also gives the app a
rem double-click entry point, independent of which shell is used.
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
