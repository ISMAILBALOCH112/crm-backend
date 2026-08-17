/** Shared pause when Firestore Spark quota is exhausted. */

let pausedUntil = 0;

function isQuotaError(err) {
  const code = err?.code;
  const msg = String(err?.message || err || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

function pauseSchedulers(ms = 15 * 60 * 1000) {
  pausedUntil = Date.now() + ms;
  console.error(`Firestore quota hit — pausing schedulers for ${Math.round(ms / 60000)} min`);
}

function schedulersPaused() {
  return Date.now() < pausedUntil;
}

async function runIfQuotaOk(fn, label) {
  if (schedulersPaused()) return;
  try {
    await fn();
  } catch (err) {
    if (isQuotaError(err)) {
      pauseSchedulers();
      return;
    }
    console.error(`${label}:`, err.message);
  }
}

module.exports = { isQuotaError, pauseSchedulers, schedulersPaused, runIfQuotaOk };
