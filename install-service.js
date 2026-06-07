const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const taskName = 'CopilotAgentSupervisor';
const nodePath = process.execPath;
const scriptPath = path.join(__dirname, 'server.js');
const workDir = __dirname;

const psScript = `
$ErrorActionPreference = 'Stop'
$taskName = '${taskName}'
$action = New-ScheduledTaskAction -Execute '${nodePath}' -Argument '"${scriptPath}"' -WorkingDirectory '${workDir}'

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerRepeat) -Settings $settings -Principal $principal -Force

Write-Host "Task '$taskName' created with logon + every-5-min triggers."
Write-Host 'Starting now...'
Start-ScheduledTask -TaskName $taskName
Write-Host 'Service is running at http://localhost:3847'
`;

const psPath = path.join(__dirname, '_install-task.ps1');
fs.writeFileSync(psPath, psScript, 'utf-8');

try {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, { stdio: 'inherit' });
} catch (e) {
  console.error('Failed to create task:', e.message);
  console.error('Try running this from an elevated (admin) terminal.');
} finally {
  try { fs.unlinkSync(psPath); } catch {}
}
