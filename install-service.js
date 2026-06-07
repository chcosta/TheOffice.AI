const path = require('path');
const { execSync } = require('child_process');

const taskName = 'CopilotAgentSupervisor';
const nodePath = process.execPath;
const scriptPath = path.join(__dirname, 'server.js');

// Create a scheduled task that runs as the current user at logon
const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${nodePath}</Command>
      <Arguments>"${scriptPath}"</Arguments>
      <WorkingDirectory>${__dirname}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

const fs = require('fs');
const xmlPath = path.join(__dirname, 'task.xml');
fs.writeFileSync(xmlPath, xml, 'utf-16le');

try {
  execSync(`schtasks /Create /TN "${taskName}" /XML "${xmlPath}" /F`, { stdio: 'inherit' });
  console.log(`\nTask "${taskName}" created. It will start at logon.`);
  console.log('Starting now...');
  execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'inherit' });
  console.log('Service is running at http://localhost:3847');
} catch (e) {
  console.error('Failed to create task:', e.message);
  console.error('Try running this from an elevated (admin) terminal.');
} finally {
  fs.unlinkSync(xmlPath);
}
