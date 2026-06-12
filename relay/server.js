'use strict';

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// API keys — in production these would be in Azure Key Vault or env vars
// For now, we'll generate one at startup and also accept any configured ones
const API_KEYS = new Set();
const ADMIN_KEY = process.env.RELAY_ADMIN_KEY || crypto.randomBytes(32).toString('hex');
API_KEYS.add(ADMIN_KEY);

// Device pairing tokens: token → { userId, deviceName, createdAt }
const pairedDevices = new Map();

console.log(`[relay] Admin key: ${ADMIN_KEY.slice(0, 8)}...`);

// Simple API key validation
function validateApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = authHeader.slice(7);
  
  // Check admin key
  if (API_KEYS.has(token)) {
    req.authType = 'admin';
    req.deviceId = 'server';
    return next();
  }

  // Check paired device tokens
  if (pairedDevices.has(token)) {
    req.authType = 'device';
    req.deviceInfo = pairedDevices.get(token);
    req.deviceId = req.deviceInfo.userId;
    return next();
  }

  return res.status(401).json({ error: 'Invalid API key' });
}

// --- Routes ---

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'agent-supervisor-relay' });
});

// Pair a new device — called by the server when generating QR code
app.post('/api/pair', validateApiKey, (req, res) => {
  if (req.authType !== 'admin') {
    return res.status(403).json({ error: 'Only admin can pair devices' });
  }

  const { userId, deviceName } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const deviceToken = crypto.randomBytes(32).toString('hex');
  pairedDevices.set(deviceToken, {
    userId,
    deviceName: deviceName || 'unknown',
    createdAt: new Date().toISOString(),
  });

  console.log(`[relay] Paired device for ${userId} (${deviceName})`);
  res.json({ deviceToken, userId });
});

// Auth test — validates token and returns info
app.get('/api/auth-test', validateApiKey, (req, res) => {
  res.json({
    status: 'authenticated',
    authType: req.authType,
    deviceId: req.deviceId,
    deviceInfo: req.deviceInfo || null,
  });
});

// --- Message relay ---
const messageQueues = new Map(); // key → messages[]

// Phone sends a message to the server
app.post('/api/messages/send', validateApiKey, (req, res) => {
  const message = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: req.deviceId,
    body: req.body,
    timestamp: new Date().toISOString(),
  };

  if (!messageQueues.has('inbound')) messageQueues.set('inbound', []);
  messageQueues.get('inbound').push(message);

  const q = messageQueues.get('inbound');
  if (q.length > 100) q.splice(0, q.length - 100);

  console.log(`[relay] Inbound from ${req.deviceId}: ${JSON.stringify(req.body).slice(0, 80)}`);
  res.json({ status: 'queued', messageId: message.id });
});

// Server polls for inbound messages from devices
app.get('/api/messages/receive', validateApiKey, (req, res) => {
  if (req.authType !== 'admin') {
    return res.status(403).json({ error: 'Only server can receive inbound messages' });
  }
  const queue = messageQueues.get('inbound') || [];
  const messages = queue.splice(0, 10);
  res.json({ messages });
});

// Server sends reply to a specific device
app.post('/api/messages/reply', validateApiKey, (req, res) => {
  if (req.authType !== 'admin') {
    return res.status(403).json({ error: 'Only server can send replies' });
  }

  const { targetDeviceId, body, correlationId } = req.body;
  if (!targetDeviceId || !body) {
    return res.status(400).json({ error: 'targetDeviceId and body required' });
  }

  const reply = {
    id: `rpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    body,
    correlationId,
    timestamp: new Date().toISOString(),
  };

  const key = `outbound-${targetDeviceId}`;
  if (!messageQueues.has(key)) messageQueues.set(key, []);
  messageQueues.get(key).push(reply);

  const q = messageQueues.get(key);
  if (q.length > 100) q.splice(0, q.length - 100);

  res.json({ status: 'sent', replyId: reply.id });
});

// Phone polls for replies
app.get('/api/messages/poll', validateApiKey, (req, res) => {
  const key = `outbound-${req.deviceId}`;
  const queue = messageQueues.get(key) || [];
  const messages = queue.splice(0, 10);
  res.json({ messages });
});

// List paired devices (admin only)
app.get('/api/devices', validateApiKey, (req, res) => {
  if (req.authType !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const devices = [];
  for (const [token, info] of pairedDevices) {
    devices.push({ tokenPrefix: token.slice(0, 8) + '...', ...info });
  }
  res.json({ devices });
});

app.listen(PORT, () => {
  console.log(`[relay] Agent Supervisor Relay running on port ${PORT}`);
  console.log(`[relay] Use RELAY_ADMIN_KEY env var to set a persistent admin key`);
});
