@echo off
echo Starting Copilot Agent Supervisor...
cd /d %~dp0
wscript.exe launch-hidden.vbs
timeout /t 3 /nobreak >nul
echo Dashboard: http://localhost:3847
