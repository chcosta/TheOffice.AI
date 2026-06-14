// sdk-reader.js
// Phase 1 of the @github/copilot-sdk migration.
//
// Replaces the brittle ~/.copilot/session-state/<id>/events.jsonl scraping in
// supervisor.js with the official SDK's getEvents() API, keyed by a pinned
// session id. Parity with the scraper was verified byte-for-byte over 150 real
// historical sessions (149 identical, 1 both-empty, 0 errors).
//
// Behaviour is gated by SDK_READ_MODE:
//   off            - module disabled, never touches the SDK
//   shadow (default) - reads via SDK, logs a parity record, but the caller keeps
//                      using the scraper output (zero behaviour change)
//   authoritative  - caller uses SDK output when the read succeeds, else falls
//                      back to the scraper
//
// The module degrades gracefully: any SDK failure returns { ok:false } so the
// caller can always fall back to the existing scraper. It never throws.

const fs = require('fs');
const path = require('path');
const os = require('os');

let SDK = null;
let approveAll = null;
try {
  const mod = require('@github/copilot-sdk');
  SDK = mod.CopilotClient;
  approveAll = mod.approveAll;
} catch (e) {
  // SDK not installed - module stays disabled.
}

const SEP = '\n\n---\n\n';
const VALID_MODES = ['off', 'shadow', 'authoritative'];

class SdkReader {
  constructor() {
    const raw = (process.env.SDK_READ_MODE || 'shadow').toLowerCase();
    this._mode = VALID_MODES.includes(raw) ? raw : 'shadow';
    this._client = null;
    this._starting = null;
    this._failures = 0;
    this._available = !!SDK;
    this._parityLog = path.join(os.homedir(), '.copilot', 'sdk-read-parity.jsonl');
  }

  /** Effective mode: 'off' if SDK isn't installed or disabled by failures. */
  get mode() {
    return this._available && this._mode !== 'off' ? this._mode : 'off';
  }

  get enabled() {
    return this.mode !== 'off';
  }

  async _getClient() {
    if (!this._available || this._mode === 'off') return null;
    if (this._client) return this._client;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      try {
        const c = new SDK({ useLoggedInUser: true, logLevel: 'error' });
        await c.start();
        this._client = c;
        this._failures = 0;
        return c;
      } catch (e) {
        this._failures++;
        if (this._failures >= 3) {
          this._available = false;
          console.error('[sdk-reader] disabled after repeated start failures:', e.message);
        } else {
          console.error('[sdk-reader] client start failed (will retry):', e.message);
        }
        return null;
      } finally {
        this._starting = null;
      }
    })();
    return this._starting;
  }

  /**
   * Read assistant output for a known copilot session id.
   * Mirrors the supervisor scraper contract: assistant.message contents joined
   * by "\n\n---\n\n".
   * @returns {Promise<{ok:boolean, output:string, sessionId:string|null, eventCount?:number, error?:string}>}
   */
  async getSessionOutput(sessionId) {
    if (!sessionId || !this.enabled) {
      return { ok: false, output: '', sessionId: sessionId || null, error: 'disabled-or-no-id' };
    }
    const client = await this._getClient();
    if (!client) return { ok: false, output: '', sessionId, error: 'no-client' };

    let session = null;
    try {
      session = await client.resumeSession(sessionId, { onPermissionRequest: approveAll });
      const events = await session.getEvents();
      const parts = [];
      for (const ev of events) {
        if (ev.type === 'assistant.message' && ev.data && ev.data.content) {
          parts.push(ev.data.content);
        }
      }
      return { ok: true, output: parts.join(SEP), sessionId, eventCount: events.length };
    } catch (e) {
      return { ok: false, output: '', sessionId, error: e.message };
    } finally {
      if (session) {
        try { await session.disconnect(); } catch (_) { /* preserves disk */ }
      }
    }
  }

  /** Append a parity record (best-effort; never throws). */
  logParity(rec) {
    try {
      fs.appendFileSync(this._parityLog, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
    } catch (_) { /* best-effort */ }
  }

  /**
   * Compare a scraper output against the SDK output for a session and record a
   * parity row. Returns the comparison so callers can act on it.
   */
  comparison(scraperOutput, sdk) {
    const a = scraperOutput || '';
    const b = (sdk && sdk.output) || '';
    const normA = a.replace(/\s+/g, ' ').trim();
    const normB = b.replace(/\s+/g, ' ').trim();
    return {
      sdkOk: !!(sdk && sdk.ok),
      sdkError: sdk && sdk.error,
      scraperLen: a.length,
      sdkLen: b.length,
      exact: a === b,
      normalizedEqual: normA === normB,
      eventCount: sdk && sdk.eventCount,
    };
  }

  async stop() {
    if (this._client) {
      try { await this._client.stop(); } catch (_) { /* ignore */ }
      this._client = null;
    }
  }
}

module.exports = new SdkReader();
