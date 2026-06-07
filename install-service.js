const path = require('path');
const { execSync } = require('child_process');

const taskName = 'CopilotAgentSupervisor';
const nodePath = process.execPath;
const scriptPath = path.join(__dirname, 'server.js');

// Use PowerShell to create a scheduled task with multiple triggers:
// 1. At logon
// 2. Every 5 minutes (with "do not start a new instance if already running")
// This ensures the service restarts after sleep/crash.
const ps = `
$taskName = '${taskName}'
$action = New-ScheduledTaskAction -Execute '"${nodePath}"' -Argument '"${scriptPath}"' -WorkingDirectory '${__dirname}'

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerRepeat) -Settings $settings -Principal $principal -Force

Write-Host "Task '$taskName' created with logon + every-5-min triggers."
Write-Host 'Starting now...'
Start-ScheduledTask -TaskName $taskName
Write-Host 'Service is running at http://localhost:3847'
`;

try {
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
} catch (e) {
  // Fallback to simple schtasks if PowerShell fails
  console.error('PowerShell method failed, trying schtasks fallback...');
  try {
    const cmd = `schtasks /Create /TN "${taskName}" /TR "\\"${nodePath}\\" \\"${scriptPath}\\"" /SC ONLOGON /RL LIMITED /F`;
    execSync(cmd, { stdio: 'inherit' });
    execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'inherit' });
    console.log('Service is running at http://localhost:3847 (logon trigger only)');
  } catch (e2) {
    console.error('Failed to create task:', e2.message);
    console.error('Try running this from an elevated (admin) terminal.');
  }
}
