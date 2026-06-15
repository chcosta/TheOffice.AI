@echo off
echo Stopping existing supervisor...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3847 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo Starting supervisor...
cd /d %~dp0
start "TheOffice.AI" node server.js
timeout /t 3 /nobreak >nul
echo Dashboard: http://localhost:3847
