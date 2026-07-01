'use strict';

// Durable UI preferences store.
//
// The SPA keeps UI preferences (theme, color palette, icon set, Basic/Advanced
// experience level, app-mode, basic-feature toggles, sidebar widths, etc.) in
// the browser's localStorage. On the desktop app that store lives in the
// WebView2 profile, which is wiped on a reinstall/upgrade — so those prefs were
// silently lost every time the user reinstalled.
//
// This module mirrors a whitelist of durable UI prefs to a JSON file under the
// reinstall-durable profile data dir (via dataPath), so they survive reinstalls
// and — when added to config-sync — roam across machines. The SPA hydrates
// localStorage from here on boot and writes durable pref changes back.

const fs = require('fs');
const { dataPath } = require('./data-paths');

const FILE = () => dataPath('ui-prefs.json');

// Keep the store small and sane: string-ish values only, bounded count/size.
const MAX_KEYS = 200;
const MAX_VALUE_LEN = 20000;

function get() {
  try {
    const obj = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch {
    return {};
  }
}

// Replace the stored prefs wholesale with the provided object. The SPA always
// sends a full snapshot of its durable keys, so replace (not merge) lets key
// removals (e.g. clearing the color palette) propagate correctly.
function replace(prefs) {
  const src = (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) ? prefs : {};
  const clean = {};
  let n = 0;
  for (const k of Object.keys(src)) {
    if (n >= MAX_KEYS) break;
    if (typeof k !== 'string' || !k) continue;
    let v = src[k];
    if (v == null) continue;
    if (typeof v !== 'string') {
      try { v = JSON.stringify(v); } catch { continue; }
    }
    if (v.length > MAX_VALUE_LEN) continue;
    clean[k] = v;
    n++;
  }
  try {
    fs.writeFileSync(FILE(), JSON.stringify(clean, null, 2));
  } catch (e) {
    console.warn('[ui-prefs] Could not persist UI preferences:', e.message);
  }
  return clean;
}

module.exports = { get, replace, FILE };
