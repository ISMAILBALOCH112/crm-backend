const { db } = require('./firebase');

// Credentials live in a subcollection with no Firestore rule granting client
// access (default-deny), so the access token/app secret never reach the
// Flutter app — only this backend's Admin SDK connection can read them.
async function getTenantWhatsappConfig(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).collection('private').doc('whatsapp').get();
  return snap.exists ? snap.data() : null;
}

module.exports = { getTenantWhatsappConfig };
