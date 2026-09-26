const fs = require('fs');
const crypto = require('crypto');
const { dataPath } = require('./data-paths');

const STORE_PATH = dataPath('dev-buddy.json');

function blankStore() {
  return {
    version: 3,
    items: [],
    commitments: [],
    commitmentSync: { lastAttemptAt: null, lastSuccessAt: null, error: '' },
    dismissedSignals: {},
    signalStates: {},
    activity: [],
    manualOrder: [],
    updatedAt: new Date().toISOString(),
  };
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      ...blankStore(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      items: Array.isArray(parsed && parsed.items) ? parsed.items : [],
      commitments: Array.isArray(parsed && parsed.commitments) ? parsed.commitments : [],
      commitmentSync: parsed && parsed.commitmentSync && typeof parsed.commitmentSync === 'object'
        ? { ...blankStore().commitmentSync, ...parsed.commitmentSync }
        : blankStore().commitmentSync,
      manualOrder: Array.isArray(parsed && parsed.manualOrder) ? parsed.manualOrder : [],
      activity: Array.isArray(parsed && parsed.activity) ? parsed.activity : [],
      dismissedSignals: parsed && typeof parsed.dismissedSignals === 'object' && !Array.isArray(parsed.dismissedSignals)
        ? parsed.dismissedSignals
        : {},
      signalStates: parsed && typeof parsed.signalStates === 'object' && !Array.isArray(parsed.signalStates)
        ? parsed.signalStates
        : {},
    };
  } catch {
    return blankStore();
  }
}

function writeStore(store) {
  const next = { ...store, updatedAt: new Date().toISOString() };
  const temp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(require('path').dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { flag: 'wx' });
  fs.renameSync(temp, STORE_PATH);
  return next;
}

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizePriority(value) {
  return ['high', 'normal', 'low'].includes(value) ? value : 'normal';
}

function recordActivity(store, type, id, title, source) {
  store.activity.push({
    id: cleanText(id, 800),
    title: cleanText(title, 180),
    source: cleanText(source, 80),
    type: cleanText(type, 40),
    at: new Date().toISOString(),
  });
  store.activity = store.activity.slice(-500);
}

function recordCompletion(store, id, title, source) {
  recordActivity(store, 'completed', id, title, source);
}

const DEDUPE_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'been', 'before', 'being', 'could', 'from',
  'have', 'into', 'need', 'needs', 'please', 'should', 'that', 'their', 'them',
  'then', 'there', 'these', 'this', 'through', 'using', 'with', 'would', 'your',
  'action', 'follow', 'followup', 'item', 'request', 'task',
]);

function commitmentTerms(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(term => term.length >= 4 && !DEDUPE_STOP_WORDS.has(term)))];
}

function commitmentsMatch(left, right) {
  if (!left || !right) return false;
  const leftLink = cleanText(left.link, 1200).toLowerCase();
  const rightLink = cleanText(right.link, 1200).toLowerCase();
  if (leftLink && rightLink && leftLink === rightLink) return true;
  const a = commitmentTerms(`${left.title || ''} ${left.detail || ''}`);
  const b = commitmentTerms(`${right.title || ''} ${right.detail || ''}`);
  if (!a.length || !b.length) return false;
  const bSet = new Set(b);
  const overlap = a.filter(term => bSet.has(term)).length;
  const union = new Set([...a, ...b]).size;
  const similarity = union ? overlap / union : 0;
  const coverage = overlap / Math.min(a.length, b.length);
  if (similarity >= 0.55 || (overlap >= 3 && coverage >= 0.72)) return true;
  const leftDue = Date.parse(left.dueAt || '');
  const rightDue = Date.parse(right.dueAt || '');
  return overlap >= 2 && coverage >= 0.8 &&
    Number.isFinite(leftDue) && Number.isFinite(rightDue) &&
    Math.abs(leftDue - rightDue) <= 24 * 60 * 60 * 1000;
}

function businessHoursBetween(startValue, endValue = Date.now()) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return 0;
  let cursor = new Date(start);
  let elapsed = 0;
  while (cursor < end) {
    const next = new Date(cursor);
    next.setHours(24, 0, 0, 0);
    const segmentEnd = next < end ? next : end;
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) {
      elapsed += segmentEnd.getTime() - cursor.getTime();
    }
    cursor = segmentEnd;
  }
  return elapsed / 3600000;
}

