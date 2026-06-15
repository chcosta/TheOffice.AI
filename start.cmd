@echo off
cd /d %~dp0
echo Starting supervisor...
start "TheOffice.AI" node server.js
timeout /t 3 /nobreak >nul
echo Dashboard: http://localhost:3847
