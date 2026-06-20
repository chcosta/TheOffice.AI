// Best-effort "is this MCP server usable on my machine?" probe.
//
// Given a resolved server config ({ command, args, env } for stdio, or { url }
// for HTTP/SSE), we actually try to start it the same way the agent runtime
// would and classify the outcome so the UI can tell the user whether a
// dependency is missing, the handshake works, or it needs a secret/input.
//
// Classifications (status):
//   ok       - completed an MCP `initialize` handshake (server is usable)
//   started  - process stayed alive but didn't answer the handshake in time
//              (may still be downloading deps, or uses a different transport)
//   missing  - the base command isn't on PATH (a runtime/dep needs installing)
//   error    - the process exited quickly (bad config, crash); stderr included
//   needs-input - config references ${input:...}/unset env we can't supply here
//   url      - HTTP/SSE endpoint reachability result
//   unknown  - nothing to test

const { spawn } = require('child_process');

const HANDSHAKE_TIMEOUT_MS = 15000;
const URL_TIMEOUT_MS = 8000;

// Resolve ${env:NAME} placeholders from a merged env; flag ${input:...} which
// we cannot satisfy in a non-interactive probe.
function interpolate(value, env) {
  let needsInput = false;
  const out = String(value).replace(/\$\{(env|input):([^}]+)\}/g, (m, kind, key) => {
    if (kind === 'env') return env[key] != null ? String(env[key]) : '';
    needsInput = true;
    return m;
  });
  return { out, needsInput };
}

function tail(s, n = 1200) {
  s = String(s || '');
  return s.length > n ? '…' + s.slice(-n) : s;
}

function isMissingCommand(err, code, stderr) {
  if (err && (err.code === 'ENOENT')) return true;
  const t = String(stderr || '').toLowerCase();
  // Windows shell + *nix shell "command not found" phrasings.
  return /is not recognized as an internal or external command|command not found|no such file or directory/.test(t);
}

function testStdio(cfg) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, cfg.env || {});
    let needsInput = false;
    const ci = interpolate(cfg.command, env); needsInput = needsInput || ci.needsInput;
    const command = ci.out;
    const args = (cfg.args || []).map((a) => { const r = interpolate(a, env); needsInput = needsInput || r.needsInput; return r.out; });
    const cmdline = [command, ...args].join(' ');

    let child, settled = false, stdout = '', stderr = '', buf = '';
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { child && child.kill(); } catch {} resolve(Object.assign({ command: cmdline }, r)); };

    let timer = setTimeout(() => {
      // Alive but silent: likely downloading deps or non-stdio transport.
      finish({ status: 'started', summary: 'Started but no MCP handshake within ' + (HANDSHAKE_TIMEOUT_MS / 1000) + 's', detail: 'The process launched and is still running but did not answer an `initialize` request. It may be downloading dependencies, waiting on input, or using a non-stdio transport.', stderr: tail(stderr) });
    }, HANDSHAKE_TIMEOUT_MS);

    try {
      child = spawn(command, args, { env, shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ status: 'missing', summary: 'Could not start "' + command + '"', detail: String(e && e.message || e) });
    }

    child.on('error', (err) => {
      if (isMissingCommand(err)) finish({ status: 'missing', summary: 'Command "' + command + '" was not found', detail: 'Install the runtime it needs (e.g. Node/npx, uv/uvx, Python, Docker) and make sure it is on your PATH.' });
      else finish({ status: 'error', summary: 'Failed to start', detail: String(err && err.message || err) });
    });

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.id === 1 && msg.result) {
            const info = msg.result.serverInfo || {};
            const proto = msg.result.protocolVersion || '';
            finish({ status: 'ok', summary: 'Handshake OK' + (info.name ? ' · ' + info.name : ''), detail: 'Completed an MCP initialize handshake' + (proto ? ' (protocol ' + proto + ')' : '') + '. The server is usable on this machine.', server: info, stderr: tail(stderr) });
            return;
          }
          if (msg && msg.id === 1 && msg.error) {
            finish({ status: 'error', summary: 'Server returned an error on initialize', detail: (msg.error.message || JSON.stringify(msg.error)), stderr: tail(stderr) });
            return;
          }
        } catch { /* non-JSON banner line; ignore */ }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('exit', (code) => {
      if (settled) return;
      if (isMissingCommand(null, code, stderr)) finish({ status: 'missing', summary: 'Command "' + command + '" was not found', detail: 'Install the runtime it needs (e.g. Node/npx, uv/uvx, Python, Docker) and ensure it is on your PATH.', stderr: tail(stderr) });
      else finish({ status: 'error', summary: 'Exited' + (code != null ? ' with code ' + code : '') + ' before completing a handshake', detail: stderr ? '' : 'No diagnostic output was produced.', stderr: tail(stderr) });
    });

    // Send the MCP initialize request (newline-delimited JSON-RPC).
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'theoffice-mcp-test', version: '1.0.0' } } };
    try { child.stdin.write(JSON.stringify(init) + '\n'); } catch { /* will surface via error/exit */ }
  });
}

async function testUrl(cfg) {
  const url = cfg.url;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    clearTimeout(t);
    return { status: 'url', summary: 'Reachable · HTTP ' + res.status, detail: 'The endpoint responded (HTTP ' + res.status + '). This is a reachability check only — it does not perform a full MCP handshake.', command: url };
  } catch (e) {
    clearTimeout(t);
    const aborted = e && (e.name === 'AbortError');
    return { status: 'error', summary: aborted ? 'Timed out' : 'Unreachable', detail: aborted ? 'No response within ' + (URL_TIMEOUT_MS / 1000) + 's.' : String(e && e.message || e), command: url };
  }
}

// Run a probe for a resolved server config. Returns a classification object.
async function testServer(cfg) {
  cfg = cfg || {};
  if (cfg.url && !cfg.command) return testUrl(cfg);
  if (!cfg.command) return { status: 'unknown', summary: 'Nothing to test', detail: 'This server has neither a command nor a URL configured.' };
  const r = await testStdio(cfg);
  if (r.status === 'ok' && cfg.env && Object.keys(cfg.env).length) r.detail += ' (Secrets from its env were supplied.)';
  return r;
}

module.exports = { testServer };
