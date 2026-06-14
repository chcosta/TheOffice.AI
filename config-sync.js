'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

const SYNC_CONFIG_PATH = path.join(__dirname, 'sync-config.json');
const LEADER_BLOB = '_leader.json';
const MANIFEST_BLOB = '_manifest.json';
const INSTANCE_PREFIX = '_instances/'; // presence registry: one blob per running instance
const LEADER_REQUEST_BLOB = '_leader-request.json'; // remote leadership-handoff request
const LEASE_DURATION = 60; // seconds
const RENEW_INTERVAL = 25000; // ms (renew well before 60s expiry)
const POLL_INTERVAL = 30000; // ms
const INSTANCE_STALE = 90; // seconds — an instance not seen within this window is "offline"
const LEADER_REQUEST_TTL = 120; // seconds — ignore handoff requests older than this

// Files that get synced (within a machine's own cloud namespace)
const SYNCED_FILES = ['agents.json', 'managers.json', 'tasks.json', 'chains.json', 'events-config.json'];
const SYNCED_DIRS = ['plugins', 'mcp-configs'];
// Per-machine cloud namespace. Each machine owns machines/{machineId}/ and is the
// sole writer of its own config. Other machines may only READ it (for browse/install).
// This removes the need for cross-machine path rewriting entirely: a machine's config
// only ever has to make sense on that machine.
const MACHINES_PREFIX = 'machines/';

// Synced directories (plugins, mcp-configs) are per-user runtime data, NOT repo
// source. They live under the user profile and are still cloud-synced across
// machines. Overridable via SUPERVISOR_DATA_DIR.
const SUPERVISOR_DATA_DIR = process.env.SUPERVISOR_DATA_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'agent-supervisor');
const PLUGINS_DIR = path.join(SUPERVISOR_DATA_DIR, 'plugins');

// Map a synced dir name to its on-disk location under the runtime data dir.
function syncedDirPath(dirName) {
  return path.join(SUPERVISOR_DATA_DIR, dirName);
}
// Base dir used to build clean relative labels for a synced dir's files
// (e.g. "plugins\\foo\\bar.md" rather than an absolute profile path).
function syncedDirLabelBase() {
  return SUPERVISOR_DATA_DIR;
}

class ConfigSync {
  constructor(opts = {}) {
    this._config = this._loadSyncConfig();
    this._blobClient = null;
    this._containerClient = null;
    this._leaseClient = null;
    this._leaseId = null;
    this._epoch = 0;
    this._isLeader = false;
    this._renewTimer = null;
    this._pollTimer = null;
    this._lastManifestETag = null;
    this._enabled = false;
    this._machineId = this._config.machineId || this._generateMachineId();
    this._onLeaderChange = opts.onLeaderChange || (() => {});
    this._onConfigPulled = opts.onConfigPulled || (() => {});
    this._localVersion = 0;
    this._dirty = false;
  }

  // --- Public API ---

  get enabled() { return this._enabled && !!this._config.storageAccount; }
  get isLeader() { return this._isLeader; }
  get epoch() { return this._epoch; }
  get machineId() { return this._machineId; }
  get config() { return { ...this._config }; }

  async start() {
    if (!this._config.storageAccount) {
      console.log('[config-sync] No storage account configured, sync disabled');
      return;
    }
    this._enabled = true;
    try {
      await this._initBlobClient();
      await this._ensureContainer();
      await this._tryAcquireLease();
      // Each machine owns its own cloud namespace (machines/{machineId}/) and is the
      // sole writer of its config. Local files are ALWAYS authoritative — we never
      // pull-overwrite them on startup. Push local config up so the cloud mirror stays
      // current and is browsable/installable by other machines. Leadership only gates
      // shared event-bus handling, not a machine's own config or scheduled work.
      await this._captureManifestEtag();
      await this.pushConfig().catch(err => console.warn('[config-sync] Startup push failed:', err.message));
      this._startPolling();
      this._registerPresence().catch(() => {});
      console.log(`[config-sync] Started. Leader: ${this._isLeader}, Machine: ${this._machineId}`);
    } catch (err) {
      console.error('[config-sync] Start failed:', err.message);
      this._enabled = false;
    }
  }

