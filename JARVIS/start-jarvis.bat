@echo off
setlocal
cd /d "%~dp0"
echo ===== JARVIS =====
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found. Install the LTS version from https://nodejs.org
  echo then RESTART the computer and run this file again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing components. This takes a few minutes, please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo Installation failed. Take a screenshot of this window and send it to your assistant.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
