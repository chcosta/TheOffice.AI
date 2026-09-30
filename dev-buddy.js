const fs = require('fs');
const crypto = require('crypto');
const { dataPath } = require('./data-paths');

const STORE_PATH = dataPath('dev-buddy.json');
const STORE_LOCK_PATH = `${STORE_PATH}.lock`;
const DECISIONS_PATH = dataPath('dev-buddy-decisions.json');
const DECISIONS_LOCK_PATH = `${DECISIONS_PATH}.lock`;
const STORE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function blankStore() {
  return {
    version: 5,
    items: [],
    commitments: [],
    efforts: [],
    effortAssignments: {},
    effortSeparations: {},
    commitmentSync: { lastAttemptAt: null, lastSuccessAt: null, error: '' },
    dismissedSignals: {},
    signalStates: {},
    activity: [],
    manualOrder: [],
    updatedAt: new Date().toISOString(),
  };
}

function readDecisionStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DECISIONS_PATH, 'utf8'));
    return {
      ongoing: parsed && parsed.ongoing && typeof parsed.ongoing === 'object'
        ? parsed.ongoing
        : {},
      priority: parsed && parsed.priority && typeof parsed.priority === 'object'
        ? parsed.priority
        : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[dev-buddy] Could not read durable user decisions:', error.message);
    }
    return { ongoing: {}, priority: {} };
  }
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const store = {
      ...blankStore(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      version: blankStore().version,
      items: Array.isArray(parsed && parsed.items) ? parsed.items : [],
      commitments: Array.isArray(parsed && parsed.commitments) ? parsed.commitments : [],
      efforts: Array.isArray(parsed && parsed.efforts) ? parsed.efforts : [],
      effortAssignments: parsed && parsed.effortAssignments &&
        typeof parsed.effortAssignments === 'object' && !Array.isArray(parsed.effortAssignments)
        ? parsed.effortAssignments
        : {},
      effortSeparations: parsed && parsed.effortSeparations &&
        typeof parsed.effortSeparations === 'object' && !Array.isArray(parsed.effortSeparations)
        ? parsed.effortSeparations
        : {},
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
    const decisions = readDecisionStore();
    for (const effort of store.efforts) {
      if (!effort) continue;
      const ongoingDecision = decisions.ongoing[effort.id];
      if (ongoingDecision && typeof ongoingDecision.ongoing === 'boolean') {
        effort.ongoing = ongoingDecision.ongoing;
        effort.ongoingUpdatedAt = ongoingDecision.updatedAt || effort.ongoingUpdatedAt;
      }
      const priorityDecision = decisions.priority[effort.id];
      if (priorityDecision) {
        effort.priority = normalizePriority(priorityDecision.priority);
        effort.urgencyOverrideScore = priorityDecision.urgencyScore;
        effort.priorityUpdatedAt = priorityDecision.updatedAt || effort.priorityUpdatedAt;
      }
    }
    return store;
  } catch {
    return blankStore();
  }
}

