// settings.js
// Server-side global settings store (settings.json).
//
// Model selection MUST live here — not in the SPA's localStorage — because
// schedules, triggers, manager orchestration and other headless runs execute on
// the server with no browser involved. Persisting here (and syncing the file via
// config-sync) means a chosen model is honored everywhere: manual runs,
// scheduled runs, chat, and the manager "system" brain.
//
// Three independently-selectable models:
//   chatModel      — interactive agent/manager chat turns
//   executionModel — agent & task runs (manual + scheduled) and manager sub-agents
//   systemModel    — "system AI": the manager decision loop and chain AI judges
//
// An empty string means "use the runtime default" (whatever the SDK/login is
// configured for). Resolution order for any run is:
//   explicit per-agent config.model  >  category default  >  runtime default
// i.e. an agent that pins its own model always wins over the global default.

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const DEFAULTS = {
  chatModel: '',
  executionModel: '',
  systemModel: '',
  // Reports: equivalent USD cost per premium request (AIC). GitHub's documented
  // overage rate is $0.04/premium request; adjust in Settings to match your plan.
  costPerPremiumRequest: 0.04,
  // Default Azure DevOps export target — auto-populates the "Export to AzDO"
  // dialog so users don't retype their org/project/repo/branch every time.
  exportOrg: '',
  exportProject: '',
  exportRepo: '',
  exportBranch: '',
  // Default Azure DevOps target for board "Dev item" panels — pre-fills the
  // New dev item dialog's org/project so users don't retype them every time.
  devOrg: '',
  devProject: '',
};

let cache = null;

function _read() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return { ...DEFAULTS, ...(obj && typeof obj === 'object' ? obj : {}) };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function getSettings() {
  if (!cache) cache = _read();
  return { ...cache };
}

function reload() {
  cache = _read();
  return { ...cache };
}

function updateSettings(patch) {
  const cur = getSettings();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
      if (typeof DEFAULTS[k] === 'number') {
        const n = Number(patch[k]);
        next[k] = Number.isFinite(n) ? n : DEFAULTS[k];
      } else {
        next[k] = typeof patch[k] === 'string' ? patch[k] : (patch[k] == null ? '' : String(patch[k]));
      }
    }
  }
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('[settings] failed to write settings.json:', e.message);
  }
  cache = next;
  return { ...cache };
}

const CATEGORY_KEY = {
  chat: 'chatModel',
  execution: 'executionModel',
  system: 'systemModel',
};

/**
 * Resolve the model id to use for a run.
 * @param {'chat'|'execution'|'system'} category
 * @param {object|null} config  the agent/manager config (may carry a per-agent
 *   `model` override that wins over the category default).
 * @returns {string|undefined} a model id, or undefined to let the runtime default apply.
 */
function resolveModel(category, config) {
  const explicit = config && typeof config.model === 'string' ? config.model.trim() : '';
  if (explicit) return explicit;
  const key = CATEGORY_KEY[category];
  const def = key ? (getSettings()[key] || '').trim() : '';
  return def || undefined;
}

// Equivalent USD cost per premium request (AIC) used by the Reports system.
function getCostPerPremiumRequest() {
  const v = Number(getSettings().costPerPremiumRequest);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULTS.costPerPremiumRequest;
}

module.exports = {
  SETTINGS_PATH,
  DEFAULTS,
  getSettings,
  reload,
  updateSettings,
  resolveModel,
  getCostPerPremiumRequest,
};