function describeAge(value, nowValue = Date.now()) {
  const then = Date.parse(value || '');
  const now = new Date(nowValue).getTime();
  if (!Number.isFinite(then) || !Number.isFinite(now) || now <= then) return 'just now';
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function deriveUrgency(input = {}, nowValue = Date.now()) {
  const levels = ['low', 'medium', 'high', 'critical'];
  const priorityBase = { low: 0, normal: 1, high: 2 };
  let score = priorityBase[normalizePriority(input.priority)] ?? 1;
  let reason = score >= 2 ? 'Marked high priority.' : 'No immediate deadline.';
  const now = new Date(nowValue).getTime();
  const trackedAt = Date.parse(input.trackedAt || input.createdAt || '');
  const ageHours = Number.isFinite(trackedAt) ? Math.max(0, (now - trackedAt) / 3600000) : 0;
  const dueAt = Date.parse(input.dueAt || '');

  if (Number.isFinite(dueAt)) {
    const remainingHours = (dueAt - now) / 3600000;
    if (remainingHours <= 0) {
      score = 3;
      reason = 'Past its due time.';
    } else if (remainingHours <= 24) {
      score = Math.max(score, 2);
      reason = 'Due within 24 hours.';
    } else if (remainingHours <= 72) {
      score = Math.max(score, 1);
      reason = 'Due within three days.';
    }
  } else if (input.slaBusinessHours) {
    const elapsed = businessHoursBetween(input.trackedAt || input.createdAt, now);
    const sla = Math.max(1, Number(input.slaBusinessHours) || 24);
    if (elapsed >= sla) {
      score = 3;
      reason = `Past the ${sla}-business-hour response target.`;
    } else if (elapsed >= sla * 0.66) {
      score = Math.max(score, 2);
      reason = `Approaching the ${sla}-business-hour response target.`;
    } else if (elapsed >= sla * 0.33) {
      score = Math.max(score, 1);
      reason = `Response target is ${sla} business hours.`;
    }
  } else if (ageHours >= 168) {
    score = Math.max(score, 2);
    reason = 'Tracked for at least one week.';
  } else if (ageHours >= 72) {
    score = Math.max(score, 1);
    reason = 'Tracked for at least three days.';
  }

  const level = levels[Math.max(0, Math.min(levels.length - 1, score))];
  return {
    level,
    label: level.charAt(0).toUpperCase() + level.slice(1),
    reason,
    score,
  };
}

function deriveMood(input = {}) {
  const count = value => Math.max(0, Number(value) || 0);
  const attention = count(input.attention);
  const tracking = count(input.tracking);
  const remembered = count(input.remembered);
  const completedToday = count(input.completedToday);
  const completedRecently = input.lastCompletedAt &&
    Date.now() - Date.parse(input.lastCompletedAt) < 20 * 60 * 1000;
  const day = input.day && typeof input.day === 'object' ? input.day : {};
  const dayPressure = Math.min(12, count(day.pressure));
  const openLoad = attention * 3 + tracking + Math.min(remembered, 8) + dayPressure;
  const score = Math.max(0, openLoad - Math.min(completedToday, 5));

  if (attention >= 3 || count(day.conflicts) > 0 || score >= 18) {
    return {
      id: 'overloaded',
      label: 'Overloaded',
      detail: 'A lot is competing for your attention.',
      score,
    };
  }
  if (completedRecently || (completedToday >= 2 && score < 9)) {
    return {
      id: 'happy',
      label: completedRecently ? 'Celebrating' : 'Happy',
      detail: completedRecently ? 'Nice work — one less loose end.' : `${completedToday} things finished today.`,
      score,
    };
  }
  if (attention > 0 || score >= 9) {
    return {
      id: 'concerned',
      label: 'Concerned',
      detail: 'A few things need a closer look.',
      score,
    };
  }
  if (tracking > 0 || remembered > 0 || dayPressure >= 4) {
    return {
      id: 'focused',
      label: 'Focused',
      detail: 'Keeping watch while you work.',
      score,
    };
  }
  return {
    id: 'calm',
    label: 'Calm',
    detail: 'Nothing urgent is pulling at you.',
    score,
  };
}

function listItems() {
  const store = readStore();
  const now = Date.now();
  return store.items
    .filter(item => item && !['done', 'dismissed'].includes(item.status))
    .map(item => ({
      ...item,
      snoozed: !!(item.snoozedUntil && Date.parse(item.snoozedUntil) > now),
    }))
    .sort((a, b) => {
      const rank = { high: 0, normal: 1, low: 2 };
      return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) ||
        Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
    });
}

