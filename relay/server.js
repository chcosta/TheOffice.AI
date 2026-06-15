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
// NOTE: this Map is now only a best-effort registry for /api/devices listing
// and backward-compat with any legacy (pre-signed) tokens still circulating.
// Validation no longer depends on it — device tokens are self-verifying (see
// signDeviceToken/verifyDeviceToken), so they survive relay restarts, new
// revisions, and scale-out across replicas.
const pairedDevices = new Map();

// Stateless device tokens are HMAC-signed with TOKEN_SECRET so ANY replica can
// validate them without shared state and they outlive relay restarts/redeploys.
// Defaults to ADMIN_KEY, which is already required to be a stable env value for
// the server↔relay link to work, so no new secret is needed. Set
// RELAY_TOKEN_SECRET to rotate device tokens independently of the admin key.
const TOKEN_SECRET = process.env.RELAY_TOKEN_SECRET || ADMIN_KEY;

function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
// Token format: v2.<base64url(payloadJSON)>.<base64url(HMAC-SHA256(payload))>
function signDeviceToken(payload) {
  const body = _b64url(JSON.stringify(payload));
  const sig = _b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest());
  return `v2.${body}.${sig}`;
}
function verifyDeviceToken(token) {
  if (typeof token !== 'string' || !token.startsWith('v2.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const body = parts[1];
  const expected = _b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest());
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(_b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
}

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

  // Stateless signed device token — self-verifying, no shared state required,
  // so it survives relay restarts/redeploys and works across replicas.
  const signed = verifyDeviceToken(token);
  if (signed) {
    req.authType = 'device';
    req.deviceInfo = signed;
    req.deviceId = signed.userId;
    return next();
  }

  // Legacy in-memory device tokens (issued before signed tokens). Valid only
  // until this replica restarts; kept for backward-compat during rollout.
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

  const createdAt = new Date().toISOString();
  const deviceInfo = { userId, deviceName: deviceName || 'unknown', createdAt };
  // Self-verifying signed token (survives restarts & scale-out).
  const deviceToken = signDeviceToken(deviceInfo);
  // Best-effort registry for /api/devices visibility this session; validation
  // does NOT depend on this surviving.
  pairedDevices.set(deviceToken, deviceInfo);

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

// Phone sends a message to the server.
// Messages are routed to a per-machine inbound queue based on body.targetMachineId
// so each device deterministically reaches the machine it has chosen as its
// "listener". Messages with no target (or the legacy '__leader__' sentinel) go
// to the shared default queue, which is drained by whichever machine polls first
// — those are idempotent bootstrap reads (list-machines / get-status) before a
// device has picked a listener, so any alive machine can answer.
app.post('/api/messages/send', validateApiKey, (req, res) => {
  const message = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: req.deviceId,
    body: req.body,
    timestamp: new Date().toISOString(),
  };

  const target = req.body && req.body.targetMachineId;
  const key = (target && target !== '__leader__') ? `inbound-${target}` : 'inbound';
  if (!messageQueues.has(key)) messageQueues.set(key, []);
  messageQueues.get(key).push(message);

  const q = messageQueues.get(key);
  if (q.length > 100) q.splice(0, q.length - 100);

  console.log(`[relay] Inbound from ${req.deviceId} → ${key}: ${JSON.stringify(req.body).slice(0, 80)}`);
  res.json({ status: 'queued', messageId: message.id });
});

// Server polls for inbound messages from devices.
//   ?machineId=X  — drain that machine's dedicated queue (inbound-X)
// Every poller also drains the shared default queue (unrouted bootstrap reads).
// A message is spliced out by whichever machine grabs it first, so a single
// default-queue message is still answered exactly once.
app.get('/api/messages/receive', validateApiKey, (req, res) => {
  if (req.authType !== 'admin') {
    return res.status(403).json({ error: 'Only server can receive inbound messages' });
  }
  const machineId = req.query.machineId ? String(req.query.machineId) : null;
  const messages = [];

  if (machineId) {
    const q = messageQueues.get(`inbound-${machineId}`);
    if (q && q.length) messages.push(...q.splice(0, 10));
  }
  // Shared default queue: unrouted / legacy '__leader__' bootstrap reads,
  // answered by whichever alive machine polls first.
  const dq = messageQueues.get('inbound');
  if (dq && dq.length) messages.push(...dq.splice(0, Math.max(0, 10 - messages.length)));

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
  console.log(`[relay] TheOffice.AI Relay running on port ${PORT}`);
  console.log(`[relay] Use RELAY_ADMIN_KEY env var to set a persistent admin key`);
});
