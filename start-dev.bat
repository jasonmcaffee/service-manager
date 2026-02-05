@echo off
title Service Manager (Dev)
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
    call npx prisma generate
    call npx prisma db push
    echo.
)

:: Start the service manager in dev mode
echo Starting Service Manager in development mode...
echo.
npm run dev