function addItem(input = {}) {
  const title = cleanText(input.title, 160);
  if (!title) throw new Error('A title is required.');
  const store = readStore();
  const now = new Date().toISOString();
  const item = {
    id: `buddy-${crypto.randomUUID()}`,
    title,
    detail: cleanText(input.detail, 500),
    priority: normalizePriority(input.priority),
    source: cleanText(input.source, 80) || 'You',
    link: cleanText(input.link, 1200),
    dueAt: Number.isFinite(Date.parse(input.dueAt || '')) ? new Date(input.dueAt).toISOString() : null,
    status: 'open',
    snoozedUntil: null,
    createdAt: now,
    updatedAt: now,
  };
  store.items.push(item);
  writeStore(store);
  return item;
}

function updateItem(id, patch = {}) {
  const store = readStore();
  const item = store.items.find(entry => entry && entry.id === id);
  if (!item) return null;
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
    const title = cleanText(patch.title, 160);
    if (!title) throw new Error('A title is required.');
    item.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'detail')) item.detail = cleanText(patch.detail, 500);
  if (Object.prototype.hasOwnProperty.call(patch, 'priority')) {
    const priority = normalizePriority(patch.priority);
    if (priority !== item.priority) recordActivity(store, 'reprioritized', item.id, item.title, item.source);
    item.priority = priority;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'dueAt')) {
    const parsed = Date.parse(patch.dueAt || '');
    item.dueAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (['done', 'dismissed', 'open'].includes(patch.status)) {
    if (patch.status === 'done' && item.status !== 'done') recordCompletion(store, item.id, item.title, item.source);
    if (patch.status === 'dismissed' && item.status !== 'dismissed') {
      recordActivity(store, 'dismissed', item.id, item.title, item.source);
    }
    item.status = patch.status;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'snoozedUntil')) {
    const parsed = Date.parse(patch.snoozedUntil || '');
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      recordActivity(store, 'deferred', item.id, item.title, item.source);
    }
    item.snoozedUntil = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  item.updatedAt = new Date().toISOString();
  writeStore(store);
  return item;
}

function upsertCommitments(list) {
  const store = readStore();
  const byExternalId = new Map();
  store.commitments.forEach((item, index) => {
    for (const externalId of [item.externalId, ...(Array.isArray(item.externalIds) ? item.externalIds : [])]) {
      if (externalId) byExternalId.set(externalId, index);
    }
  });
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  let deduplicated = 0;
  for (const raw of (Array.isArray(list) ? list : [])) {
    const externalId = cleanText(raw && raw.externalId, 800);
    const title = cleanText(raw && raw.title, 180);
    if (!externalId || !title) continue;
    const source = ['email', 'teams', 'meeting', 'calendar'].includes(raw.source) ? raw.source : 'other';
    const due = Date.parse(raw.dueAt || '');
    const observed = Date.parse(raw.observedAt || '');
    const normalized = {
      externalId,
      source,
      title,
      detail: cleanText(raw.detail, 600),
      link: cleanText(raw.link, 1200),
      dueAt: Number.isFinite(due) ? new Date(due).toISOString() : null,
      observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : now,
      confidence: raw.confidence === 'high' ? 'high' : 'normal',
      lastSeenAt: now,
    };
    let index = byExternalId.get(externalId);
    if (index == null) {
      const duplicateIndex = store.commitments.findIndex(item => commitmentsMatch(item, normalized));
      if (duplicateIndex >= 0) {
        index = duplicateIndex;
        deduplicated++;
      }
    }
    if (index == null) {
      const item = {
        id: `commitment-${crypto.createHash('sha256').update(externalId).digest('hex').slice(0, 20)}`,
        ...normalized,
        externalIds: [externalId],
        sources: [source],
        links: normalized.link ? [{ source, url: normalized.link }] : [],
        status: 'open',
        createdAt: now,
        updatedAt: now,
      };
      store.commitments.push(item);
      byExternalId.set(externalId, store.commitments.length - 1);
      added++;
    } else {
      const current = store.commitments[index];
      const externalIds = [...new Set([
        current.externalId,
        ...(Array.isArray(current.externalIds) ? current.externalIds : []),
        externalId,
      ].filter(Boolean))];
      const sources = [...new Set([
        current.source,
        ...(Array.isArray(current.sources) ? current.sources : []),
        source,
      ].filter(Boolean))];
      const links = [
        ...(Array.isArray(current.links) ? current.links : (current.link ? [{ source: current.source, url: current.link }] : [])),
        ...(normalized.link ? [{ source, url: normalized.link }] : []),
      ].filter((entry, linkIndex, all) => entry.url && all.findIndex(other => other.url === entry.url) === linkIndex);
      store.commitments[index] = {
        ...current,
        ...normalized,
        // A weaker later collection must never erase a source link that made
        // the item actionable. Prefer the newest exact link, then the existing
        // primary link, then any previously merged source link.
        link: normalized.link || current.link || (links[0] && links[0].url) || '',
        externalId: current.externalId || externalId,
        externalIds,
        sources,
        links,
        priority: current.priority || normalized.priority,
        snoozedUntil: current.snoozedUntil || null,
        status: ['done', 'dismissed'].includes(current.status) ? current.status : 'open',
        updatedAt: now,
      };
      for (const id of externalIds) byExternalId.set(id, index);
      updated++;
    }
  }
  store.commitments = store.commitments.slice(-500);
  writeStore(store);
  return { added, updated, deduplicated };
}

