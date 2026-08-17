/** Day keys: mon…sun matching Intl weekday short (en). */
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseHm(hm) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Local wall-clock parts in a given IANA timezone. */
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'Asia/Karachi',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = String(parts.weekday || 'Mon').slice(0, 3).toLowerCase();
  const dayKey = DAY_KEYS.find((d) => weekday.startsWith(d.slice(0, 3))) || 'mon';
  // en-US hour12:false can yield "24" for midnight — normalize.
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const minute = Number(parts.minute);
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return { dayKey, minutes: hour * 60 + minute, ymd };
}

/**
 * Returns true when the business is closed / outside schedule.
 * If businessHours.enabled is false → never "outside" (schedule unused).
 */
function isOutsideBusinessHours(businessHours, now = new Date()) {
  if (!businessHours?.enabled) return false;
  const tz = businessHours.timezone || 'Asia/Karachi';
  const { dayKey, minutes } = localParts(now, tz);
  const day = businessHours.days?.[dayKey];
  if (!day || day.closed) return true;
  const open = parseHm(day.open);
  const close = parseHm(day.close);
  if (open == null || close == null) return false;
  if (close <= open) {
    // Overnight e.g. 22:00–06:00 — open if after open OR before close.
    return !(minutes >= open || minutes < close);
  }
  return minutes < open || minutes >= close;
}

function localYmd(timeZone, now = new Date()) {
  return localParts(now, timeZone || 'Asia/Karachi').ymd;
}

function shouldSendAway(config, state, now = new Date()) {
  const away = config.away;
  if (!away?.enabled) return false;
  const msg = String(away.message || '').trim();
  if (!msg) return false;

  const alwaysOn = away.alwaysOn === true;
  const outside = isOutsideBusinessHours(config.businessHours, now);
  if (!alwaysOn && !outside) return false;

  const tz = config.businessHours?.timezone || 'Asia/Karachi';
  const today = localYmd(tz, now);
  if (state.awaySentYmd === today) return false;
  return true;
}

module.exports = {
  isOutsideBusinessHours,
  localYmd,
  shouldSendAway,
  localParts,
};
