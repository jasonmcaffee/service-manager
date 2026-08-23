@echo off
title Service Manager
cd /d "%~dp0"
cd C:\jason\dev\service-manager

:: Start the service manager and trigger startup services
echo Starting Service Manager...
echo.

:: A production UI build must exist because the Rust manager serves the exported
:: Next app directly. .next\BUILD_ID proves this is a production build rather than
:: output left behind by `next dev`. NODE_ENV is pinned because an inherited
:: non-standard value makes next build emit a broken dev/prod runtime mix.
if not exist ".next\BUILD_ID" (
    echo No production build found - building ^(this takes a minute^)...
    set NODE_ENV=production
    call npm run build
    echo.
)

:: The native binary is built independently when the UI build already exists.
if not exist "rust\target\release\service-manager-rs.exe" (
    echo No Rust Service Manager build found - building...
    call npm run build:rust
    echo.
)

:: Start the native Service Manager on port 4000.
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
