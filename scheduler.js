const { Cron } = require('croner');
const cronstrue = require('cronstrue');

/**
 * Schedule parser that supports:
 * 
 * Simple intervals:
 *   "30s", "5m", "1h", "2h", "1d"
 * 
 * Human-readable schedules:
 *   "every hour at :30"
 *   "every 2 hours"
 *   "every day at 7am"
 *   "every day at 7am and 9pm"
 *   "weekdays at 7am"
 *   "weekdays at 7am and 9pm"
 *   "M,T,W,Th,F at 7am and 9pm"
 *   "monday, wednesday, friday at 9am"
 *   "every 15 minutes"
 *   "hourly at :45"
 * 
 * Cron expressions (5 or 6 fields):
 *   "30 * * * *"        (at :30 every hour)
 *   "0 7,21 * * 1-5"   (7am and 9pm weekdays)
 */

const DAY_MAP = {
  'su': 0, 'sun': 0, 'sunday': 0,
  'mo': 1, 'mon': 1, 'monday': 1, 'm': 1,
  'tu': 2, 'tue': 2, 'tuesday': 2, 't': 2,
  'we': 3, 'wed': 3, 'wednesday': 3, 'w': 3,
  'th': 4, 'thu': 4, 'thursday': 4, 'thursday': 4,
  'fr': 5, 'fri': 5, 'friday': 5, 'f': 5,
  'sa': 6, 'sat': 6, 'saturday': 6,
};

function parseTime(timeStr) {
  timeStr = timeStr.trim().toLowerCase();
  const match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hour = parseInt(match[1]);
  const minute = parseInt(match[2] || '0');
  const period = match[3];
  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function parseDays(dayStr) {
  const parts = dayStr.split(/[,\s]+/).filter(Boolean);
  const days = [];
  for (const part of parts) {
    const key = part.toLowerCase().replace(/[^a-z]/g, '');
    if (DAY_MAP[key] !== undefined) {
      days.push(DAY_MAP[key]);
    }
  }
  return days.length > 0 ? days : null;
}

function humanToCron(input) {
  input = input.trim();

  // Already a cron expression (5-6 space-separated fields starting with number or *)
  if (/^[\d*\/,-]+(\s+[\d*\/,-]+){4,5}$/.test(input)) {
    return input;
  }

  // Simple interval: "30s", "5m", "1h", "2d"
  const intervalMatch = input.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1]);
    const unit = intervalMatch[2][0].toLowerCase();
    if (unit === 's') return { type: 'interval', ms: value * 1000 };
    if (unit === 'm') return `*/${value} * * * *`;
    if (unit === 'h') return `0 */${value} * * *`;
    if (unit === 'd') return `0 0 */${value} * *`;
  }

  const lower = input.toLowerCase();

  // "every X minutes/hours"
  const everyMatch = lower.match(/^every\s+(\d+)\s*(minutes?|hours?|mins?|hrs?)$/);
  if (everyMatch) {
    const value = parseInt(everyMatch[1]);
    const unit = everyMatch[2][0];
    if (unit === 'm') return `*/${value} * * * *`;
    if (unit === 'h') return `0 */${value} * * *`;
  }

  // "every hour" / "hourly"
  if (/^(every\s+hour|hourly)$/i.test(lower)) {
    return '0 * * * *';
  }

  // "every hour at :30"
  const hourAtMatch = lower.match(/^(?:every\s+hour|hourly)\s+at\s+:(\d{1,2})$/);
  if (hourAtMatch) {
    return `${parseInt(hourAtMatch[1])} * * * *`;
  }

  // "every N hours at :MM"
  const everyHourAtMatch = lower.match(/^every\s+(\d+)\s*(?:hours?|hrs?)\s+at\s+:(\d{1,2})$/);
  if (everyHourAtMatch) {
    return `${parseInt(everyHourAtMatch[2])} */${parseInt(everyHourAtMatch[1])} * * *`;
  }

  // "every day at TIME [and TIME]"
  const dailyMatch = lower.match(/^(?:every\s*day|daily)\s+at\s+(.+)$/);
  if (dailyMatch) {
    const times = dailyMatch[1].split(/\s+and\s+|,\s*/).map(parseTime).filter(Boolean);
    if (times.length > 0) {
      const minutes = [...new Set(times.map(t => t.minute))];
      const hours = times.map(t => t.hour);
      return `${minutes.join(',')} ${hours.join(',')} * * *`;
    }
  }

  // "weekdays at TIME [and TIME]"
  const weekdaysMatch = lower.match(/^weekdays?\s+at\s+(.+)$/);
  if (weekdaysMatch) {
    const times = weekdaysMatch[1].split(/\s+and\s+|,\s*/).map(parseTime).filter(Boolean);
    if (times.length > 0) {
      const minutes = [...new Set(times.map(t => t.minute))];
      const hours = times.map(t => t.hour);
      return `${minutes.join(',')} ${hours.join(',')} * * 1-5`;
    }
  }

  // "M,T,W,Th,F at TIME [and TIME]" or "monday, wednesday at TIME"
  const daysAtMatch = lower.match(/^(.+?)\s+at\s+(.+)$/);
  if (daysAtMatch) {
    const days = parseDays(daysAtMatch[1]);
    if (days) {
      const times = daysAtMatch[2].split(/\s+and\s+|,\s*/).map(parseTime).filter(Boolean);
      if (times.length > 0) {
        const minutes = [...new Set(times.map(t => t.minute))];
        const hours = times.map(t => t.hour);
        return `${minutes.join(',')} ${hours.join(',')} * * ${days.join(',')}`;
      }
    }
  }

  throw new Error(`Cannot parse schedule: "${input}". Use interval (e.g. "1h"), human-readable (e.g. "weekdays at 9am"), or cron expression.`);
}

/**
 * Parse a schedule string and return a schedule object.
 * @returns {{ type: 'cron', cron: string, description: string } | { type: 'interval', ms: number, description: string }}
 */
function parseSchedule(input) {
  const result = humanToCron(input);

  if (typeof result === 'object' && result.type === 'interval') {
    const sec = result.ms / 1000;
    let desc;
    if (sec < 60) desc = `Every ${sec} seconds`;
    else if (sec < 3600) desc = `Every ${sec / 60} minutes`;
    else desc = `Every ${sec / 3600} hours`;
    return { type: 'interval', ms: result.ms, description: desc };
  }

  // It's a cron string
  let description;
  try {
    description = cronstrue.toString(result);
  } catch {
    description = result;
  }
  return { type: 'cron', cron: result, description };
}

/**
 * Get the next run time for a schedule.
 */
function getNextRun(input) {
  const schedule = parseSchedule(input);
  if (schedule.type === 'interval') {
    return new Date(Date.now() + schedule.ms);
  }
  const job = new Cron(schedule.cron);
  return job.nextRun();
}

module.exports = { parseSchedule, getNextRun, humanToCron };
