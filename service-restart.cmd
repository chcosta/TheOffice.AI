@echo off
echo Restarting Copilot Agent Supervisor...
schtasks /End /TN "CopilotAgentSupervisor" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3847 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul
cd /d %~dp0
wscript.exe launch-hidden.vbs
timeout /t 3 /nobreak >nul
echo Dashboard: http://localhost:3847
