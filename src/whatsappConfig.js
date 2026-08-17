const { db } = require('./firebase');

const CACHE_MS = 5 * 60 * 1000;
const _cache = new Map();

// Credentials live in a subcollection with no Firestore rule granting client
// access (default-deny), so the access token/app secret never reach the
// Flutter app — only this backend's Admin SDK connection can read them.
async function getTenantWhatsappConfig(tenantId) {
  const hit = _cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const snap = await db.collection('tenants').doc(tenantId).collection('private').doc('whatsapp').get();
  const data = snap.exists ? snap.data() : null;
  // Do not cache misses — connect() can land seconds later and would 401 webhooks for 5 min.
  if (data) _cache.set(tenantId, { at: Date.now(), data });
  return data;
}

function invalidateWhatsappConfig(tenantId) {
  _cache.delete(tenantId);
}

module.exports = { getTenantWhatsappConfig, invalidateWhatsappConfig };
