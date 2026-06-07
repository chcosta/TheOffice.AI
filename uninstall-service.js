const path = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name: 'Copilot Agent Supervisor',
  script: path.join(__dirname, 'server.js')
});

svc.on('uninstall', () => {
  console.log('Service uninstalled.');
});

svc.uninstall();
