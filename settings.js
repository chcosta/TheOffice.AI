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
  // Marketplace: auto-scan every added source daily + flag newly-discovered items.
  marketplaceAutoScan: true,
  // GitHub source provider (Code Flow + Dev cards). Auth is secretless by
  // default via the `gh` CLI login store (githubAuthMode='cli'); 'env' uses
  // GH_TOKEN/GITHUB_TOKEN; 'pat' falls back to githubPat below. githubOwner is
  // the default org/user to list repos from.
  githubOwner: '',
  githubPat: '',
  githubAuthMode: 'cli',
  // Preferred GitHub account when the `gh` CLI holds more than one login
  // (e.g. a personal github.com account alongside a GitHub EMU/enterprise
  // account). Empty login = use whichever account `gh` reports as active.
  // Threaded into every gh-backed API call via github.getToken so selecting
  // an account here scopes all GitHub access without mutating global gh state.
  githubAccount: { host: '', login: '' },
  // Filesystem root under which dev-card AND code-flow review worktrees are
  // created. Empty = a short auto-chosen default (e.g. C:\a) to maximize Windows
  // MAX_PATH headroom. Set to any short directory to relocate all new worktrees.
  worktreeRoot: '',
  // Code Flow: reviewer GROUPS the user belongs to (Azure DevOps groups / GitHub
  // teams that appear as a named reviewer on a PR, e.g. "Dotnet-Core-Engineering").
  // When a PR lists one of these groups as a reviewer, Code Flow surfaces it under
  // "Active PRs (reviews needed)" alongside PRs where the user is a direct reviewer.
  // Array of group DISPLAY names, matched case-insensitively against PR reviewers.
  // codeflowMyGroups is the legacy combined list (kept for back-compat + as a fallback);
  // GitHub and Azure DevOps groups are now managed separately since a person's reviewer
  // groups rarely overlap across the two forges.
  codeflowMyGroups: [],
  codeflowMyGroupsGithub: [],
  codeflowMyGroupsAzdo: [],
  // Master kill-switch for all OUTBOUND external-access subsystems: the Azure
  // Service Bus event listener, the cloud relay poller, and mobile/phone command
  // handling. When true, the server neither connects to Service Bus nor polls the
  // relay, and the related connect/pair endpoints refuse. Local agents, schedules
  // and the browser UI keep working — only the external bridges are severed.
  externalAccessDisabled: false,
  // --- Pursuit Director ----------------------------------------------------
  // The Director governs the agents (legs) INSIDE a pursuit: it absorbs the
  // provably-safe gated stops (duplicate / reversible-local / factual+verified),
  // batches deliverables into one approval, and escalates only the genuine human
  // decisions — collapsing a stream of approvals into a handful of desk items.
  // Default ON for the view + chat narration, but SAFE: nothing is auto-applied
  // until the user mints a standing grant for a specific pursuit, and autonomous
  // absorption is additionally leader-gated. `autonomy` is global
  // (cautious|balanced|full); `grants` are per-pursuit (pursuitId → grant); each
  // grant is scoped, path-limited, expiring and revocable. Set enabled:false to
  // fully hide the Director and restore the raw per-stop approval flow.
  director: {
    enabled: true,
    autonomy: 'balanced',
    defaultPaths: ['/src'],
    grantTtlDays: 7,
    grants: {},
  },
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
  // Multiple Azure DevOps org/project targets for Connect collection. Each entry
  // is { org: 'name', projects: 'proj1, proj2' }. When non-empty this is
  // authoritative and supersedes the single connectAdoOrg/connectAdoProjects
  // (which are kept in sync with the first entry for backward compatibility and
  // as the fallback when this list is empty).
  connectAdoOrgs: [],
  // The command + args used to launch the WorkIQ MCP server for the collector
  // agent. Defaults to the public npm launcher; override for an air-gapped or
  // pinned install. Args are space-separated.
  connectWorkIqCommand: 'npx',
  connectWorkIqArgs: '-y @microsoft/workiq@latest mcp',

  // ---- Monitoring.AI (Azure Managed Grafana) --------------------------------
  // Connection to a Grafana instance (Azure Managed Grafana or any Grafana). When
  // enabled + url + token are set, the Monitoring.AI page reads live dashboards;
  // otherwise it runs entirely on honest sample data so it is explorable out of
  // the box. token = a Grafana service-account token (Bearer). orgId is optional
  // (X-Grafana-Org-Id header) for multi-org instances.
  grafana: { enabled: false, url: '', token: '', orgId: '', authMode: 'aad', pushByDefault: true },

  // ---- Monitoring.AI — epic telemetry sink (App Insights) -------------------
  // Architecture C: TheOffice.AI acts as an ETL that emits each epic objective's
  // recorded reading into a SHARED Application Insights instance, and a per-epic
  // Grafana dashboard reads back from it (Grafana = front-end portal). ONE shared
  // instance backs every epic dashboard; the source is changeable here (not
  // hardcoded). Default OFF / opt-in — nothing is emitted until enabled + a
  // connection string is set. HONESTY: only recorded readings are ever emitted;
  // no synthetic series.
  //   connectionString — App Insights connection string (carries ingestion key +
  //                      endpoint). The single source of truth for emission.
  //   resourceId       — the App Insights ARM resource id (used to build the
  //                      Grafana Azure Monitor query target + guide datasource wiring).
  //   subscriptionId / appInsightsName / resourceGroup — provisioning breadcrumbs.
  //   datasourceUid    — the Grafana Azure Monitor datasource uid pointed at this
  //                      App Insights (set once the datasource is wired in Grafana).
  monitoringTelemetry: { enabled: false, connectionString: '', resourceId: '', subscriptionId: '', appInsightsName: '', resourceGroup: '', datasourceUid: '' },

  // ---- Compose.AI — "Make it real" prototype publishing ---------------------
  // Turns a self-contained Compose.AI prototype (a `site` draft) into a real,
  // access-restricted Azure App Service with per-user Table Storage state and
  // Microsoft Entra sign-in. Default OFF / opt-in — provisioning creates real
  // Azure resources in the signed-in subscription and INCURS COST. Uses the
  // Azure CLI (`az`) identity already on the machine (same sign-in the Grafana +
  // Graph integrations use); no separate credentials are stored here.
  //   location       — Azure region for new resources.
  //   resourceGroup  — RG to create/reuse (empty = one per published prototype).
  //   sku            — App Service plan SKU (F1 free / B1 basic).
  //   subscription   — pin a subscription id (empty = the az default).
  composePublish: { enabled: false, location: 'eastus2', resourceGroup: '', sku: 'F1', subscription: '', serviceManagementReference: '' },

  // ---- Newsletter -----------------------------------------------------------
  // The Newsletter feature turns the Connect impact diary into a polished,
  // emailable digest over a timeframe. It REQUIRES Connect (reads its diary) and
  // stores its own draft/config. Like Connect, its data can be redirected to a
  // OneDrive-synced folder; empty = the per-user data dir (newsletter/).
  newsletterStorageDir: '',
  // Default recipient for the "Email newsletter" action. Empty = leave the .eml
  // To: blank for the user to fill in their mail client.
  newsletterEmailTo: '',
  // When true, the newsletter is generated automatically on `newsletterSchedule`
  // (leader-gated) and the user is notified for review/publishing. `scheduler.js`
  // has no bare "weekly" token — use e.g. "monday at 8am" / "friday at 4pm".
  newsletterAutoGenerate: false,
  newsletterSchedule: 'monday at 8am',
  // When true (default), a review-ready draft .eml is opened in the mail client on
  // each scheduled run. The in-app "review pending" flag is always set regardless.
  newsletterNotifyEmail: true,

  // ---- Me.AI (personal daily agenda / command center) ----------------------
  // Me.AI is a daily hub backed by a personal "Me agent". M1 is the read-only
  // agenda MVP: it reads your calendar/email/Teams (via WorkIQ, consent-gated),
  // Azure DevOps PRs/work items, and Code Flow worktrees, then plans your day on
  // a configurable grid. Separate, explicit consent — nothing is read until the
  // user turns this on (mirrors the Connect consent model). Azure DevOps targets
  // are reused from the Connect ADO config (connectAdoOrgs / connectAdoOrg).
  meAiConsent: false,
  // Working-hours envelope the agenda is planned within (24h HH:MM local).
  meAiWorkStart: '08:00',
  meAiWorkEnd: '17:00',
  // Lunch break carved out of the day (HH:MM). Empty start disables the block.
  meAiLunchStart: '12:00',
  meAiLunchEnd: '12:30',
  // Agenda time-grid granularity in minutes. Configurable 5 / 10 / 15; default 10.
  meAiGrid: 10,
  // "Protect near-now" window in minutes: on a re-plan of today, any block starting within
  // this many minutes of now is held in place (imminent — too close to move). Also the
  // buffer that guards an in-progress block. Configurable 10/15/30/45/60; default 30.
  meAiImminentWindow: 30,
  // Work-week: weekday ints (0=Sun..6=Sat) the agenda is planned for. Default Mon–Fri.
  // May legitimately be empty (user works no fixed days). Persisted as an array.
  meAiWorkDays: [1, 2, 3, 4, 5],
  // Hybrid work schedule: per-weekday overrides for hours + in-office/home designation.
  // Map keyed by DOW string ('0'=Sun..'6'=Sat) → { start:'HH:MM', end:'HH:MM',
  // location:'office'|'home'|'' }. A missing/blank field falls back to the global
  // meAiWorkStart/meAiWorkEnd envelope. Only the days a user customizes appear here.
  meAiWeeklyHours: {},
  // #2 Quick agenda MODE — a day-shape preset that re-weights task ordering and
  // steers the LLM refine. One of: balanced | relaxed | focused | low-sleep |
  // unblock-team. Default balanced (no bias).
  meAiMode: 'balanced',
  // #2 Time-of-day preferences per activity type — map of block type
  // (review|steward|focus|comms|admin|prep) → 'morning' | 'afternoon' | ''.
  // Biases ordering so preferred-morning work lands earlier; also fed to refine.
  meAiTimePrefs: {},
  // Issue #4: Pulse.AI Teams/channel monitoring selection. Array of
  // {teamId, teamName, channels:[{id,name}]|null} — channels null/empty = ALL
  // channels in that team. Selected channels' recent activity folds ON TOP of
  // the existing cross-Teams @mention surfacing in Pulse.AI (add-on-top).
  meAiPulseTeams: [],
  // --- Phase 2: confidence-scored auto-triage ------------------------------
  // When enabled, high-confidence attention-inbox decisions auto-apply (with
  // one-click undo) instead of asking. Per-action tiers map each triage action
  // to a confidence tier — 'safe' (reversible: Later/Not mine/Won't fix),
  // 'agenda' (schedules work: Fit into today) or 'off' (never auto). 'now'
  // (Handle now) is always locked to acting and never auto-runs. Thresholds are
  // the min confidence (0-100) each tier needs to fire.
  meAiAutoTriage: false,
  meAiAutoTriageSafe: 80,
  meAiAutoTriageAgenda: 90,
  meAiActionTiers: {},
  // Stricter triage bar (owner opt-in). When enabled, ONLY genuinely high-urgency
  // asks (urgency >= meAiStrictMinUrgency, 0-5 scale) or meeting action items reach
  // the triage section; everything else is quietly set aside so it never distracts
  // the day OR lands on the backlog. Optional allowances widen the gate.
  meAiStrictTriage: false,
  meAiStrictMinUrgency: 4,
  meAiStrictAllowMentions: false,
  meAiStrictAllowReviews: false,
  // Instance-count dedup: min containment (0-100) for a NEW arrival to be folded
  // into an already-triaged related item (bumping its instance count) instead of
  // surfacing as its own inbox row. Higher = stricter (fewer merges).
  meAiGroupingMin: 72,
  // Auto-file a GitHub issue when the scheduler produces a real double-book
  // (two committed blocks overlapping that the resolver could not separate). A
  // scheduling conflict is a bug in the planner, so we capture it for debugging
  // with before/after gantt visuals + full decision telemetry. Deduped per-day
  // by conflict signature; leader-gated; TODAY only. ON by default.
  meAiConflictAutoReport: true,
  // Backlog → real ADO work-item creation defaults. User-configurable; the Backlog
  // page's "Create work item" action files against these. org/project fall back to
  // the first connected ADO target at runtime when left blank.
  meAiWorkItemOrg: '',
  meAiWorkItemProject: '',
  meAiWorkItemType: 'DNCeng Task',
  meAiWorkItemState: 'Backlog',
  meAiWorkItemArea: '',
  meAiWorkItemIteration: '',
  meAiWorkItemTags: '',

  // Dev-card auto-creation from Azure DevOps work-item conditions. When on, a
  // leader-gated poller queries ADO for work items matching each enabled rule
  // and creates a dev card for any match that doesn't already have one (deduped
  // by provider/org/project/workItemId). A rule is a filter — org/project (blank
  // ⇒ the ADO defaults), workItemType, state, areaPath (UNDER), always scoped to
  // items assigned to @Me — plus optional area/tag→repo mappings so a matching
  // card gets a repo assigned; unmatched cards are created in a clear
  // "no repo assigned" state. Rules array is replaced wholesale on update.
  devAutoCreate: false,
  devAutoCreateRules: [],

  // The app ships several built-in AI "system agents" (Connect assistant,
  // Newsletter writer/editor, Me.AI agent + external-act, Agenda assistant,
  // Workspace/Board assistant, Code Flow reviewer/steward). Settings → System
  // agents lets the user READ each agent's role/tools/base prompt and APPEND
  // standing custom instructions (and optionally pin a model) WITHOUT rewriting
  // the base prompt — the override is appended at runtime, subordinate to the
  // agent's required output contract. Map keyed by agent id →
  // { instructions:'<free text>', model:'<model id or empty>' }. Only agents the
  // user actually customizes appear here. Full-object replace on update.
  systemAgentOverrides: {},
};

