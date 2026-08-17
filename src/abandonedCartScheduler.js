const { db } = require('./firebase');
const { runIfQuotaOk } = require('./firestoreQuota');
const { getTenantWhatsappConfig } = require('./whatsappConfig');
const { sendTextMessage, sendTemplateMessage } = require('./whatsapp');
const { recordOutboundBotMessage } = require('./messageSender');

const POLL_MS = 60000;
const DEFAULT_MESSAGE =
  'Assalam o Alaikum! Aap se contact kiya tha — koi reply nahi aaya. Order / madad chahiye to reply karein, ya "agent" likhein.';

function digitsOnly(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  return digits;
}

async function loadFollowUpSettings(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).collection('settings').doc('abandonedCart').get();
  const data = snap.data() || {};
  return {
    enabled: data.enabled === true,
    delayMinutes: Number.isFinite(Number(data.delayMinutes)) ? Number(data.delayMinutes) : 60,
    message: (data.message || '').trim() || DEFAULT_MESSAGE,
    templateName: (data.templateName || '').trim(),
    templateLanguage: (data.templateLanguage || 'en_US').trim() || 'en_US',
    onManualSend: data.onManualSend !== false,
    onCatalog: data.onCatalog !== false,
  };
}

async function contactHasOrder(tenantId, phone, { scanOrders = false } = {}) {
  const contactSnap = await db.collection('tenants').doc(tenantId).collection('contacts').doc(phone).get();
  if (contactSnap.exists && contactSnap.data()?.hasOrder === true) return true;
  if (!scanOrders) return false;

  const target = digitsOnly(phone);
  if (target.length < 10) return false;

  const orders = await db
    .collection('tenants')
    .doc(tenantId)
    .collection('orders')
    .orderBy('createdAt', 'desc')
    .limit(80)
    .get();
  for (const doc of orders.docs) {
    const p = digitsOnly(doc.data().customerPhone);
    if (!p) continue;
    if (p === target || p.endsWith(target) || target.endsWith(p)) return true;
  }
  return false;
}

function isOutsideWindow(contactData) {
  const last = contactData.lastCustomerMessageAt?.toDate
    ? contactData.lastCustomerMessageAt.toDate()
    : contactData.lastCustomerMessageAt
      ? new Date(contactData.lastCustomerMessageAt)
      : null;
  if (!last) {
    if (contactData.lastMessageDirection === 'inbound' && contactData.lastMessageAt) {
      const at = contactData.lastMessageAt.toDate
        ? contactData.lastMessageAt.toDate()
        : new Date(contactData.lastMessageAt);
      return Date.now() - at.getTime() > 24 * 60 * 60 * 1000;
    }
    return true;
  }
  return Date.now() - last.getTime() > 24 * 60 * 60 * 1000;
}

/**
 * Schedule auto follow-up after an outbound touch (manual / catalog).
 * Skipped if feature off, already has order, or this send is itself a follow-up.
 */
async function scheduleAutoFollowUp(tenantId, phone, { reason = 'outbound' } = {}) {
  const settings = await loadFollowUpSettings(tenantId);
  if (!settings.enabled) return;
  if (reason === 'manual' && !settings.onManualSend) return;
  if (reason === 'catalog' && !settings.onCatalog) return;
  if (reason === 'auto_followup' || reason === 'abandoned_cart' || reason === 'broadcast') return;

  const phoneId = String(phone);
  if (await contactHasOrder(tenantId, phoneId)) {
    await cancelAutoFollowUp(tenantId, phoneId, 'has_order');
    return;
  }

  const delayMin = Math.max(5, settings.delayMinutes || 60);
  const due = new Date(Date.now() + delayMin * 60 * 1000);
  await db.collection('tenants').doc(tenantId).collection('contacts').doc(phoneId).set(
    {
      abandonedCartStatus: 'scheduled',
      abandonedCartDueAt: due,
      abandonedCartScheduledAt: new Date(),
      abandonedCartReason: reason,
      autoFollowUpAwaitingReply: true,
    },
    { merge: true }
  );
}

async function cancelAutoFollowUp(tenantId, phone, reason) {
  const ref = db.collection('tenants').doc(tenantId).collection('contacts').doc(String(phone));
  const snap = await ref.get();
  if (!snap.exists) return;
  const status = snap.data()?.abandonedCartStatus;
  if (status !== 'scheduled' && status !== 'seen_pending') return;
  await ref.set(
    {
      abandonedCartStatus: reason === 'has_order' || reason === 'order' ? 'converted' : 'cancelled',
      abandonedCartCancelReason: reason,
      abandonedCartCancelledAt: new Date(),
      autoFollowUpAwaitingReply: false,
    },
    { merge: true }
  );
}

