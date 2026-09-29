@echo off
rem Double-click to start. First run installs dependencies (a few minutes).
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies. Please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)
echo.
echo Starting... the browser will open http://localhost:5173
echo To stop, close this window.
echo.
call npm run dev -- --open
pause
