const { getMessaging } = require('firebase-admin/messaging');
const { db } = require('./firebase');

/**
 * Notify all tenant members (with fcmToken on users/{uid}) of an inbound chat message.
 * Skips when the contact is muted in CRM.
 */
async function notifyTenantInbound(tenantId, { from, preview, contactName }) {
  try {
    if (from) {
      const contactSnap = await db
        .collection('tenants')
        .doc(tenantId)
        .collection('contacts')
        .doc(String(from))
        .get();
      if (contactSnap.exists && contactSnap.data()?.isMuted === true) {
        return;
      }
    }

    const membersSnap = await db.collection('tenants').doc(tenantId).collection('members').get();
    if (membersSnap.empty) return;

    const tokens = [];
    for (const member of membersSnap.docs) {
      const userSnap = await db.collection('users').doc(member.id).get();
      const token = userSnap.data()?.fcmToken;
      if (typeof token === 'string' && token.trim()) tokens.push(token.trim());
    }
    if (!tokens.length) return;

    const title = contactName || from || 'WhatsApp';
    const body = preview || 'New message';
    const messaging = getMessaging();

    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: {
        tenantId: String(tenantId),
        phone: String(from || ''),
        type: 'inbound_message',
      },
      android: { priority: 'high' },
    });
    console.log(`FCM inbound notify tenant=${tenantId} success=${res.successCount} fail=${res.failureCount}`);
  } catch (err) {
    console.error('FCM notify failed:', err.message || err);
  }
}

module.exports = { notifyTenantInbound };
