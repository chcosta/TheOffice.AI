@echo off
echo Starting Copilot Agent Supervisor...
REM Register task if it doesn't exist (requires admin first time only)
schtasks /Query /TN "CopilotAgentSupervisor" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo First run - registering scheduled task...
    cd /d %~dp0
    node install-service.js
)
schtasks /Run /TN "CopilotAgentSupervisor"
timeout /t 3 /nobreak >nul
echo Dashboard: http://localhost:3847
