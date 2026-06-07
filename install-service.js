const path = require('path');
const { execSync } = require('child_process');

const taskName = 'CopilotAgentSupervisor';
const nodePath = process.execPath;
const scriptPath = path.join(__dirname, 'server.js');

try {
  // Create a scheduled task that runs at logon as the current user
  const cmd = `schtasks /Create /TN "${taskName}" /TR "\\"${nodePath}\\" \\"${scriptPath}\\"" /SC ONLOGON /RL LIMITED /F`;
  console.log('Running:', cmd);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\nTask "${taskName}" created. It will start at logon.`);
  console.log('Starting now...');
  execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'inherit' });
  console.log('Service is running at http://localhost:3847');
} catch (e) {
  console.error('Failed to create task:', e.message);
  console.error('Try running this from an elevated (admin) terminal.');
}