async function markFollowUpSeen(tenantId, phone) {
  const ref = db.collection('tenants').doc(tenantId).collection('contacts').doc(String(phone));
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() || {};
  if (data.abandonedCartStatus !== 'scheduled') return;
  await ref.set({ abandonedCartSeenAt: new Date() }, { merge: true });
}

async function processAbandonedCarts() {
  const now = new Date();
  const tenants = await db.collection('tenants').listDocuments();

  for (const tenantRef of tenants) {
    const settings = await loadFollowUpSettings(tenantRef.id);
    if (!settings.enabled) continue;

    const waConfig = await getTenantWhatsappConfig(tenantRef.id);
    if (!waConfig) continue;

    const due = await tenantRef
      .collection('contacts')
      .where('abandonedCartStatus', '==', 'scheduled')
      .limit(40)
      .get();

    for (const doc of due.docs) {
      const data = doc.data();
      const dueAt = data.abandonedCartDueAt?.toDate
        ? data.abandonedCartDueAt.toDate()
        : data.abandonedCartDueAt
          ? new Date(data.abandonedCartDueAt)
          : null;
      if (!dueAt || dueAt > now) continue;

      try {
        // Customer replied after we scheduled → cancel.
        if (data.lastMessageDirection === 'inbound') {
          const lastAt = data.lastMessageAt?.toDate ? data.lastMessageAt.toDate() : null;
          const scheduledAt = data.abandonedCartScheduledAt?.toDate
            ? data.abandonedCartScheduledAt.toDate()
            : null;
          if (lastAt && scheduledAt && lastAt > scheduledAt) {
            await doc.ref.update({
              abandonedCartStatus: 'cancelled',
              abandonedCartCancelReason: 'replied',
              autoFollowUpAwaitingReply: false,
            });
            continue;
          }
        }

        if (await contactHasOrder(tenantRef.id, doc.id)) {
          await doc.ref.update({
            abandonedCartStatus: 'converted',
            abandonedCartCancelReason: 'has_order',
            hasOrder: true,
            autoFollowUpAwaitingReply: false,
          });
          continue;
        }

        const outside = isOutsideWindow(data);
        let preview;
        let result;

        if (outside) {
          if (!settings.templateName) {
            await doc.ref.update({
              abandonedCartStatus: 'failed',
              abandonedCartError: '24h window closed — set a Meta template in Auto follow-up settings',
            });
            continue;
          }
          result = await sendTemplateMessage(waConfig.phoneNumberId, waConfig.accessToken, doc.id, {
            name: settings.templateName,
            languageCode: settings.templateLanguage,
          });
          preview = `Template: ${settings.templateName}`;
          await recordOutboundBotMessage(
            tenantRef.id,
            doc.id,
            { type: 'text', text: preview },
            result,
            'auto_followup'
          );
        } else {
          const text = settings.message;
          result = await sendTextMessage(waConfig.phoneNumberId, waConfig.accessToken, doc.id, text);
          preview = text;
          await recordOutboundBotMessage(
            tenantRef.id,
            doc.id,
            { type: 'text', text },
            result,
            'auto_followup'
          );
        }

        await doc.ref.update({
          abandonedCartStatus: 'sent',
          abandonedCartSentAt: new Date(),
          abandonedCartUsedTemplate: outside,
          lastMessageAt: new Date(),
          lastMessageDirection: 'outbound',
          lastMessageText: String(preview).slice(0, 120),
          autoFollowUpAwaitingReply: false,
        });
      } catch (err) {
        console.error(`Auto follow-up failed ${tenantRef.id}/${doc.id}:`, err.response?.data || err.message);
        await doc.ref.update({
          abandonedCartStatus: 'failed',
          abandonedCartError: String(err.response?.data?.error?.message || err.message).slice(0, 300),
        });
      }
    }
  }
}

function startAbandonedCartScheduler() {
  setInterval(() => {
    runIfQuotaOk(processAbandonedCarts, 'Auto follow-up scheduler');
  }, POLL_MS);
  console.log('Auto follow-up scheduler started (every 60s)');
}

module.exports = {
  startAbandonedCartScheduler,
  processAbandonedCarts,
  loadFollowUpSettings,
  scheduleAutoFollowUp,
  cancelAutoFollowUp,
  markFollowUpSeen,
  contactHasOrder,
};
