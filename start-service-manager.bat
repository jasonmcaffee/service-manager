@echo off
title Service Manager
cd /d "%~dp0"
cd C:\jason\dev\service-manager

:: Start the service manager and trigger startup services
echo Starting Service Manager...
echo.

:: Start Next.js in production mode (port 4000)
start /b cmd /c "npm start"

:: Wait for the server to be ready
echo Waiting for server to start...
timeout /t 5 /nobreak > nul

:: Trigger startup services
echo Starting configured services...
curl -X POST http://localhost:4000/api/services/startup > nul 2>&1

:: Open browser
echo Opening browser...
start "" http://localhost:4000

echo.
echo Service Manager is running at http://localhost:4000
echo.
echo Press Ctrl+C to stop
pause > nul