let cache = null;

// A "fixed-shape" nested setting is a non-empty object default (e.g. composePublish,
// director, grafana, githubAccount): its keys are a known schema, so a partial stored
// value / partial patch must MERGE over the sibling defaults rather than replace them.
// An "open map" is an empty-object default (e.g. systemAgentOverrides, director.grants):
// callers rebuild the whole map to add/remove entries, so it is replaced wholesale.
function _isFixedShapeObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
}

function _read() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    const src = (obj && typeof obj === 'object') ? obj : {};
    const out = { ...DEFAULTS, ...src };
    // One-level merge for fixed-shape nested objects so a partially-stored value
    // (e.g. composePublish saved as just { serviceManagementReference }) still
    // carries its sibling defaults (enabled/location/sku/...) instead of dropping them.
    for (const k of Object.keys(DEFAULTS)) {
      if (!_isFixedShapeObject(DEFAULTS[k])) continue;
      const sv = src[k];
      out[k] = (sv && typeof sv === 'object' && !Array.isArray(sv)) ? { ...DEFAULTS[k], ...sv } : { ...DEFAULTS[k] };
    }
    return out;
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
      if (Array.isArray(DEFAULTS[k])) {
        next[k] = Array.isArray(patch[k]) ? patch[k] : DEFAULTS[k];
      } else if (DEFAULTS[k] && typeof DEFAULTS[k] === 'object') {
        // Fixed-shape config objects (non-empty default) merge one level over the
        // current value so a partial patch (e.g. { composePublish: { enabled:true } }
        // or { composePublish: { serviceManagementReference } }) preserves siblings.
        // Open maps (empty {} default, e.g. systemAgentOverrides) are replaced wholesale
        // so callers can remove entries by omitting them.
        if (_isFixedShapeObject(DEFAULTS[k])) {
          const base = (cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) ? cur[k] : DEFAULTS[k];
          next[k] = (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) ? { ...base, ...patch[k] } : { ...base };
        } else {
          next[k] = (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) ? patch[k] : DEFAULTS[k];
        }
      } else if (typeof DEFAULTS[k] === 'boolean') {
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