  stop() {
    if (this._renewTimer) clearInterval(this._renewTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._renewTimer = null;
    this._pollTimer = null;
    // Best-effort: remove our presence so we drop off the machine list promptly.
    if (this._enabled && this._containerClient) {
      this._containerClient.getBlockBlobClient(INSTANCE_PREFIX + this._machineId + '.json').deleteIfExists().catch(() => {});
    }
    this._releaseLease().catch(() => {});
    this._enabled = false;
  }

  /** Check leader status with epoch validation (call before scheduling) */
  isLeaderWithEpoch(expectedEpoch) {
    return this._isLeader && this._epoch === expectedEpoch;
  }

  /** Force this machine to become leader */
  async forceLeader() {
    if (!this._enabled) throw new Error('Sync not enabled');
    try {
      // Break existing lease
      const leaseBlob = this._containerClient.getBlockBlobClient(LEADER_BLOB);
      try {
        await leaseBlob.breakLease(0); // break immediately
      } catch (err) {
        if (err.statusCode !== 404 && err.statusCode !== 409) throw err;
      }
      // Small delay for lease to clear
      await new Promise(r => setTimeout(r, 1000));
      // Acquire with bumped epoch
      await this._tryAcquireLease(true);
      if (!this._isLeader) throw new Error('Failed to acquire lease after break');
      console.log(`[config-sync] Force-leader succeeded. Epoch: ${this._epoch}`);
      this._registerPresence().catch(() => {});
      return { success: true, epoch: this._epoch, machineId: this._machineId };
    } catch (err) {
      console.error('[config-sync] Force-leader failed:', err.message);
      throw err;
    }
  }

  /**
   * Write this instance's presence to the shared registry so other machines can
   * list who is online and choose a leader. One small blob per machineId.
   */
  async _registerPresence() {
    if (!this._enabled || !this._containerClient) return;
    try {
      const blob = this._containerClient.getBlockBlobClient(INSTANCE_PREFIX + this._machineId + '.json');
      const info = {
        machineId: this._machineId,
        hostname: os.hostname(),
        appVersion: (() => { try { return require('./package.json').version || '1.0.0'; } catch { return '1.0.0'; } })(),
        isLeader: this._isLeader,
        epoch: this._epoch,
        pid: process.pid,
        lastSeen: new Date().toISOString()
      };
      const body = JSON.stringify(info, null, 2);
      await blob.upload(body, body.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
    } catch (err) {
      // Non-critical — presence is best-effort.
    }
  }

  /** List all instances that have registered presence, with liveness. */
  async listInstances() {
    if (!this._enabled || !this._containerClient) {
      // Standalone: just this machine.
      return [{
        machineId: this._machineId,
        hostname: os.hostname(),
        appVersion: (() => { try { return require('./package.json').version || '1.0.0'; } catch { return '1.0.0'; } })(),
        isLeader: true,
        alive: true,
        lastSeen: new Date().toISOString(),
        staleSeconds: 0,
        isSelf: true
      }];
    }
    const now = Date.now();
    let leaderMachineId = null;
    try { const li = await this.getLeaderInfo(); leaderMachineId = li?.machineId || null; } catch {}
    const out = [];
    try {
      for await (const item of this._containerClient.listBlobsFlat({ prefix: INSTANCE_PREFIX })) {
        try {
          const blob = this._containerClient.getBlockBlobClient(item.name);
          const dl = await blob.download(0);
          const text = await this._streamToString(dl.readableStreamBody);
          const info = JSON.parse(text);
          const seenMs = info.lastSeen ? Date.parse(info.lastSeen) : null;
          const staleSeconds = seenMs ? Math.max(0, Math.round((now - seenMs) / 1000)) : null;
          const alive = seenMs != null && (now - seenMs) < INSTANCE_STALE * 1000;
          out.push({
            machineId: info.machineId,
            hostname: info.hostname || null,
            appVersion: info.appVersion || null,
            isLeader: leaderMachineId ? info.machineId === leaderMachineId : !!info.isLeader,
            alive,
            lastSeen: info.lastSeen || null,
            staleSeconds,
            isSelf: info.machineId === this._machineId
          });
        } catch {}
      }
    } catch (err) {
      console.error('[config-sync] listInstances failed:', err.message);
    }
    // Sort: leader first, then alive, then hostname.
    out.sort((a, b) => (b.isLeader - a.isLeader) || (b.alive - a.alive) || String(a.hostname).localeCompare(String(b.hostname)));
    return out;
  }

  /**
   * Request that a specific machine become leader. If the target is this
   * machine, take leadership immediately. Otherwise write a handoff request the
   * target picks up on its next poll.
   */
  async requestLeader(targetMachineId) {
    if (!this._enabled) throw new Error('Sync not enabled');
    if (!targetMachineId) throw new Error('targetMachineId is required');
    if (targetMachineId === this._machineId) {
      const r = await this.forceLeader();
      await this._clearLeaderRequest();
      return { ...r, mode: 'immediate' };
    }
    const req = { targetMachineId, requestedBy: this._machineId, requestedAt: new Date().toISOString() };
    const body = JSON.stringify(req, null, 2);
    const blob = this._containerClient.getBlockBlobClient(LEADER_REQUEST_BLOB);
    await blob.upload(body, body.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
    console.log(`[config-sync] Leadership handoff requested → ${targetMachineId} (by ${this._machineId})`);
    return { success: true, mode: 'requested', targetMachineId };
  }

  async _clearLeaderRequest() {
    try { await this._containerClient.getBlockBlobClient(LEADER_REQUEST_BLOB).deleteIfExists(); } catch {}
  }

  /**
   * Honor a pending leadership-handoff request that targets this machine.
   * Called from the poll loop on every instance.
   */
  async _checkLeaderRequest() {
    if (!this._enabled || !this._containerClient) return;
    let req = null;
    try {
      const blob = this._containerClient.getBlockBlobClient(LEADER_REQUEST_BLOB);
      const dl = await blob.download(0);
      req = JSON.parse(await this._streamToString(dl.readableStreamBody));
    } catch (err) {
      if (err.statusCode === 404) return;
      return;
    }
    if (!req || !req.targetMachineId) return;
    // Drop stale requests.
    const ageMs = req.requestedAt ? (Date.now() - Date.parse(req.requestedAt)) : Infinity;
    if (ageMs > LEADER_REQUEST_TTL * 1000) { await this._clearLeaderRequest(); return; }
    if (req.targetMachineId !== this._machineId) return; // not for me
    if (this._isLeader) { await this._clearLeaderRequest(); return; } // already leader
    console.log(`[config-sync] Honoring leadership handoff request (target=${this._machineId})`);
    try {
      await this.forceLeader();
      await this._clearLeaderRequest();
    } catch (err) {
      console.error('[config-sync] Failed to honor handoff request:', err.message);
    }
  }

  /** Push local config to cloud (after local edit) */
  async pushConfig() {
    if (!this._enabled) return;
    try {
      const snapshot = await this._createSnapshot();
      await this._uploadSnapshot(snapshot);
      console.log('[config-sync] Config pushed to cloud');
    } catch (err) {
      console.error('[config-sync] Push failed:', err.message);
      throw err;
    }
  }

  /** Pull config from cloud (manual sync) */
  async pullConfig() {
    if (!this._enabled) return;
    await this._syncDown();
  }

  /** Get current leader info */
  async getLeaderInfo() {
    if (!this._enabled) return null;
    try {
      const leaderBlob = this._containerClient.getBlockBlobClient(LEADER_BLOB);
      const dl = await leaderBlob.download(0);
      const text = await this._streamToString(dl.readableStreamBody);
      return JSON.parse(text);
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Normalized leader/liveness status for clients (mobile, SPA).
   * Tells whether a leader is alive and therefore whether scheduled events
   * will actually be addressed by the system.
   */
  async getLeaderStatus() {
    const myHostname = os.hostname();
    // Sync disabled → this single instance handles everything itself.
    if (!this.enabled) {
      return {
        syncEnabled: false,
        isLeader: true,
        leaderAlive: true,
        eventsActive: true,
        thisHostname: myHostname,
        thisMachineId: this._machineId,
        leaderHostname: myHostname,
        leaderMachineId: this._machineId,
        lastHeartbeat: null,
        staleSeconds: 0,
        epoch: this._epoch
      };
    }
    let info = null;
    try { info = await this.getLeaderInfo(); } catch {}
    const now = Date.now();
    const hbMs = info?.lastHeartbeat ? Date.parse(info.lastHeartbeat) : null;
    const staleSeconds = hbMs ? Math.max(0, Math.round((now - hbMs) / 1000)) : null;
    // A leader is considered alive if this instance holds leadership, or the
    // last heartbeat is fresher than the lease duration.
    const leaderAlive = this._isLeader || (hbMs != null && (now - hbMs) < LEASE_DURATION * 1000);
    return {
      syncEnabled: true,
      isLeader: this._isLeader,
      leaderAlive,
      eventsActive: leaderAlive, // events fire on the leader, wherever it is
      thisHostname: myHostname,
      thisMachineId: this._machineId,
      leaderHostname: info?.hostname || null,
      leaderMachineId: info?.machineId || null,
      lastHeartbeat: info?.lastHeartbeat || null,
      staleSeconds,
      epoch: this._epoch
    };
  }

  /** Get/set sync config */
  getSyncConfig() { return { ...this._config }; }

  saveSyncConfig(updates) {
    this._config = { ...this._config, ...updates };
    if (!this._config.machineId) this._config.machineId = this._machineId;
    fs.writeFileSync(SYNC_CONFIG_PATH, JSON.stringify(this._config, null, 2));
    return this._config;
  }

  // --- Cross-machine browse & install (per-machine cloud namespaces) ---

  _machinePrefix(machineId) {
    return `${MACHINES_PREFIX}${machineId || this._machineId}/`;
  }
  _machineManifestName(machineId) {
    return `${this._machinePrefix(machineId)}manifest.json`;
  }
  _machineProfileName(machineId) {
    return `${this._machinePrefix(machineId)}profile.json`;
  }

  /**
   * List every machine that has published a config namespace in the cloud, with a
   * lightweight catalog (agent/manager names) plus liveness/leader flags. Powers the
   * SPA/mobile "Machines" browser. Read-only.
   */
  async listMachines() {
    if (!this._enabled) return [];
    const out = [];
    let leaderMachineId = null;
    try { const li = await this.getLeaderInfo(); leaderMachineId = li?.machineId || null; } catch {}
    const alive = new Map();
    try { for (const inst of await this.listInstances()) alive.set(inst.machineId, inst); } catch {}
    try {
      for await (const item of this._containerClient.listBlobsFlat({ prefix: MACHINES_PREFIX })) {
        if (!item.name.endsWith('/profile.json')) continue;
        try {
          const blob = this._containerClient.getBlockBlobClient(item.name);
          const dl = await blob.download(0);
          const prof = JSON.parse(await this._streamToString(dl.readableStreamBody));
          const inst = alive.get(prof.machineId);
          out.push({
            machineId: prof.machineId,
            hostname: prof.hostname || null,
            isSelf: prof.machineId === this._machineId,
            isLeader: leaderMachineId ? prof.machineId === leaderMachineId : false,
            alive: inst ? !!inst.alive : (prof.machineId === this._machineId),
            lastSeen: inst ? (inst.lastSeen || null) : (prof.machineId === this._machineId ? new Date().toISOString() : null),
            updatedAt: prof.updatedAt || null,
            agentCount: prof.agentCount != null ? prof.agentCount : (prof.agents ? prof.agents.length : 0),
            managerCount: prof.managerCount != null ? prof.managerCount : (prof.managers ? prof.managers.length : 0),
            agents: prof.agents || [],
            managers: prof.managers || []
          });
        } catch {}
      }
    } catch (err) {
      console.warn('[config-sync] listMachines failed:', err.message);
    }
    out.sort((a, b) => (b.isSelf - a.isSelf) || (b.isLeader - a.isLeader) || String(a.hostname).localeCompare(String(b.hostname)));
    return out;
  }

  /**
   * Download the full latest snapshot files for a given machine's namespace.
   * Returns { machineId, version, files: { fileName: content } } including the synced
   * JSON files and the plugins/mcp-configs ".tar.json" maps. Read-only; powers install.
   */
  async getMachineSnapshotFiles(machineId) {
    if (!this._enabled) throw new Error('Sync not enabled');
    if (!machineId) throw new Error('machineId is required');
    const manifestBlob = this._containerClient.getBlockBlobClient(this._machineManifestName(machineId));
    let manifest;
    try {
      const dl = await manifestBlob.download(0);
      manifest = JSON.parse(await this._streamToString(dl.readableStreamBody));
    } catch (err) {
      if (err.statusCode === 404) throw new Error(`No cloud config found for machine ${machineId}`);
      throw err;
    }
    const prefix = `${this._machinePrefix(machineId)}snapshots/${manifest.version}/`;
    const files = {};
    for (const name of (manifest.files || [])) {
      try {
        const blob = this._containerClient.getBlockBlobClient(`${prefix}${name}`);
        const dl = await blob.download(0);
        files[name] = await this._streamToString(dl.readableStreamBody);
      } catch (err) {
        if (err.statusCode !== 404) console.warn(`[config-sync] getMachineSnapshotFiles ${name}:`, err.message);
      }
    }
    return { machineId, version: manifest.version, files };
  }

  // --- Private methods ---

  _loadSyncConfig() {
    if (fs.existsSync(SYNC_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(SYNC_CONFIG_PATH, 'utf-8'));
    }
    return { storageAccount: '', machineId: '', containerName: 'agent-supervisor' };
  }

  _generateMachineId() {
    const id = `${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
    this._config.machineId = id;
    fs.writeFileSync(SYNC_CONFIG_PATH, JSON.stringify(this._config, null, 2));
    return id;
  }

  async _initBlobClient() {
    const account = this._config.storageAccount;
    const url = `https://${account}.blob.core.windows.net`;
    const credential = new DefaultAzureCredential();
    this._blobClient = new BlobServiceClient(url, credential);
    const containerName = this._config.containerName || 'agent-supervisor';
    this._containerClient = this._blobClient.getContainerClient(containerName);
  }

  async _ensureContainer() {
    try {
      await this._containerClient.createIfNotExists();
    } catch (err) {
      if (err.statusCode !== 409) throw err;
    }
  }

  async _tryAcquireLease(forceNewEpoch = false, _reclaimAttempted = false, _throwOnConflict = false) {
    const leaderBlob = this._containerClient.getBlockBlobClient(LEADER_BLOB);
    // Ensure blob exists
    try {
      await leaderBlob.getProperties();
    } catch (err) {
      if (err.statusCode === 404) {
        const initial = JSON.stringify({ machineId: null, epoch: 0, hostname: '', startedAt: null, lastHeartbeat: null });
        await leaderBlob.upload(initial, initial.length);
      } else throw err;
    }

    // Try to acquire lease
    this._leaseClient = leaderBlob.getBlobLeaseClient();
    try {
      const lease = await this._leaseClient.acquireLease(LEASE_DURATION);
      this._leaseId = lease.leaseId;
      this._isLeader = true;

      // Read current epoch and bump
      const dl = await leaderBlob.download(0);
      const text = await this._streamToString(dl.readableStreamBody);
      let leaderData = {};
      try { leaderData = JSON.parse(text); } catch {}
      this._epoch = (leaderData.epoch || 0) + (forceNewEpoch ? 1 : (leaderData.machineId === this._machineId ? 0 : 1));

      // Write leader info
      const info = {
        machineId: this._machineId,
        hostname: os.hostname(),
        epoch: this._epoch,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        appVersion: require('./package.json').version || '1.0.0'
      };
      await leaderBlob.upload(JSON.stringify(info, null, 2), JSON.stringify(info, null, 2).length, {
        conditions: { leaseId: this._leaseId }
      });

      // Start renewal
      this._startLeaseRenewal();
      this._onLeaderChange(true, this._epoch);
      console.log(`[config-sync] Acquired leadership. Epoch: ${this._epoch}`);
    } catch (err) {
      if (err.statusCode === 409) {
        // If a caller is retrying a reclaim, let them handle the conflict via retry.
        if (_throwOnConflict) throw err;

        // Lease held — find out by whom
        let leaderData = {};
        try {
          const dl = await leaderBlob.download(0);
          const text = await this._streamToString(dl.readableStreamBody);
          leaderData = JSON.parse(text);
        } catch {}

        // If the stale lease belongs to THIS machine (e.g. a just-killed previous
        // process of ours that didn't release the lease gracefully), reclaim it
        // rather than demoting ourselves to standby and pulling stale cloud config.
        if (!forceNewEpoch && !_reclaimAttempted && leaderData.machineId === this._machineId) {
          console.log('[config-sync] Stale lease held by this machine — breaking and reclaiming leadership.');
          try {
            await leaderBlob.breakLease(0);
          } catch (bErr) {
            console.warn('[config-sync] breakLease failed (continuing):', bErr.message);
          }
          // Azure needs a moment after a break before a new acquire succeeds; retry a few times.
          for (let attempt = 0; attempt < 6; attempt++) {
            await new Promise(r => setTimeout(r, 1500));
            try {
              return await this._tryAcquireLease(false, true, true);
            } catch (reErr) {
              // 409/412 => lease not yet acquirable; keep retrying.
              if (reErr.statusCode !== 409 && reErr.statusCode !== 412) {
                console.warn('[config-sync] Reclaim attempt error:', reErr.message);
              }
            }
          }
          console.warn('[config-sync] Could not reclaim own lease after retries — running as standby.');
        }

        // Lease genuinely held by another machine (or reclaim exhausted)
        this._isLeader = false;
        this._leaseId = null;
        this._epoch = leaderData.epoch || 0;
        this._onLeaderChange(false, this._epoch);
        console.log(`[config-sync] Another machine is leader. Running as standby.`);
      } else throw err;
    }
  }

  _startLeaseRenewal() {
    if (this._renewTimer) clearInterval(this._renewTimer);
    this._renewTimer = setInterval(async () => {
      if (!this._leaseId || !this._leaseClient) return;
      try {
        await this._leaseClient.renewLease();
        // Update heartbeat
        const leaderBlob = this._containerClient.getBlockBlobClient(LEADER_BLOB);
        const info = {
          machineId: this._machineId,
          hostname: os.hostname(),
          epoch: this._epoch,
          startedAt: null, // keep existing
          lastHeartbeat: new Date().toISOString(),
          appVersion: require('./package.json').version || '1.0.0'
        };
        await leaderBlob.upload(JSON.stringify(info, null, 2), JSON.stringify(info, null, 2).length, {
          conditions: { leaseId: this._leaseId }
        }).catch(() => {}); // non-critical
      } catch (err) {
        console.error('[config-sync] Lease renewal failed:', err.message);
        this._isLeader = false;
        this._leaseId = null;
        this._onLeaderChange(false, this._epoch);
        clearInterval(this._renewTimer);
        // Try to re-acquire after a delay
        setTimeout(() => this._tryAcquireLease().catch(() => {}), 5000);
      }
    }, RENEW_INTERVAL);
  }

  async _releaseLease() {
    if (this._leaseClient && this._leaseId) {
      try {
        await this._leaseClient.releaseLease();
      } catch {}
      this._isLeader = false;
      this._leaseId = null;
    }
  }

  _startPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(async () => {
      try {
        // Honor any pending leadership-handoff request targeting this machine.
        await this._checkLeaderRequest();
        // If not leader, try to acquire
        if (!this._isLeader) {
          await this._tryAcquireLease();
        }
        // Refresh this instance's presence in the shared registry.
        await this._registerPresence();
      } catch (err) {
        // Suppress polling errors
      }
    }, POLL_INTERVAL);
  }

  /** Read this machine's own manifest ETag (best-effort; informational only). */
  async _captureManifestEtag() {
    try {
      const manifestBlob = this._containerClient.getBlockBlobClient(this._machineManifestName());
      const props = await manifestBlob.getProperties();
      this._lastManifestETag = props.etag;
    } catch (err) {
      this._lastManifestETag = null;
    }
  }

  /**
   * Capture machine-owned local data that must survive a config pull:
   * RBAC users + connected assets (events-config.json) and agent capability
   * metadata (agents.json description/skills). Returns a plain snapshot object.
   */
  _captureLocalOwnedData() {
    const out = { users: null, connectedAssets: null, agentMeta: {}, localAgents: [] };
    try {
      const evPath = path.join(__dirname, 'events-config.json');
      if (fs.existsSync(evPath)) {
        const ev = JSON.parse(fs.readFileSync(evPath, 'utf-8'));
        if (Array.isArray(ev.users)) out.users = ev.users;
        if (Array.isArray(ev.connectedAssets)) out.connectedAssets = ev.connectedAssets;
      }
    } catch {}
    try {
      const agPath = path.join(__dirname, 'agents.json');
      if (fs.existsSync(agPath)) {
        const agents = JSON.parse(fs.readFileSync(agPath, 'utf-8'));
        if (Array.isArray(agents)) {
          // Capture the FULL current local agent set. Any agent present here at
          // pull-start but missing from the freshly-pulled (possibly stale)
          // cloud snapshot is re-added in _reapplyLocalOwnedData so a sync pull
          // can never silently delete a locally-installed agent (e.g. one added
          // via the Azure DevOps install path). Because this snapshot is taken
          // from the CURRENT local file, an agent the user just deleted is
          // already absent here and will not be resurrected.
          out.localAgents = agents.filter(a => a && a.id);
          for (const a of agents) {
            if (!a || !a.id) continue;
            if (a.description != null || a.skills != null) {
              out.agentMeta[a.id] = { description: a.description, skills: a.skills };
            }
          }
        }
      }
    } catch {}
    return out;
  }

  /**
   * Re-merge previously-captured machine-owned local data into the freshly-pulled
   * files. Users and connected assets are unioned by id with LOCAL taking
   * precedence (so cloud can add entries but never wipes local ones). Agent
   * description/skills are restored from local when local had them.
   */
  _reapplyLocalOwnedData(preserved) {
    if (!preserved) return;
    // events-config.json — union users + connectedAssets (local wins)
    try {
      const evPath = path.join(__dirname, 'events-config.json');
      if (fs.existsSync(evPath)) {
        const ev = JSON.parse(fs.readFileSync(evPath, 'utf-8'));
        let changed = false;
        const unionById = (cloudArr, localArr) => {
          const map = new Map();
          for (const item of (Array.isArray(cloudArr) ? cloudArr : [])) {
            if (item && item.id != null) map.set(item.id, item);
          }
          for (const item of (Array.isArray(localArr) ? localArr : [])) {
            if (item && item.id != null) map.set(item.id, item); // local wins
          }
          return Array.from(map.values());
        };
        if (preserved.users) {
          ev.users = unionById(ev.users, preserved.users);
          changed = true;
        }
        if (preserved.connectedAssets) {
          ev.connectedAssets = unionById(ev.connectedAssets, preserved.connectedAssets);
          changed = true;
        }
        if (changed) fs.writeFileSync(evPath, JSON.stringify(ev, null, 2));
      }
    } catch (err) {
      console.warn('[config-sync] Failed to reapply local users/assets:', err.message);
    }
    // agents.json — re-add locally-present agents the pull dropped, then
    // restore description/skills from local when present.
    try {
      const agPath = path.join(__dirname, 'agents.json');
      if (fs.existsSync(agPath)) {
        const agents = JSON.parse(fs.readFileSync(agPath, 'utf-8'));
        if (Array.isArray(agents)) {
          let changed = false;
          // Union: re-add any agent that existed locally at pull-start but is
          // absent from the freshly-pulled snapshot. The pulled (cloud) version
          // wins for ids present in both; local-only agents are restored so a
          // sync pull never deletes an installed agent.
          const pulledIds = new Set(agents.map(a => a && a.id).filter(Boolean));
          for (const local of (preserved.localAgents || [])) {
            if (local && local.id && !pulledIds.has(local.id)) {
              agents.push(local);
              pulledIds.add(local.id);
              changed = true;
            }
          }
          const meta = preserved.agentMeta || {};
          for (const a of agents) {
            if (!a || !a.id || !meta[a.id]) continue;
            const m = meta[a.id];
            if (m.description != null && a.description == null) { a.description = m.description; changed = true; }
            if (m.skills != null && (a.skills == null || (Array.isArray(a.skills) && a.skills.length === 0))) { a.skills = m.skills; changed = true; }
          }
          if (changed) fs.writeFileSync(agPath, JSON.stringify(agents, null, 2));
        }
      }
    } catch (err) {
      console.warn('[config-sync] Failed to reapply local agent metadata:', err.message);
    }
  }

  async _syncDown() {
    try {
      const manifestBlob = this._containerClient.getBlockBlobClient(this._machineManifestName());
      let manifest;
      try {
        const dl = await manifestBlob.download(0);
        const text = await this._streamToString(dl.readableStreamBody);
        manifest = JSON.parse(text);
        this._lastManifestETag = (await manifestBlob.getProperties()).etag;
      } catch (err) {
        if (err.statusCode === 404) return; // No config uploaded yet for this machine
        throw err;
      }

      const version = manifest.version;
      const prefix = `${this._machinePrefix()}snapshots/${version}/`;

      // Backup local files before overwriting
      this._backupLocal();

      // Capture machine-owned local data that must survive a pull (RBAC users,
      // connected assets, agent capability metadata). A blind overwrite from a
      // stale cloud snapshot would otherwise wipe these and is the root cause of
      // recurring "my user / connected assets / agent descriptions disappeared".
      const preservedLocal = this._captureLocalOwnedData();

      // Download synced files
      for (const fileName of SYNCED_FILES) {
        try {
          const blob = this._containerClient.getBlockBlobClient(`${prefix}${fileName}`);
          const dl = await blob.download(0);
          const content = await this._streamToString(dl.readableStreamBody);
          const destPath = path.join(__dirname, fileName);
          fs.writeFileSync(destPath, content);
        } catch (err) {
          if (err.statusCode !== 404) console.warn(`[config-sync] Failed to pull ${fileName}:`, err.message);
        }
      }

      // Re-merge machine-owned local data back into the freshly-pulled files.
      this._reapplyLocalOwnedData(preservedLocal);

      // Download plugin/mcp tarballs and extract
      for (const dirName of SYNCED_DIRS) {
        try {
          const tarBlobName = `${prefix}${dirName}.tar.json`;
          const blob = this._containerClient.getBlockBlobClient(tarBlobName);
          const dl = await blob.download(0);
          const text = await this._streamToString(dl.readableStreamBody);
          const files = JSON.parse(text); // {relativePath: content} map
          const destDir = syncedDirPath(dirName);
          fs.mkdirSync(destDir, { recursive: true });
          for (const [relPath, content] of Object.entries(files)) {
            const fullPath = path.join(destDir, relPath.replace(/\//g, path.sep));
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content);
          }
        } catch (err) {
          if (err.statusCode !== 404) console.warn(`[config-sync] Failed to pull ${dirName}:`, err.message);
        }
      }

      this._localVersion = version;
      this._dirty = false;
      this._onConfigPulled(version);
      console.log(`[config-sync] Pulled config version ${version}`);
    } catch (err) {
      console.error('[config-sync] Sync-down failed:', err.message);
    }
  }

  async _createSnapshot() {
    const snapshot = {};
    // Synced JSON files (raw — no path rewriting; configs are machine-local)
    for (const fileName of SYNCED_FILES) {
      const filePath = path.join(__dirname, fileName);
      if (fs.existsSync(filePath)) {
        snapshot[fileName] = fs.readFileSync(filePath, 'utf-8');
      }
    }
    // Synced directories (as JSON file maps — simpler than actual tar)
    for (const dirName of SYNCED_DIRS) {
      const dirPath = syncedDirPath(dirName);
      if (fs.existsSync(dirPath)) {
        const files = {};
        this._collectFiles(dirPath, '', files);
        snapshot[`${dirName}.tar.json`] = JSON.stringify(files, null, 2);
      }
    }
    return snapshot;
  }

  /**
   * Build a lightweight catalog of this machine's agents/managers so other machines
   * can browse capabilities without downloading the full snapshot.
   */
  _buildProfileCatalog() {
    const readJson = (f) => {
      try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf-8')); } catch { return null; }
    };
    const agents = Array.isArray(readJson('agents.json')) ? readJson('agents.json') : [];
    const managers = Array.isArray(readJson('managers.json')) ? readJson('managers.json') : [];
    return {
      machineId: this._machineId,
      hostname: os.hostname(),
      updatedAt: new Date().toISOString(),
      agentCount: agents.length,
      managerCount: managers.length,
      agents: agents.map(a => ({ id: a.id, name: a.name || a.id, description: a.description || '' })),
      managers: managers.map(m => ({ id: m.id, name: m.name || m.id, org: Array.isArray(m.org) ? m.org : [] }))
    };
  }

  async _uploadSnapshot(snapshot) {
    const version = Date.now();
    const prefix = `${this._machinePrefix()}snapshots/${version}/`;

    // Upload each file in the snapshot
    for (const [name, content] of Object.entries(snapshot)) {
      const blob = this._containerClient.getBlockBlobClient(`${prefix}${name}`);
      await blob.upload(content, Buffer.byteLength(content), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    }

    // Update this machine's manifest. Single writer per namespace → no ifMatch needed.
    const manifest = {
      version,
      updatedAt: new Date().toISOString(),
      updatedBy: this._machineId,
      files: Object.keys(snapshot)
    };
    const manifestBlob = this._containerClient.getBlockBlobClient(this._machineManifestName());
    const manifestContent = JSON.stringify(manifest, null, 2);
    const result = await manifestBlob.upload(manifestContent, Buffer.byteLength(manifestContent), {
      blobHTTPHeaders: { blobContentType: 'application/json' }
    });
    this._lastManifestETag = result.etag;
    this._localVersion = version;

    // Publish a lightweight capability catalog for cross-machine browse.
    try {
      const catalog = JSON.stringify(this._buildProfileCatalog(), null, 2);
      const profileBlob = this._containerClient.getBlockBlobClient(this._machineProfileName());
      await profileBlob.upload(catalog, Buffer.byteLength(catalog), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    } catch (err) {
      console.warn('[config-sync] Failed to publish profile catalog:', err.message);
    }
  }

  _backupLocal() {
    const backupDir = path.join(__dirname, '.config-backup');
    fs.mkdirSync(backupDir, { recursive: true });
    for (const fileName of SYNCED_FILES) {
      const src = path.join(__dirname, fileName);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, fileName));
      }
    }
  }

  _collectFiles(dir, prefix, result) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this._collectFiles(fullPath, relPath, result);
      } else {
        result[relPath] = fs.readFileSync(fullPath, 'utf-8');
      }
    }
  }

  async _streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
}

module.exports = ConfigSync;
module.exports.SUPERVISOR_DATA_DIR = SUPERVISOR_DATA_DIR;
module.exports.PLUGINS_DIR = PLUGINS_DIR;
module.exports.MCP_CONFIGS_DIR = path.join(SUPERVISOR_DATA_DIR, 'mcp-configs');
module.exports.syncedDirPath = syncedDirPath;