function listCommitments() {
  const now = Date.now();
  return readStore().commitments
    .filter(item => item && item.status !== 'done' && item.status !== 'dismissed')
    .filter(item => !(item.snoozedUntil && Date.parse(item.snoozedUntil) > now))
    .map(item => ({
      ...item,
      link: item.link || (
        Array.isArray(item.links) &&
        item.links.find(entry => entry && entry.url) &&
        item.links.find(entry => entry && entry.url).url
      ) || '',
    }))
    .sort((a, b) => {
      const aDue = Date.parse(a.dueAt || '');
      const bDue = Date.parse(b.dueAt || '');
      if (Number.isFinite(aDue) || Number.isFinite(bDue)) {
        if (!Number.isFinite(aDue)) return 1;
        if (!Number.isFinite(bDue)) return -1;
        if (aDue !== bDue) return aDue - bDue;
      }
      return Date.parse(b.observedAt || b.createdAt || 0) - Date.parse(a.observedAt || a.createdAt || 0);
    });
}

function completeCommitment(id) {
  return updateCommitment(id, { status: 'done' });
}

function updateCommitment(id, patch = {}) {
  const store = readStore();
  const item = store.commitments.find(entry => entry && entry.id === id);
  if (!item) return null;
  if (Object.prototype.hasOwnProperty.call(patch, 'priority')) {
    const priority = normalizePriority(patch.priority);
    if (priority !== item.priority) {
      recordActivity(store, 'reprioritized', item.id, item.title, item.sources && item.sources.join(', ') || item.source);
    }
    item.priority = priority;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'snoozedUntil')) {
    const parsed = Date.parse(patch.snoozedUntil || '');
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      recordActivity(store, 'deferred', item.id, item.title, item.sources && item.sources.join(', ') || item.source);
    }
    item.snoozedUntil = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (['done', 'dismissed', 'open'].includes(patch.status)) {
    if (patch.status === 'done' && item.status !== 'done') {
      recordCompletion(store, item.id, item.title, item.sources && item.sources.join(', ') || item.source);
    }
    if (patch.status === 'dismissed' && item.status !== 'dismissed') {
      recordActivity(store, 'dismissed', item.id, item.title, item.sources && item.sources.join(', ') || item.source);
    }
    item.status = patch.status;
  }
  item.updatedAt = new Date().toISOString();
  writeStore(store);
  return item;
}

function getCommitmentSync() {
  return { ...readStore().commitmentSync };
}

function setCommitmentSync(patch = {}) {
  const store = readStore();
  store.commitmentSync = { ...store.commitmentSync, ...patch };
  writeStore(store);
  return { ...store.commitmentSync };
}

