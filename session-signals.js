'use strict';

const fs = require('fs');
const path = require('path');

function parseYamlSimple(text) {
  const obj = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.+)/);
    if (m) obj[m[1]] = m[2].trim();
  }
  return obj;
}

function readSessionMeta(sessionDir) {
  const wsPath = path.join(sessionDir, 'workspace.yaml');
  if (!fs.existsSync(wsPath)) return null;
  const yaml = parseYamlSimple(fs.readFileSync(wsPath, 'utf-8'));
  return {
    id: yaml.id || path.basename(sessionDir),
    name: yaml.name || '(unnamed)',
    cwd: yaml.cwd || '',
    repository: yaml.repository || '',
    branch: yaml.branch || '',
    client: yaml.client_name || '',
    createdAt: yaml.created_at || '',
    updatedAt: yaml.updated_at || '',
  };
}

let cache = null;

async function list(sessionStateDir) {
  const now = Date.now();
  if (cache && cache.dir === sessionStateDir && now - cache.at < 30000) return cache.value;
  const candidates = [];
  let entries;
  try { entries = await fs.promises.readdir(sessionStateDir, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  // A large CLI history can contain tens of thousands of directories. Keep
  // filesystem concurrency bounded, and do this only in the probe worker.
  for (let offset = 0; offset < entries.length; offset += 32) {
    await Promise.all(entries.slice(offset, offset + 32).map(async entry => {
      if (!entry.isDirectory()) return;
      const dir = path.join(sessionStateDir, entry.name);
      const eventsPath = path.join(dir, 'events.jsonl');
      let stat;
      try { stat = await fs.promises.stat(eventsPath); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
        throw error;
      }
      const age = now - stat.mtimeMs;
      if (age < 0 || age > 8 * 60 * 60 * 1000) return;
      candidates.push({ id: entry.name, dir, eventsPath, stat });
    }));
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const signals = await Promise.all(candidates.slice(0, 8).map(async candidate => {
    const meta = readSessionMeta(candidate.dir);
    if (!meta) return null;
    let ended = false;
    let proactivelyInteractive = String(meta.client || '').toLowerCase() === 'github/autopilot';
    const length = Math.min(candidate.stat.size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const handle = await fs.promises.open(candidate.eventsPath, 'r');
    let bytesRead;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, Math.max(0, candidate.stat.size - length)));
    } finally {
      await handle.close();
    }
    const events = buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(1).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const decisive = [...events].reverse()
      .find(event => ['session.shutdown', 'session.resume', 'user.message', 'assistant.message'].includes(event.type));
    proactivelyInteractive = proactivelyInteractive || events.some(event =>
      event.type === 'user.message' && event.data &&
      (event.data.messageId || event.data.delivery || event.data.turnId));
    ended = decisive && decisive.type === 'session.shutdown';
    if (ended || !proactivelyInteractive) return null;
    const lastModified = candidate.stat.mtime.toISOString();
    const active = now - candidate.stat.mtimeMs <= 10 * 60 * 1000;
    const fingerprint = `session|${meta.id || candidate.id}`;
    const repository = meta.repository || (meta.cwd ? path.basename(meta.cwd) : '');
    const sessionName = String(meta.name || '').trim();
    const title = sessionName && sessionName !== '(unnamed)' && !/^\|[-+>]?$/.test(sessionName)
      ? sessionName
      : [repository, meta.branch].filter(Boolean).join(' · ') || 'Copilot work';
    return {
      id: fingerprint, fingerprint, reminderKey: fingerprint, kind: 'session',
      title: active ? `${title} is active` : `Continue ${title}`,
      detail: active ? 'Pixel is following this Copilot session.' : 'This session was active recently and may be worth resuming.',
      priority: active ? 'normal' : 'low',
      source: ['Copilot session', repository, meta.branch].filter(Boolean).join(' · '),
      route: '#/sessions', trackedAt: lastModified, repository, sessionId: meta.id || candidate.id,
      context: {
        state: active ? 'active' : 'idle', repository, branch: meta.branch || '',
        sessionId: meta.id || candidate.id, lastActivityAt: lastModified,
      },
    };
  }));
  const value = signals.filter(Boolean);
  cache = { dir: sessionStateDir, at: Date.now(), value };
  return value;
}

module.exports = { list, readSessionMeta };
