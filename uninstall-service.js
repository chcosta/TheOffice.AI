const { execSync } = require('child_process');

const taskName = 'CopilotAgentSupervisor';

try {
  execSync(`schtasks /End /TN "${taskName}"`, { stdio: 'inherit' });
} catch {}

try {
  execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: 'inherit' });
  console.log(`Task "${taskName}" removed.`);
} catch (e) {
  console.error('Failed to remove task:', e.message);
}
