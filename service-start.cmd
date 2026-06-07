@echo off
echo Starting Copilot Agent Supervisor scheduled task...
schtasks /Run /TN "CopilotAgentSupervisor"
timeout /t 3 /nobreak >nul
echo Dashboard: http://localhost:3847
