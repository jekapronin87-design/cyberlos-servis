@echo off
setlocal
cd /d "%~dp0"
title SISTEMNO launcher
echo ================= SISTEMNO =================
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found. Install the LTS version from https://nodejs.org
  echo then RESTART the computer and run this file again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node.js version: %%v
echo.
echo [1/2] Installing components.
echo       First run or after an update: 3-7 minutes. DO NOT CLOSE THIS WINDOW.
echo       Later runs: a few seconds. Lines below may stay quiet for a while - this is normal.
echo.
call npm install --no-audit --no-fund --loglevel=notice --foreground-scripts
if errorlevel 1 (
  echo.
  echo Installation failed. Take a screenshot of this window and send it to your assistant.
  pause
  exit /b 1
)
echo.
echo [2/2] Starting JARVIS. The window will open in about 10-20 seconds...
call npm start
if errorlevel 1 (
  echo.
  echo JARVIS stopped with an error. Take a screenshot of this window and send it to your assistant.
  pause
)
