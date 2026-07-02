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

const SETTINGS_PATH = require('./data-paths').dataPath('settings.json');

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
  // GitHub source provider (Code Flow + Dev cards). Auth is secretless by
  // default via the `gh` CLI login store (githubAuthMode='cli'); 'env' uses
  // GH_TOKEN/GITHUB_TOKEN; 'pat' falls back to githubPat below. githubOwner is
  // the default org/user to list repos from.
  githubOwner: '',
  githubPat: '',
  githubAuthMode: 'cli',
  // Filesystem root under which dev-card AND code-flow review worktrees are
  // created. Empty = a short auto-chosen default (e.g. C:\a) to maximize Windows
  // MAX_PATH headroom. Set to any short directory to relocate all new worktrees.
  worktreeRoot: '',
  // Master kill-switch for all OUTBOUND external-access subsystems: the Azure
  // Service Bus event listener, the cloud relay poller, and mobile/phone command
  // handling. When true, the server neither connects to Service Bus nor polls the
  // relay, and the related connect/pair endpoints refuse. Local agents, schedules
  // and the browser UI keep working — only the external bridges are severed.
  externalAccessDisabled: false,
  // --- Managed dependencies (Copilot CLI/SDK + machine prereqs) ------------
  // Master switch for scheduled auto-updates of managed dependencies. When
  // false, the app never updates on its own — the user updates manually from
  // Settings → Dependencies. Per-dependency overrides live in the dependency
  // state file (dependencies.json), not here.
  depsAutoUpdate: false,
  // Default release channel for managed npm dependencies: 'stable' (npm latest),
  // 'latest' (prerelease tag), or 'pinned' (never move).
  depsChannel: 'stable',
  // Schedule string (parsed by scheduler.js, e.g. 'daily at 3am') for the
  // background check-and-update job. Empty / 'never' disables the schedule.
  depsSchedule: 'daily at 3am',
  // When true, skip all network version checks and auto-updates (air-gapped /
  // metered connection). The app still runs off the bundled/managed copies.
  depsOfflineMode: false,
  // Explicit user consent required before any automatic update runs. Auto-update
  // stays inert until this is turned on, even if depsAutoUpdate is true.
  depsConsent: false,
  // --- Connect (living impact / performance diary) -------------------------
  // Master switch for the Connect feature's automated M365/ADO collection. When
  // false, nothing is ever gathered on the user's behalf — the page still works
  // for manual entries + drafting, but no background collection runs.
  connectCollectionEnabled: false,
  // Explicit, separate consent that the user understands automated collection
  // reads their Teams/email/meetings/ADO activity. Collection stays inert until
  // BOTH connectCollectionEnabled AND connectConsent are true.
  connectConsent: false,
  // Schedule string (parsed by the scheduler) for the daily evidence-collection
  // job. Empty / 'never' disables the scheduled run (manual "Collect now" still
  // works when collection is enabled).
  connectSchedule: 'daily at 6pm',
  // When true, the generation agent also refreshes the Connect draft right after
  // each daily collection. When false, drafting is on-demand only ("Regenerate").
  connectGenerateDaily: false,
  // Optional override for where Connect data is stored. Empty = the per-user data
  // dir (connect/ under the profile store). Point this at a OneDrive-synced folder
  // to keep the backing data in the cloud (e.g. C:\Users\me\OneDrive\Connect).
  connectStorageDir: '',
  // Default recipient for the "Email my Connect" action. Empty = leave the .eml
  // To: blank for the user to fill in their mail client.
  connectEmailTo: '',
  // Deep meeting analysis. When on (default), meetings are handled by the
  // dedicated meeting-analyst agent instead of the generic collector: it only
  // records a meeting AFTER it has ended, drives the entry from the Teams
  // transcript recap (your actual contributions + action items) via M365
  // Copilot, and falls back to a light "attended — no recap" entry for meetings
  // you RSVP-accepted that were not transcribed. Future meetings are never
  // recorded, so the diary can no longer assert attendance before a meeting
  // happens. Turn off to skip meeting collection entirely.
  connectMeetingsEnabled: true,
  // Whether to also collect Azure DevOps evidence (work items + PRs) alongside
  // the M365 signals. Off by default so Connect works with M365 access alone.
  // When on, collection queries Azure DevOps DIRECTLY (via the Azure CLI token),
  // not WorkIQ, for reliable/real PR + work-item evidence.
  connectAdoEnabled: false,
  // Azure DevOps org to scan for the user's PRs and work items. Empty falls back
  // to devOrg, then exportOrg. Just the org name (e.g. 'dnceng'), not a URL.
  connectAdoOrg: '',
  // Comma-separated Azure DevOps project name(s) to scan. Empty falls back to
  // devProject, then exportProject. PRs are searched across ALL repos in each
  // project; work items via WIQL (@Me, assigned-or-created in the window).
  connectAdoProjects: '',
  // The command + args used to launch the WorkIQ MCP server for the collector
  // agent. Defaults to the public npm launcher; override for an air-gapped or
  // pinned install. Args are space-separated.
  connectWorkIqCommand: 'npx',
  connectWorkIqArgs: '-y @microsoft/workiq@latest mcp',
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
      if (typeof DEFAULTS[k] === 'boolean') {
        next[k] = typeof patch[k] === 'boolean' ? patch[k] : (patch[k] === 'true' || patch[k] === 1 || patch[k] === '1');
      } else if (typeof DEFAULTS[k] === 'number') {
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

// HARD LOCK — external access is not supported yet and must never be enabled.
// While this is true the master kill-switch is forced ON regardless of the stored
// setting, so no crafted settings write or stale config can turn on the Service
// Bus listener, relay poller or mobile/pairing bridges. Flip to false (and add the
// promised guardrails) when we're ready to support outbound external access.
const EXTERNAL_ACCESS_LOCKED = true;

// True when external access is permanently locked off by the build (not a
// user-toggleable state). The UI reflects this so the switch shows as locked.
function isExternalAccessLocked() {
  return EXTERNAL_ACCESS_LOCKED === true;
}

// True when the master external-access kill-switch is engaged. Consulted by the
// Service Bus event listener, relay poller and mobile/pairing endpoints. Returns
// true whenever the hard lock is engaged, otherwise honors the stored setting.
function isExternalAccessDisabled() {
  return EXTERNAL_ACCESS_LOCKED === true || getSettings().externalAccessDisabled === true;
}

module.exports = {
  SETTINGS_PATH,
  DEFAULTS,
  getSettings,
  reload,
  updateSettings,
  resolveModel,
  getCostPerPremiumRequest,
  isExternalAccessDisabled,
  isExternalAccessLocked,
};