function acquireStoreLock(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(require('path').dirname(STORE_PATH), { recursive: true });
  while (Date.now() < deadline) {
    try {
      return fs.openSync(STORE_LOCK_PATH, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(STORE_LOCK_PATH).mtimeMs;
        if (age > 30000) {
          fs.unlinkSync(STORE_LOCK_PATH);
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      Atomics.wait(STORE_LOCK_WAIT, 0, 0, 12);
    }
  }
  throw new Error('Pixel could not save because another update is still in progress.');
}

function writeEffortDecision(section, id, value, updatedAt = new Date().toISOString()) {
  const deadline = Date.now() + 3000;
  fs.mkdirSync(require('path').dirname(DECISIONS_PATH), { recursive: true });
  let lock = null;
  while (Date.now() < deadline && lock === null) {
    try {
      lock = fs.openSync(DECISIONS_LOCK_PATH, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(DECISIONS_LOCK_PATH).mtimeMs > 30000) {
          fs.unlinkSync(DECISIONS_LOCK_PATH);
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      Atomics.wait(STORE_LOCK_WAIT, 0, 0, 12);
    }
  }
  if (lock === null) throw new Error('Pixel could not save your ongoing decision.');
  try {
    const decisions = readDecisionStore();
    decisions[section][id] = { ...value, updatedAt };
    const temp = `${DECISIONS_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(decisions, null, 2), { flag: 'wx' });
    fs.renameSync(temp, DECISIONS_PATH);
  } finally {
    try { fs.closeSync(lock); } catch {}
    try { fs.unlinkSync(DECISIONS_LOCK_PATH); } catch {}
  }
}

function writeOngoingDecision(id, ongoing, updatedAt = new Date().toISOString()) {
  writeEffortDecision('ongoing', id, { ongoing: ongoing === true }, updatedAt);
}

function writePriorityDecision(id, priority, urgencyScore, updatedAt = new Date().toISOString()) {
  writeEffortDecision('priority', id, {
    priority: normalizePriority(priority),
    urgencyScore: urgencyOverride(urgencyScore)?.score ?? null,
  }, updatedAt);
}

function writeStore(store) {
  const lock = acquireStoreLock();
  try {
    const next = { ...store, updatedAt: new Date().toISOString() };
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch {}
    const currentEfforts = new Map((Array.isArray(current && current.efforts) ? current.efforts : [])
      .filter(Boolean).map(effort => [effort.id, effort]));
    for (const effort of Array.isArray(next.efforts) ? next.efforts : []) {
      const saved = currentEfforts.get(effort && effort.id);
      if (!saved) continue;
      const savedAt = Date.parse(saved.ongoingUpdatedAt);
      const nextAt = Date.parse(effort.ongoingUpdatedAt || '');
      if (Number.isFinite(savedAt) && (!Number.isFinite(nextAt) || savedAt >= nextAt)) {
        effort.ongoing = saved.ongoing === true;
        effort.ongoingUpdatedAt = saved.ongoingUpdatedAt;
      }
      const savedPriorityAt = Date.parse(saved.priorityUpdatedAt || '');
      const nextPriorityAt = Date.parse(effort.priorityUpdatedAt || '');
      if (Number.isFinite(savedPriorityAt) &&
          (!Number.isFinite(nextPriorityAt) || savedPriorityAt >= nextPriorityAt)) {
        effort.priority = saved.priority;
        effort.urgencyOverrideScore = saved.urgencyOverrideScore;
        effort.priorityUpdatedAt = saved.priorityUpdatedAt;
      }
    }
    const temp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { flag: 'wx' });
    fs.renameSync(temp, STORE_PATH);
    return next;
  } finally {
    try { fs.closeSync(lock); } catch {}
    try { fs.unlinkSync(STORE_LOCK_PATH); } catch {}
  }
}

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanMessage(value, max = 8000) {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
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
    notes: cleanMessage(input.notes, 12000),
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
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) item.notes = cleanMessage(patch.notes, 12000);
  if (Object.prototype.hasOwnProperty.call(patch, 'starred')) item.starred = patch.starred === true;
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
      message: cleanMessage(raw.message, 8000),
      sender: cleanText(raw.sender, 300),
      subject: cleanText(raw.subject, 500),
      sentAt: Number.isFinite(Date.parse(raw.sentAt || ''))
        ? new Date(Date.parse(raw.sentAt)).toISOString()
        : null,
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
        message: normalized.message || current.message || '',
        sender: normalized.sender || current.sender || '',
        subject: normalized.subject || current.subject || '',
        sentAt: normalized.sentAt || current.sentAt || null,
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
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) item.notes = cleanMessage(patch.notes, 12000);
  if (Object.prototype.hasOwnProperty.call(patch, 'starred')) item.starred = patch.starred === true;
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

function enrichCommitment(id, patch = {}) {
  const store = readStore();
  const item = store.commitments.find(entry => entry && entry.id === id);
  if (!item) return null;
  if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
    item.message = cleanMessage(patch.message, 8000) || item.message || '';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'sender')) {
    item.sender = cleanText(patch.sender, 300) || item.sender || '';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'subject')) {
    item.subject = cleanText(patch.subject, 500) || item.subject || '';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'sentAt')) {
    const parsed = Date.parse(patch.sentAt || '');
    if (Number.isFinite(parsed)) item.sentAt = new Date(parsed).toISOString();
  }
  item.updatedAt = new Date().toISOString();
  writeStore(store);
  return { ...item };
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

function getSignalSnapshot() {
  const store = readStore();
  return {
    dismissedSignals: { ...store.dismissedSignals },
    signalStates: { ...store.signalStates },
  };
}

function updateSignal(fingerprint, patch = {}, item = {}) {
  const key = cleanText(fingerprint, 500);
  if (!key) return null;
  const store = readStore();
  const current = store.signalStates[key] && typeof store.signalStates[key] === 'object'
    ? store.signalStates[key]
    : {};
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) next.notes = cleanMessage(patch.notes, 12000);
  if (Object.prototype.hasOwnProperty.call(patch, 'priority')) {
    const priority = normalizePriority(patch.priority);
    if (priority !== current.priority) recordActivity(store, 'reprioritized', key, item.title, item.source);
    next.priority = priority;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'starred')) next.starred = patch.starred === true;
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

function effortObservationKey(item) {
  return cleanText(
    item && (item.observationKey || item.reminderKey || item.fingerprint || item.id),
    500
  );
}

function effortObservationSnapshot(item, key) {
  const context = item && item.context && typeof item.context === 'object' && !Array.isArray(item.context)
    ? item.context
    : {};
  const snapshot = {
    key,
    id: cleanText(item && item.id, 500),
    externalId: cleanText(item && item.externalId, 800),
    kind: cleanText(item && item.kind, 80) || 'work',
    title: cleanText(item && item.title, 240) || 'Tracked work',
    detail: cleanText(item && (item.semanticComment || item.attentionBlurb || item.detail), 1200),
    source: cleanText(item && item.source, 240),
    link: cleanText(item && item.link, 1600),
    links: (Array.isArray(item && item.links) ? item.links : []).slice(0, 12).map(link => ({
      source: cleanText(link && link.source, 120),
      url: cleanText(link && link.url, 1600),
    })).filter(link => link.url),
    route: cleanText(item && item.route, 500),
    priority: normalizePriority(item && item.priority),
    starred: item && item.starred === true,
    trackedAt: item && (item.trackedAt || item.createdAt || item.updatedAt) || null,
    observedAt: item && item.observedAt || null,
    dueAt: item && item.dueAt || null,
    confidence: cleanText(item && item.confidence, 80),
    message: cleanMessage(item && item.message, 8000),
    sender: cleanText(item && item.sender, 300),
    subject: cleanText(item && item.subject, 500),
    sentAt: item && item.sentAt || null,
    urgency: item && item.urgency && typeof item.urgency === 'object'
      ? {
          score: Number(item.urgency.score) || 0,
          level: cleanText(item.urgency.level, 40),
          label: cleanText(item.urgency.label, 80),
          reason: cleanText(item.urgency.reason, 300),
        }
      : null,
    slaBusinessHours: Number(item && item.slaBusinessHours) || null,
    semanticAttention: item && item.semanticAttention !== false,
    attentionBlurb: cleanText(item && item.attentionBlurb, 600),
    reminderKey: cleanText(item && item.reminderKey, 500),
    fingerprint: cleanText(item && item.fingerprint, 500),
    context,
  };
  const materialContext = {};
  for (const field of [
    'state', 'status', 'conclusion', 'mergeState', 'reviewDecision', 'headSha',
    'runId', 'buildId', 'failedChecks', 'openThreads', 'repository', 'branch',
    'sourceBranch', 'targetBranch',
  ]) {
    if (Object.prototype.hasOwnProperty.call(context, field)) materialContext[field] = context[field];
  }
  snapshot.signature = crypto.createHash('sha1').update(JSON.stringify({
    key: snapshot.key,
    externalId: snapshot.externalId,
    kind: snapshot.kind,
    title: snapshot.title,
    detail: cleanText(item && (item.detail || item.attentionBlurb), 1200),
    source: snapshot.source,
    link: snapshot.link,
    route: snapshot.route,
    dueAt: snapshot.dueAt,
    context: materialContext,
  })).digest('hex');
  snapshot.reopenSignature = crypto.createHash('sha1').update(JSON.stringify({
    key: snapshot.key,
    dueAt: snapshot.dueAt,
    context: materialContext,
  })).digest('hex');
  snapshot.presentationSignature = crypto.createHash('sha1').update(JSON.stringify({
    detail: snapshot.detail,
    source: snapshot.source,
    link: snapshot.link,
    links: snapshot.links,
    route: snapshot.route,
    priority: snapshot.priority,
    starred: snapshot.starred,
    trackedAt: snapshot.trackedAt,
    observedAt: snapshot.observedAt,
    confidence: snapshot.confidence,
    urgency: snapshot.urgency,
    slaBusinessHours: snapshot.slaBusinessHours,
    semanticAttention: snapshot.semanticAttention,
    attentionBlurb: snapshot.attentionBlurb,
    message: snapshot.message,
    sender: snapshot.sender,
    subject: snapshot.subject,
    sentAt: snapshot.sentAt,
    context: snapshot.context,
  })).digest('hex');
  return snapshot;
}

function effortPriority(observations, explicit) {
  if (['high', 'normal', 'low'].includes(explicit)) return explicit;
  const rank = { high: 3, normal: 2, low: 1 };
  return [...observations].sort((a, b) =>
    (rank[b && b.priority] || 2) - (rank[a && a.priority] || 2))[0]?.priority || 'normal';
}

function urgencyOverride(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  const bounded = Math.max(0, Math.min(3, Math.round(score)));
  const level = ['low', 'medium', 'high', 'critical'][bounded];
  return {
    score: bounded,
    level,
    label: level.charAt(0).toUpperCase() + level.slice(1),
    reason: 'Lowered by you.',
  };
}

function effortRoute(observation) {
  const context = observation && observation.context || {};
  if (observation && observation.kind === 'pull-request' &&
      context.org && context.repo && context.prNumber) {
    const base = [
      context.org,
      context.project || '',
      context.repo,
      context.prNumber,
    ].join('|').toLowerCase();
    const key = String(context.provider || 'azdo').toLowerCase() === 'github'
      ? `github|${base}`
      : base;
    return `#/codeflow/${encodeURIComponent(key)}`;
  }
  return observation && observation.route || '';
}

function materializeEffort(effort) {
  const observations = [...(Array.isArray(effort.observations) ? effort.observations : [])]
    .sort((a, b) => Date.parse(b.trackedAt || 0) - Date.parse(a.trackedAt || 0));
  const primary = [...observations].sort((a, b) => {
    const rank = { high: 3, normal: 2, low: 1 };
    return (rank[b.priority] || 2) - (rank[a.priority] || 2) ||
      Date.parse(b.trackedAt || 0) - Date.parse(a.trackedAt || 0);
  })[0] || {};
  const kinds = [...new Set(observations.map(item => item.kind).filter(Boolean))];
  const sources = [...new Set(observations.map(item => item.source).filter(Boolean))];
  const dueDates = observations.map(item => Date.parse(item.dueAt || '')).filter(Number.isFinite);
  const trackedDates = observations.map(item => Date.parse(item.trackedAt || '')).filter(Number.isFinite);
  const mostUrgent = [...observations].sort((a, b) =>
    Number(b && b.urgency && b.urgency.score || 0) -
    Number(a && a.urgency && a.urgency.score || 0))[0] || {};
  const repositories = observations.map(item => item.context && item.context.repository).filter(Boolean);
  const repository = repositories.sort((a, b) =>
    repositories.filter(value => value === b).length -
    repositories.filter(value => value === a).length)[0] || '';
  const trackedAt = trackedDates.length
    ? new Date(Math.min(...trackedDates)).toISOString()
    : effort.createdAt || null;
  const explicitUrgency = urgencyOverride(effort.urgencyOverrideScore);
  const ongoing = effort.ongoing === true;
  return {
    id: effort.id,
    effortId: effort.id,
    kind: 'effort',
    title: effort.title || primary.title || 'Tracked effort',
    detail: effort.summary || primary.detail || 'Pixel is connecting the available evidence.',
    notes: cleanMessage(effort.notes, 12000),
    priority: effortPriority(observations, effort.priority),
    starred: effort.starred === true,
    ongoing,
    status: effort.status || 'open',
    snoozedUntil: effort.snoozedUntil || null,
    source: `${observations.length} connected ${observations.length === 1 ? 'signal' : 'signals'}${kinds.length ? ` · ${kinds.join(' · ')}` : ''}`,
    link: primary.link || '',
    route: effortRoute(primary),
    trackedAt,
    dueAt: dueDates.length ? new Date(Math.min(...dueDates)).toISOString() : null,
    urgency: explicitUrgency || mostUrgent.urgency || null,
    urgencyOverrideScore: explicitUrgency ? explicitUrgency.score : null,
    slaBusinessHours: mostUrgent.slaBusinessHours || null,
    semanticAttention: !ongoing && observations.some(item => item.semanticAttention !== false),
    attentionBlurb: mostUrgent.attentionBlurb || mostUrgent.detail || '',
    repository,
    createdAt: effort.createdAt,
    updatedAt: effort.updatedAt,
    lastObservedAt: effort.lastObservedAt,
    provisional: effort.needsClassification === true,
    observations,
    context: {
      state: effort.status || 'open',
      observationCount: observations.length,
      sourceCount: sources.length,
      sources,
      kinds,
      provisional: effort.needsClassification === true,
      classificationReason: effort.classificationReason || '',
      lastObservedAt: effort.lastObservedAt || null,
    },
    completable: true,
  };
}

function syncEffortObservations(input = []) {
  const observations = (Array.isArray(input) ? input : [])
    .map(item => {
      const key = effortObservationKey(item);
      return key ? effortObservationSnapshot(item, key) : null;
    })
    .filter(Boolean);
  const store = readStore();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const activeKeys = new Set(observations.map(observation => observation.key));
  let changed = false;
  const effortsById = new Map(store.efforts.filter(Boolean).map(effort => [effort.id, effort]));
  const latestCompletions = new Map();
  for (const activity of store.activity) {
    if (!activity || activity.type !== 'completed' || !activity.id) continue;
    const current = latestCompletions.get(activity.id);
    if (!current || Date.parse(activity.at || 0) > Date.parse(current.at || 0)) {
      latestCompletions.set(activity.id, activity);
    }
  }
  for (const effort of store.efforts) {
    if (!effort || effort.completionReopenPolicyVersion === 1) continue;
    effort.completionReopenPolicyVersion = 1;
    const completion = latestCompletions.get(effort.id);
    if (completion && effort.status === 'open') {
      effort.status = 'done';
      effort.completedAt = completion.at || now;
      effort.needsClassification = false;
      for (const observation of effort.observations || []) {
        const sourceItem = store.items.find(item => item && item.id === observation.id);
        if (sourceItem) sourceItem.status = 'done';
        const commitment = store.commitments.find(item => item && item.id === observation.id);
        if (commitment) commitment.status = 'done';
      }
    }
    changed = true;
  }

  for (const observation of observations) {
    const savedAssignment = store.effortAssignments[observation.key];
    const assignment = typeof savedAssignment === 'string'
      ? { effortId: savedAssignment, signature: '' }
      : savedAssignment && typeof savedAssignment === 'object' ? savedAssignment : null;
    let effort = assignment && effortsById.get(assignment.effortId);
    if (effort && ['done', 'dismissed'].includes(effort.status)) {
      const storedObservation = (effort.observations || [])
        .find(entry => entry && entry.key === observation.key);
      const priorReopenSignature = assignment.reopenSignature ||
        storedObservation && storedObservation.reopenSignature || '';
      const lifecycleChanged = !!(
        priorReopenSignature &&
        priorReopenSignature !== observation.reopenSignature
      );
      if (effort.autoResolvedAt || lifecycleChanged) {
        effort.status = 'open';
        effort.autoResolvedAt = null;
        effort.completedAt = null;
        effort.needsClassification = true;
        effort.updatedAt = now;
        store.activity = store.activity.filter(entry =>
          !(entry && entry.id === effort.id && entry.type === 'completed'));
        recordActivity(store, 'reopened', effort.id, effort.title, 'Pixel effort');
        changed = true;
      } else {
        if (assignment.effortId !== effort.id ||
            assignment.signature !== observation.signature ||
            assignment.reopenSignature !== observation.reopenSignature) {
          store.effortAssignments[observation.key] = {
            effortId: effort.id,
            signature: observation.signature,
            reopenSignature: observation.reopenSignature,
          };
          changed = true;
        }
        if (storedObservation &&
            (storedObservation.signature !== observation.signature ||
             storedObservation.presentationSignature !== observation.presentationSignature ||
             storedObservation.reopenSignature !== observation.reopenSignature)) {
          const missingSince = storedObservation.missingSince;
          Object.assign(storedObservation, observation);
          if (missingSince) storedObservation.missingSince = missingSince;
          changed = true;
        }
        continue;
      }
    }
    if (!effort) {
      effort = {
        id: `effort-${crypto.randomUUID()}`,
        title: observation.title,
        summary: observation.detail,
        status: 'open',
        priority: null,
        starred: observation.starred === true,
        snoozedUntil: null,
        observations: [],
        needsClassification: true,
        createdAt: now,
        updatedAt: now,
        lastObservedAt: observation.trackedAt || now,
      };
      store.efforts.push(effort);
      effortsById.set(effort.id, effort);
      changed = true;
    }
    if (!Array.isArray(effort.observations)) effort.observations = [];
    const index = effort.observations.findIndex(item => item && item.key === observation.key);
    const materialChanged = index >= 0 &&
      effort.observations[index].signature !== observation.signature;
    if (index < 0 ||
        materialChanged ||
        effort.observations[index].presentationSignature !== observation.presentationSignature) {
      const missingSince = index >= 0 ? effort.observations[index].missingSince : null;
      if (index < 0) effort.observations.push(observation);
      else effort.observations[index] = missingSince ? { ...observation, missingSince } : observation;
      effort.updatedAt = now;
      effort.lastObservedAt = observation.trackedAt || now;
      if (materialChanged) effort.evidenceEpoch = Number(effort.evidenceEpoch || 0) + 1;
      if (observation.starred) effort.starred = true;
      changed = true;
    }
    const currentObservation = effort.observations.find(item => item && item.key === observation.key);
    if (currentObservation && currentObservation.missingSince) {
      delete currentObservation.missingSince;
      changed = true;
    }
    const nextAssignment = {
      effortId: effort.id,
      signature: observation.signature,
      reopenSignature: observation.reopenSignature,
    };
    if (!assignment ||
        assignment.effortId !== effort.id ||
        assignment.signature !== observation.signature ||
        assignment.reopenSignature !== observation.reopenSignature) {
      store.effortAssignments[observation.key] = nextAssignment;
      changed = true;
    }
  }

  for (const effort of store.efforts) {
    if (!effort || ['done', 'dismissed'].includes(effort.status)) continue;
    const effortObservations = Array.isArray(effort.observations) ? effort.observations : [];
    for (const observation of effortObservations) {
      if (!observation || !observation.key) continue;
      if (activeKeys.has(observation.key)) {
        if (observation.missingSince) {
          delete observation.missingSince;
          changed = true;
        }
      } else if (!observation.missingSince) {
        observation.missingSince = now;
        changed = true;
      }
    }
    const fullyStale = effortObservations.length > 0 && effortObservations.every(observation => {
      const missingAt = Date.parse(observation && observation.missingSince || '');
      return Number.isFinite(missingAt) && nowMs - missingAt >= 30 * 60 * 1000;
    });
    if (fullyStale) {
      effort.status = 'done';
      effort.autoResolvedAt = now;
      effort.classificationReason = 'All connected source evidence cleared.';
      effort.updatedAt = now;
      changed = true;
    }
  }

  const durableStore = changed ? writeStore(store) : store;
  const open = durableStore.efforts
    .filter(effort => effort && !['done', 'dismissed'].includes(effort.status))
    .filter(effort => !(effort.snoozedUntil && Date.parse(effort.snoozedUntil) > Date.now()));
  return {
    efforts: open.map(materializeEffort),
    pending: open.filter(effort => effort.needsClassification === true).map(effort => effort.id),
  };
}

function getEffortClassificationState() {
  const efforts = readStore().efforts
    .filter(effort => effort && !['done', 'dismissed'].includes(effort.status));
  const compact = effort => ({
    id: effort.id,
    title: effort.title || '',
    summary: effort.summary || '',
    createdAt: effort.createdAt || null,
    evidenceEpoch: Number(effort.evidenceEpoch || 0),
    observations: (effort.observations || []).slice(-12).map(observation => ({
      key: observation.key,
      kind: observation.kind,
      title: observation.title,
      detail: observation.detail,
      source: observation.source,
      repository: observation.context && observation.context.repository || '',
      branch: observation.context && (observation.context.sourceBranch || observation.context.branch) || '',
    })),
  });
  return {
    pending: efforts.filter(effort => effort.needsClassification === true).map(compact),
    established: efforts.filter(effort => effort.needsClassification !== true).map(compact),
  };
}

function effortSeparationKey(leftKey, rightKey) {
  return crypto.createHash('sha1')
    .update([cleanText(leftKey, 500), cleanText(rightKey, 500)].sort().join('\0'))
    .digest('hex');
}

function effortsAreSeparated(store, left, right) {
  for (const leftObservation of left && left.observations || []) {
    for (const rightObservation of right && right.observations || []) {
      if (store.effortSeparations[effortSeparationKey(leftObservation.key, rightObservation.key)]) {
        return true;
      }
    }
  }
  return false;
}

function applyEffortClassification(groups = [], attemptedIds = null) {
  const store = readStore();
  const effortsById = new Map(store.efforts.filter(Boolean).map(effort => [effort.id, effort]));
  const pendingIds = new Set(store.efforts
    .filter(effort => effort && effort.needsClassification === true && !['done', 'dismissed'].includes(effort.status))
    .map(effort => effort.id));
  const consumed = new Set();
  const applied = [];
  const now = new Date().toISOString();
  const attemptedEpochs = new Map((Array.isArray(attemptedIds) ? attemptedIds : []).map(entry =>
    typeof entry === 'string'
      ? [cleanText(entry, 200), null]
      : [cleanText(entry && entry.id, 200), Number(entry && entry.evidenceEpoch || 0)]));
  const epochMatches = id => {
    if (!attemptedEpochs.has(id) || attemptedEpochs.get(id) == null) return true;
    return Number(effortsById.get(id) && effortsById.get(id).evidenceEpoch || 0) === attemptedEpochs.get(id);
  };
  for (const group of Array.isArray(groups) ? groups : []) {
    const sourceIds = [...new Set((group && Array.isArray(group.provisionalIds) ? group.provisionalIds : [])
      .map(id => cleanText(id, 200))
      .filter(id => pendingIds.has(id) && !consumed.has(id) && epochMatches(id)))];
    if (!sourceIds.length) continue;
    const confidence = Number(group.confidence);
    const requestedTarget = cleanText(group.targetEffortId, 200);
    const establishedTarget = requestedTarget && effortsById.get(requestedTarget);
    const provisionalEfforts = sourceIds.map(id => effortsById.get(id)).filter(Boolean);
    const provisionalConflict = provisionalEfforts.some((effort, index) =>
      provisionalEfforts.slice(index + 1).some(other => effortsAreSeparated(store, effort, other)));
    const establishedConflict = !!(establishedTarget &&
      provisionalEfforts.some(effort => effortsAreSeparated(store, effort, establishedTarget)));
    const blockedBySeparation = provisionalConflict || establishedConflict;
    const canMergeExisting = establishedTarget &&
      establishedTarget.needsClassification !== true &&
      !['done', 'dismissed'].includes(establishedTarget.status) &&
      !establishedConflict &&
      Number.isFinite(confidence) && confidence >= 0.72;
    const canMergeProvisionals = sourceIds.length === 1 ||
      (!provisionalConflict && Number.isFinite(confidence) && confidence >= 0.72);
    if (!canMergeProvisionals) {
      for (const id of sourceIds) {
        const source = effortsById.get(id);
        if (!source) continue;
        consumed.add(id);
        source.needsClassification = false;
        source.classificationConfidence = Number.isFinite(confidence) ? confidence : null;
        source.classificationReason = provisionalConflict
          ? 'Kept separate because you marked this evidence unrelated.'
          : cleanText(group.reason, 600);
        source.updatedAt = now;
        applied.push(id);
      }
      continue;
    }
    const target = canMergeExisting ? establishedTarget : effortsById.get(sourceIds[0]);
    if (!target) continue;
    const mergedObservations = new Map((target.observations || [])
      .filter(Boolean).map(observation => [observation.key, observation]));
    let starred = target.starred === true;
    let ongoing = target.ongoing === true;
    let ongoingUpdatedAt = target.ongoingUpdatedAt || '';
    let priorityUpdatedAt = target.priorityUpdatedAt || '';
    const urgencyOverrides = [urgencyOverride(target.urgencyOverrideScore)]
      .filter(Boolean).map(entry => entry.score);
    const mergedNotes = [cleanMessage(target.notes, 12000)].filter(Boolean);
    let earliest = Date.parse(target.createdAt || now);
    let latest = Date.parse(target.lastObservedAt || target.updatedAt || now);
    for (const id of sourceIds) {
      const source = effortsById.get(id);
      if (!source) continue;
      consumed.add(id);
      starred = starred || source.starred === true;
      ongoing = ongoing || source.ongoing === true;
      if (source.ongoingUpdatedAt &&
          (!ongoingUpdatedAt ||
           Date.parse(source.ongoingUpdatedAt) > Date.parse(ongoingUpdatedAt))) {
        ongoingUpdatedAt = source.ongoingUpdatedAt;
      }
      if (source.priorityUpdatedAt &&
          (!priorityUpdatedAt ||
           Date.parse(source.priorityUpdatedAt) > Date.parse(priorityUpdatedAt))) {
        priorityUpdatedAt = source.priorityUpdatedAt;
      }
      const sourceUrgency = urgencyOverride(source.urgencyOverrideScore);
      if (sourceUrgency) urgencyOverrides.push(sourceUrgency.score);
      const sourceNotes = cleanMessage(source.notes, 12000);
      if (sourceNotes && !mergedNotes.includes(sourceNotes)) mergedNotes.push(sourceNotes);
      const sourceCreatedAt = Date.parse(source.createdAt || '');
      const sourceObservedAt = Date.parse(source.lastObservedAt || source.updatedAt || '');
      if (Number.isFinite(sourceCreatedAt)) earliest = Math.min(earliest, sourceCreatedAt);
      if (Number.isFinite(sourceObservedAt)) latest = Math.max(latest, sourceObservedAt);
      for (const observation of source.observations || []) {
        if (!observation || !observation.key) continue;
        mergedObservations.set(observation.key, observation);
        store.effortAssignments[observation.key] = {
          effortId: target.id,
          signature: observation.signature || '',
          reopenSignature: observation.reopenSignature || '',
        };
      }
    }
    target.observations = [...mergedObservations.values()].slice(-80);
    const shouldApplyCombinedLabel = canMergeExisting || sourceIds.length > 1 || !requestedTarget;
    if (shouldApplyCombinedLabel) {
      target.title = cleanText(group.title, 160) || target.title;
      target.summary = cleanText(group.summary, 1200) || target.summary;
    }
    target.starred = starred;
    target.ongoing = ongoing;
    target.ongoingUpdatedAt = ongoingUpdatedAt || target.ongoingUpdatedAt;
    if (target.ongoingUpdatedAt) {
      writeOngoingDecision(target.id, target.ongoing, target.ongoingUpdatedAt);
    }
    target.urgencyOverrideScore = urgencyOverrides.length ? Math.min(...urgencyOverrides) : null;
    target.priorityUpdatedAt = priorityUpdatedAt || target.priorityUpdatedAt;
    if (target.priorityUpdatedAt) {
      writePriorityDecision(
        target.id,
        target.priority,
        target.urgencyOverrideScore,
        target.priorityUpdatedAt
      );
    }
    target.notes = mergedNotes.join('\n\n---\n\n');
    target.needsClassification = false;
    target.classificationConfidence = Number.isFinite(confidence) ? confidence : null;
    target.classificationReason = blockedBySeparation
      ? 'Kept separate because you marked this evidence unrelated.'
      : cleanText(group.reason, 600);
    target.createdAt = Number.isFinite(earliest) ? new Date(earliest).toISOString() : target.createdAt;
    target.lastObservedAt = Number.isFinite(latest) ? new Date(latest).toISOString() : target.lastObservedAt;
    target.updatedAt = now;
    target.evidenceEpoch = Number(target.evidenceEpoch || 0) + 1;
    applied.push(target.id);
    for (const id of sourceIds) {
      if (id !== target.id) effortsById.delete(id);
    }
  }
  const attempted = new Set([...attemptedEpochs.keys()]
    .filter(id => pendingIds.has(id) && epochMatches(id)));
  for (const id of attempted) {
    if (consumed.has(id)) continue;
    const effort = effortsById.get(id);
    if (!effort) continue;
    effort.classificationAttempts = Number(effort.classificationAttempts || 0) + 1;
    effort.updatedAt = now;
    if (effort.classificationAttempts >= 3) {
      effort.needsClassification = false;
      effort.classificationReason = 'Kept separate after Pixel could not classify it confidently.';
      consumed.add(id);
      applied.push(id);
    }
  }
  store.efforts = store.efforts.filter(effort => effortsById.has(effort.id));
  writeStore(store);
  const remaining = [...pendingIds].filter(id => !consumed.has(id));
  return {
    applied: [...new Set(applied)],
    remaining,
    remainingAttempted: [...attempted].filter(id => !consumed.has(id)),
  };
}

function detachEffortObservation(effortId, observationKey) {
  const store = readStore();
  const effort = store.efforts.find(entry =>
    entry && entry.id === effortId && !['done', 'dismissed'].includes(entry.status));
  if (!effort) return null;
  const observations = Array.isArray(effort.observations) ? effort.observations : [];
  const observation = observations.find(entry => entry && entry.key === observationKey);
  if (!observation) return null;
  const remaining = observations.filter(entry => entry && entry.key !== observationKey);
  if (!remaining.length) throw new Error('This is the only evidence on the effort.');
  const now = new Date().toISOString();
  for (const other of remaining) {
    store.effortSeparations[effortSeparationKey(observation.key, other.key)] = {
      markedAt: now,
      reason: 'user-marked-unrelated',
      leftKey: observation.key,
      rightKey: other.key,
    };
  }
  effort.observations = remaining;
  effort.title = remaining[0].title || effort.title;
  effort.summary = remaining[0].detail || effort.summary;
  effort.needsClassification = true;
  effort.classificationAttempts = 0;
  effort.evidenceEpoch = Number(effort.evidenceEpoch || 0) + 1;
  effort.classificationReason = 'Re-triaging after unrelated evidence was removed.';
  effort.updatedAt = now;
  const detached = {
    id: `effort-${crypto.randomUUID()}`,
    title: observation.title || 'Review detached evidence',
    summary: observation.detail || 'Pixel is re-triaging this evidence.',
    status: 'open',
    priority: null,
    starred: observation.starred === true,
    snoozedUntil: null,
    observations: [observation],
    needsClassification: true,
    classificationAttempts: 0,
    classificationReason: 'Detached by the user for separate triage.',
    evidenceEpoch: 0,
    createdAt: now,
    updatedAt: now,
    lastObservedAt: observation.trackedAt || observation.observedAt || now,
  };
  store.efforts.push(detached);
  store.effortAssignments[observation.key] = {
    effortId: detached.id,
    signature: observation.signature || '',
    reopenSignature: observation.reopenSignature || '',
  };
  writeStore(store);
  return {
    effort: materializeEffort(effort),
    detached: materializeEffort(detached),
  };
}

function mergeEfforts(sourceId, targetId, options = {}) {
  const sourceKey = cleanText(sourceId, 200);
  const targetKey = cleanText(targetId, 200);
  if (!sourceKey || !targetKey || sourceKey === targetKey) {
    throw new Error('Choose two different work items to combine.');
  }
  const store = readStore();
  const source = store.efforts.find(entry =>
    entry && entry.id === sourceKey && !['done', 'dismissed'].includes(entry.status));
  const target = store.efforts.find(entry =>
    entry && entry.id === targetKey && !['done', 'dismissed'].includes(entry.status));
  if (!source || !target) return null;

  const sourceObservations = (source.observations || []).filter(entry => entry && entry.key);
  const targetObservations = (target.observations || []).filter(entry => entry && entry.key);
  const observations = new Map(targetObservations.map(entry => [entry.key, entry]));
  for (const observation of sourceObservations) {
    observations.set(observation.key, observation);
    store.effortAssignments[observation.key] = {
      effortId: target.id,
      signature: observation.signature || '',
      reopenSignature: observation.reopenSignature || '',
    };
  }

  const sourceObservationKeys = new Set(sourceObservations.map(entry => entry.key));
  const targetObservationKeys = new Set(targetObservations.map(entry => entry.key));
  for (const [key, separation] of Object.entries(store.effortSeparations)) {
    const left = separation && separation.leftKey;
    const right = separation && separation.rightKey;
    if ((sourceObservationKeys.has(left) && targetObservationKeys.has(right)) ||
        (sourceObservationKeys.has(right) && targetObservationKeys.has(left))) {
      delete store.effortSeparations[key];
    }
  }

  const notes = [cleanMessage(target.notes, 12000), cleanMessage(source.notes, 12000)]
    .filter((value, index, all) => value && all.indexOf(value) === index);
  const priorityRank = { low: 1, normal: 2, high: 3 };
  const sourcePriority = normalizePriority(source.priority);
  const targetPriority = normalizePriority(target.priority);
  const createdTimes = [target.createdAt, source.createdAt].map(Date.parse).filter(Number.isFinite);
  const observedTimes = [target.lastObservedAt, source.lastObservedAt, target.updatedAt, source.updatedAt]
    .map(Date.parse).filter(Number.isFinite);
  const now = new Date().toISOString();

  target.observations = [...observations.values()].slice(-80);
  target.notes = notes.join('\n\n---\n\n');
  target.starred = target.starred === true || source.starred === true;
  target.ongoing = target.ongoing === true || source.ongoing === true;
  target.ongoingUpdatedAt = source.ongoingUpdatedAt &&
      (!target.ongoingUpdatedAt ||
       Date.parse(source.ongoingUpdatedAt) > Date.parse(target.ongoingUpdatedAt))
    ? source.ongoingUpdatedAt
    : target.ongoingUpdatedAt;
  if (target.ongoingUpdatedAt) {
    writeOngoingDecision(target.id, target.ongoing, target.ongoingUpdatedAt);
  }
  const urgencyOverrides = [target, source]
    .map(effort => urgencyOverride(effort.urgencyOverrideScore))
    .filter(Boolean)
    .map(entry => entry.score);
  target.urgencyOverrideScore = urgencyOverrides.length ? Math.min(...urgencyOverrides) : null;
  target.priorityUpdatedAt = source.priorityUpdatedAt &&
      (!target.priorityUpdatedAt ||
       Date.parse(source.priorityUpdatedAt) > Date.parse(target.priorityUpdatedAt))
    ? source.priorityUpdatedAt
    : target.priorityUpdatedAt;
  if (target.priorityUpdatedAt) {
    writePriorityDecision(
      target.id,
      target.priority,
      target.urgencyOverrideScore,
      target.priorityUpdatedAt
    );
  }
  target.priority = priorityRank[sourcePriority] > priorityRank[targetPriority]
    ? sourcePriority
    : target.priority;
  target.needsClassification = false;
  target.classificationAttempts = 0;
  target.classificationConfidence = 1;
  target.classificationReason = cleanText(options.reason, 600) || 'Combined manually by the user.';
  target.evidenceEpoch = Number(target.evidenceEpoch || 0) + 1;
  target.createdAt = createdTimes.length ? new Date(Math.min(...createdTimes)).toISOString() : target.createdAt;
  target.lastObservedAt = observedTimes.length ? new Date(Math.max(...observedTimes)).toISOString() : now;
  target.updatedAt = now;
  store.efforts = store.efforts.filter(entry => entry && entry.id !== source.id);
  store.manualOrder = store.manualOrder.filter(id => id !== source.id);
  writeStore(store);
  return { sourceId: source.id, target: materializeEffort(target) };
}

function effortTitleTerms(value) {
  return new Set(cleanText(value, 500)
    .toLowerCase()
    .replace(/\brca\b/g, 'root cause analysis')
    .replace(/\bpostmortem\b/g, 'root cause analysis')
    .split(/[^a-z0-9]+/)
    .filter(term => term.length > 2 && !['and', 'the', 'for', 'with', 'from', 'into'].includes(term)));
}

function equivalentEffortTitleScore(left, right) {
  const leftTerms = effortTitleTerms(left);
  const rightTerms = effortTitleTerms(right);
  if (!leftTerms.size || !rightTerms.size) return { shared: 0, containment: 0, jaccard: 0 };
  const shared = [...leftTerms].filter(term => rightTerms.has(term)).length;
  return {
    shared,
    containment: shared / Math.min(leftTerms.size, rightTerms.size),
    jaccard: shared / new Set([...leftTerms, ...rightTerms]).size,
  };
}

function reconcileEquivalentEfforts(limit = 10) {
  const merged = [];
  for (let pass = 0; pass < Math.max(1, Math.min(25, Number(limit) || 10)); pass++) {
    const store = readStore();
    const efforts = store.efforts.filter(effort =>
      effort &&
      effort.needsClassification !== true &&
      !['done', 'dismissed'].includes(effort.status));
    let candidate = null;
    for (let leftIndex = 0; leftIndex < efforts.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < efforts.length; rightIndex++) {
        const left = efforts[leftIndex];
        const right = efforts[rightIndex];
        if (effortsAreSeparated(store, left, right)) continue;
        const score = equivalentEffortTitleScore(left.title, right.title);
        if (score.shared < 4 || score.containment < 0.8 || score.jaccard < 0.67) continue;
        if (!candidate || score.jaccard > candidate.score.jaccard) {
          candidate = { left, right, score };
        }
      }
    }
    if (!candidate) break;
    const leftEvidence = (candidate.left.observations || []).length;
    const rightEvidence = (candidate.right.observations || []).length;
    const target = leftEvidence > rightEvidence ||
      (leftEvidence === rightEvidence &&
        Date.parse(candidate.left.createdAt || 0) <= Date.parse(candidate.right.createdAt || 0))
      ? candidate.left
      : candidate.right;
    const source = target === candidate.left ? candidate.right : candidate.left;
    const result = mergeEfforts(source.id, target.id, {
      reason: 'Automatically combined because both titles describe the same objective.',
    });
    if (!result) break;
    merged.push(result);
  }
  return merged;
}

function updateEffort(id, patch = {}) {
  const store = readStore();
  const effort = store.efforts.find(entry => entry && entry.id === id);
  if (!effort) return null;
  let reprioritized = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) effort.notes = cleanMessage(patch.notes, 12000);
  if (Object.prototype.hasOwnProperty.call(patch, 'starred')) effort.starred = patch.starred === true;
  if (Object.prototype.hasOwnProperty.call(patch, 'ongoing')) {
    const ongoing = patch.ongoing === true;
    const ongoingUpdatedAt = new Date().toISOString();
    if (ongoing !== (effort.ongoing === true)) {
      recordActivity(store, ongoing ? 'acknowledged' : 'reactivated',
        effort.id, effort.title, 'Pixel effort');
    }
    effort.ongoing = ongoing;
    effort.ongoingUpdatedAt = ongoingUpdatedAt;
    writeOngoingDecision(effort.id, ongoing, ongoingUpdatedAt);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'priority')) {
    const priority = normalizePriority(patch.priority);
    if (priority !== effort.priority) {
      recordActivity(store, 'reprioritized', effort.id, effort.title, 'Pixel effort');
      reprioritized = true;
    }
    effort.priority = priority;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'urgencyScore')) {
    const nextUrgency = urgencyOverride(patch.urgencyScore);
    const previousUrgency = urgencyOverride(effort.urgencyOverrideScore);
    if (nextUrgency && nextUrgency.score !== previousUrgency?.score) {
      if (!reprioritized) {
        recordActivity(store, 'reprioritized', effort.id, effort.title, 'Pixel effort');
      }
      effort.urgencyOverrideScore = nextUrgency.score;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'priority') ||
      Object.prototype.hasOwnProperty.call(patch, 'urgencyScore')) {
    effort.priorityUpdatedAt = new Date().toISOString();
    writePriorityDecision(
      effort.id,
      effort.priority,
      effort.urgencyOverrideScore,
      effort.priorityUpdatedAt
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'snoozedUntil')) {
    const parsed = Date.parse(patch.snoozedUntil || '');
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      recordActivity(store, 'deferred', effort.id, effort.title, 'Pixel effort');
    }
    effort.snoozedUntil = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (['done', 'dismissed', 'open'].includes(patch.status)) {
    if (patch.status === 'done' && effort.status !== 'done') {
      recordCompletion(store, effort.id, effort.title, 'Pixel effort');
    }
    if (patch.status === 'dismissed' && effort.status !== 'dismissed') {
      recordActivity(store, 'dismissed', effort.id, effort.title, 'Pixel effort');
    }
    effort.status = patch.status;
    effort.completionReopenPolicyVersion = 1;
    effort.completedAt = patch.status === 'done' ? new Date().toISOString() : null;
    for (const observation of effort.observations || []) {
      const sourceItem = store.items.find(item => item && item.id === observation.id);
      if (sourceItem) sourceItem.status = patch.status;
      const commitment = store.commitments.find(item => item && item.id === observation.id);
      if (commitment) commitment.status = patch.status;
    }
  }
  effort.updatedAt = new Date().toISOString();
  writeStore(store);
  return materializeEffort(effort);
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
    const effort = store.efforts.find(entry => entry && entry.id === recent.id);
    const target = item || commitment || effort;
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
  const effort = store.efforts.find(entry => entry && entry.id === key);
  const target = item || commitment || effort;
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
      if (target === effort) {
        target.completedAt = null;
        target.completionReopenPolicyVersion = 1;
        target.observations = (target.observations || []).filter(observation => {
          const assignment = observation && store.effortAssignments[observation.key];
          return !assignment || assignment.effortId === target.id;
        });
        for (const observation of target.observations) {
          const sourceItem = store.items.find(entry => entry && entry.id === observation.id);
          if (sourceItem) sourceItem.status = 'open';
          const sourceCommitment = store.commitments.find(entry => entry && entry.id === observation.id);
          if (sourceCommitment) sourceCommitment.status = 'open';
        }
      }
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
  applyEffortClassification,
  applyManualOrder,
  businessHoursBetween,
  deriveUrgency,
  deriveMood,
  describeAge,
  detachEffortObservation,
  dismissSignal,
  completeCommitment,
  commitmentsMatch,
  getProgress,
  getCommitmentSync,
  getEffortClassificationState,
  getSignalSnapshot,
  getSignalState,
  isSignalDismissed,
  listRecentActivity,
  listCommitments,
  listItems,
  mergeEfforts,
  reconcileEquivalentEfforts,
  restoreRecentActivity,
  setManualOrder,
  setCommitmentSync,
  syncEffortObservations,
  updateCommitment,
  enrichCommitment,
  updateEffort,
  updateSignal,
  upsertCommitments,
  updateItem,
};
