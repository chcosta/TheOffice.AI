@echo off
echo Stopping TheOffice.AI...
schtasks /End /TN "CopilotAgentSupervisor" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3847 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo Stopped.
