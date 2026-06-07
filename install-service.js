const path = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name: 'Copilot Agent Supervisor',
  description: 'Manages and schedules Copilot CLI agent sessions',
  script: path.join(__dirname, 'server.js'),
  nodeOptions: [],
  env: [{
    name: 'PORT',
    value: '3847'
  }]
});

svc.on('install', () => {
  console.log('Service installed. Starting...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('Service already installed.');
});

svc.on('start', () => {
  console.log('Service started.');
});

svc.install();
