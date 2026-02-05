@echo off
title Service Manager
cd /d "%~dp0"

:: Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

:: Initialize database if needed
if not exist "prisma\service-manager.db" (
    echo Initializing database...
    call npx prisma db push
    echo.
)

:: Start the service manager and trigger startup services
echo Starting Service Manager...
echo.

:: Start Next.js in production mode
start /b cmd /c "npm run build && npm start"

:: Wait for the server to be ready
echo Waiting for server to start...
timeout /t 5 /nobreak > nul

:: Trigger startup services
echo Starting configured services...
curl -X POST http://localhost:3000/api/services/startup > nul 2>&1

echo.
echo Service Manager is running at http://localhost:3000
echo.
echo Press Ctrl+C to stop
pause > nul
