@echo off
echo Restarting Copilot Agent Supervisor...
schtasks /End /TN "CopilotAgentSupervisor" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3847 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul
REM Register task if it doesn't exist (requires admin first time only)
schtasks /Query /TN "CopilotAgentSupervisor" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo First run - registering scheduled task...
    cd /d %~dp0
    node install-service.js
)
schtasks /Run /TN "CopilotAgentSupervisor"
echo Waiting for service to start...
timeout /t 4 /nobreak >nul
echo.
echo === Deployed Version ===
curl -s http://localhost:3847/api/version 2>nul
echo.
echo.
echo Dashboard: http://localhost:3847