function dismissSignal(fingerprint, until) {
  const key = cleanText(fingerprint, 500);
  if (!key) return;
  const parsed = Date.parse(until || '');
  const store = readStore();
  store.dismissedSignals[key] = Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  recordActivity(store, 'deferred', key, '', 'Pixel');
  writeStore(store);
}

function isSignalDismissed(fingerprint) {
  const store = readStore();
  const key = cleanText(fingerprint, 500);
  const until = store.dismissedSignals[key];
  const state = store.signalStates[key];
  return !!(
    (until && Date.parse(until) > Date.now()) ||
    (state && ['done', 'dismissed'].includes(state.status))
  );
}

function getSignalState(fingerprint) {
  const key = cleanText(fingerprint, 500);
  const state = readStore().signalStates[key];
  return state && typeof state === 'object' ? { ...state } : {};
}

function updateSignal(fingerprint, patch = {}, item = {}) {
  const key = cleanText(fingerprint, 500);
  if (!key) return null;
  const store = readStore();
  const current = store.signalStates[key] && typeof store.signalStates[key] === 'object'
    ? store.signalStates[key]
    : {};
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, 'priority')) {
    const priority = normalizePriority(patch.priority);
    if (priority !== current.priority) recordActivity(store, 'reprioritized', key, item.title, item.source);
    next.priority = priority;
  }
  if (['done', 'dismissed', 'open'].includes(patch.status)) {
    if (patch.status === 'done' && current.status !== 'done') {
      recordCompletion(store, key, item.title, item.source);
    }
    if (patch.status === 'dismissed' && current.status !== 'dismissed') {
      recordActivity(store, 'dismissed', key, item.title, item.source);
    }
    next.status = patch.status;
  }
  next.updatedAt = new Date().toISOString();
  store.signalStates[key] = next;
  if (Object.prototype.hasOwnProperty.call(patch, 'snoozedUntil')) {
    const parsed = Date.parse(patch.snoozedUntil || '');
    if (Number.isFinite(parsed)) {
      if (parsed > Date.now()) recordActivity(store, 'deferred', key, item.title, item.source);
      store.dismissedSignals[key] = new Date(parsed).toISOString();
    }
  }
  writeStore(store);
  return { ...next };
}

function getProgress(open = 0) {
  const store = readStore();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = store.activity.filter(entry => entry && Date.parse(entry.at || '') >= start.getTime());
  const uniqueCount = types => new Set(today
    .filter(entry => types.includes(entry.type))
    .map(entry => entry.id)
    .filter(Boolean)).size;
  const addressedEntries = today.filter(entry => ['completed', 'dismissed'].includes(entry.type));
  const latest = addressedEntries.reduce((value, entry) => {
    const parsed = Date.parse(entry.at || '');
    return Number.isFinite(parsed) ? Math.max(value, parsed) : value;
  }, 0);
  const openItems = Array.isArray(open) ? open.filter(Boolean) : null;
  const openCount = openItems ? openItems.length : Math.max(0, Number(open) || 0);
  const addressedCount = uniqueCount(['completed', 'dismissed']);
  const deferredCount = uniqueCount(['deferred', 'reprioritized']);
  const activityIds = new Set(today.map(entry => entry.id).filter(Boolean));
  const trackedIds = openItems
    ? new Set([...openItems.map(item => item && item.id).filter(Boolean), ...activityIds])
    : null;
  const total = trackedIds ? trackedIds.size : openCount + activityIds.size;
  return {
    open: openCount,
    totalTrackedToday: total,
    addressedToday: addressedCount,
    deferredToday: deferredCount,
    completedToday: addressedCount,
    completionPercent: total ? Math.round(addressedCount / total * 100) : 100,
    lastCompletedAt: latest ? new Date(latest).toISOString() : null,
  };
}

