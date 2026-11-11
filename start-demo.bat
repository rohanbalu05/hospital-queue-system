@echo off
REM ==========================================================================
REM  HQMS one-click local demo (Windows)
REM  Needs: Node.js 22+, pnpm 10 (npm install -g pnpm@10.28.0), PostgreSQL 16
REM  running on localhost:5432 with user postgres.
REM  Every launch RESETS the demo data so "today" is always the current date.
REM ==========================================================================
setlocal
cd /d "%~dp0"
title HQMS demo - keep this window open

REM ---- Change this if you chose a different PostgreSQL password ----
set "DB_PASSWORD=postgres"

set "DATABASE_URL=postgres://postgres:%DB_PASSWORD%@localhost:5432/hqms"
set "TEST_DATABASE_URL=postgres://postgres:%DB_PASSWORD%@localhost:5432/hqms_test"
set "NODE_ENV=development"
set "PORT=3000"
REM API and worker must share ONE upload folder (each package runs from its own directory).
set "STORAGE_DIR=%~dp0var\storage"
if not exist "%STORAGE_DIR%" mkdir "%STORAGE_DIR%"

where node >nul 2>nul || (echo [x] Node.js not found. Install: winget install -e --id OpenJS.NodeJS.LTS & goto :fail)
where pnpm >nul 2>nul || (echo [x] pnpm not found. Run: npm install -g pnpm@10.28.0 & goto :fail)

echo.
echo [1/4] Installing packages (first run takes a few minutes)...
call pnpm install
if errorlevel 1 goto :fail

echo.
echo [2/4] Resetting demo data for today (PostgreSQL on localhost:5432)...
call pnpm db:reset
if errorlevel 1 (
  echo [x] Could not reach PostgreSQL. Check it is running ^(Services: postgresql-x64-16^)
  echo     and that DB_PASSWORD at the top of this file matches your postgres password.
  goto :fail
)

echo.
echo [3/4] Starting API :3000, worker and web :5173 ...
echo       The browser opens in about 30 seconds. Close this window to stop everything.
REM Outside 09:00-17:30 IST this creates a session running "now" so the demo works at any hour.
start "HQMS demo session" /min cmd /c "node scripts\demo-session-now.mjs & timeout /t 5 >nul"
start "" /min cmd /c "timeout /t 30 >nul & start http://localhost:5173"

echo.
echo [4/4] Logs follow. Demo logins (password demo1234):
echo       reception@hqms.test  doctor@hqms.test  patient@hqms.test  followup@hqms.test  admin@hqms.test
echo       Waiting-room display: http://localhost:5173/display
echo.
call pnpm dev
goto :eof

:fail
echo.
echo Setup stopped. Fix the message above, then double-click start-demo.bat again.
pause
exit /b 1