function listRecentActivity(hours = 24) {
  const store = readStore();
  const cutoff = Date.now() - Math.max(1, Math.min(168, Number(hours) || 24)) * 60 * 60 * 1000;
  const grouped = new Map();
  for (const entry of [...store.activity].reverse()) {
    if (!entry || !entry.id || Date.parse(entry.at || '') < cutoff) continue;
    if (!['completed', 'dismissed', 'deferred', 'reprioritized'].includes(entry.type)) continue;
    if (!grouped.has(entry.id)) {
      grouped.set(entry.id, {
        id: entry.id,
        title: entry.title || '',
        source: entry.source || '',
        at: entry.at,
        actions: [],
      });
    }
    const recent = grouped.get(entry.id);
    if (!recent.title && entry.title) recent.title = entry.title;
    if (!recent.source && entry.source) recent.source = entry.source;
    if (!recent.actions.includes(entry.type)) recent.actions.push(entry.type);
  }
  return [...grouped.values()].map(recent => {
    const item = store.items.find(entry => entry && entry.id === recent.id);
    const commitment = store.commitments.find(entry => entry && entry.id === recent.id);
    const signalState = store.signalStates[recent.id] || {};
    const dismissedUntil = Date.parse(store.dismissedSignals[recent.id] || '');
    const target = item || commitment;
    const hidden = target
      ? ['done', 'dismissed'].includes(target.status) ||
        (target.snoozedUntil && Date.parse(target.snoozedUntil) > Date.now())
      : ['done', 'dismissed'].includes(signalState.status) ||
        (Number.isFinite(dismissedUntil) && dismissedUntil > Date.now());
    return {
      ...recent,
      title: recent.title || (target && target.title) || 'Tracked work item',
      source: recent.source || (target && target.source) || 'Pixel',
      canPutBack: hidden && recent.actions.some(type => ['completed', 'dismissed', 'deferred'].includes(type)),
      canRestorePriority: recent.actions.includes('reprioritized') &&
        normalizePriority((target && target.priority) || signalState.priority) !== 'normal',
    };
  });
}

function restoreRecentActivity(id, action = 'put-back') {
  const key = cleanText(id, 800);
  if (!key) return null;
  const store = readStore();
  const item = store.items.find(entry => entry && entry.id === key);
  const commitment = store.commitments.find(entry => entry && entry.id === key);
  const target = item || commitment;
  if (action === 'restore-priority') {
    if (target) target.priority = 'normal';
    else {
      const state = store.signalStates[key] && typeof store.signalStates[key] === 'object'
        ? store.signalStates[key]
        : {};
      store.signalStates[key] = { ...state, priority: 'normal', updatedAt: new Date().toISOString() };
    }
    store.activity = store.activity.filter(entry => !(entry && entry.id === key && entry.type === 'reprioritized'));
  } else if (action === 'put-back') {
    if (target) {
      target.status = 'open';
      target.snoozedUntil = null;
      target.updatedAt = new Date().toISOString();
    } else {
      const state = store.signalStates[key] && typeof store.signalStates[key] === 'object'
        ? store.signalStates[key]
        : {};
      store.signalStates[key] = { ...state, status: 'open', updatedAt: new Date().toISOString() };
      delete store.dismissedSignals[key];
    }
    store.activity = store.activity.filter(entry =>
      !(entry && entry.id === key && ['completed', 'dismissed', 'deferred'].includes(entry.type)));
  } else {
    throw new Error('Unsupported restore action.');
  }
  writeStore(store);
  return { id: key, action };
}

function setManualOrder(ids) {
  const store = readStore();
  store.manualOrder = [...new Set((Array.isArray(ids) ? ids : [])
    .map(id => cleanText(id, 500))
    .filter(Boolean))]
    .slice(0, 500);
  writeStore(store);
  return store.manualOrder;
}

function applyManualOrder(items) {
  const order = readStore().manualOrder;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const aRank = rank.has(a && a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bRank = rank.has(b && b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return (b && b.urgency && b.urgency.score || 0) - (a && a.urgency && a.urgency.score || 0) ||
      Date.parse((a && a.trackedAt) || 0) - Date.parse((b && b.trackedAt) || 0);
  });
}

module.exports = {
  addItem,
  applyManualOrder,
  businessHoursBetween,
  deriveUrgency,
  deriveMood,
  describeAge,
  dismissSignal,
  completeCommitment,
  commitmentsMatch,
  getProgress,
  getCommitmentSync,
  getSignalState,
  isSignalDismissed,
  listRecentActivity,
  listCommitments,
  listItems,
  restoreRecentActivity,
  setManualOrder,
  setCommitmentSync,
  updateCommitment,
  updateSignal,
  upsertCommitments,
  updateItem,
};
