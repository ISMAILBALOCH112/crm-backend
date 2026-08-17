const { db } = require('./firebase');
const { runIfQuotaOk } = require('./firestoreQuota');
const { requireTenantRole } = require('./auth');
const { getTenantWhatsappConfig } = require('./whatsappConfig');
const { sendTextMessage, sendTemplateMessage } = require('./whatsapp');
const { assertTenantPlanActive } = require('./billing');
const express = require('express');

const router = express.Router();

// Create a broadcast campaign (template or text). Processed by scheduler.
router.post('/tenants/:tenantId/broadcasts', requireTenantRole('admin'), async (req, res) => {
  const { tenantId } = req.params;

  try {
    await assertTenantPlanActive(tenantId);
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message, code: err.code || 'PLAN_EXPIRED' });
  }
  const {
    name,
    audience = 'all', // all | tag
    tag,
    mode = 'template', // template | text
    text,
    templateName,
    languageCode,
    components,
  } = req.body || {};

  const config = await getTenantWhatsappConfig(tenantId);
  if (!config) {
    return res.status(400).json({ error: 'WhatsApp is not connected.' });
  }

  if (mode === 'text' && !(text || '').trim()) {
    return res.status(400).json({ error: 'Message text is required.' });
  }
  if (mode === 'template' && !(templateName || '').trim()) {
    return res.status(400).json({ error: 'Template name is required.' });
  }
  if (audience === 'tag' && !(tag || '').trim()) {
    return res.status(400).json({ error: 'Tag is required for tag audience.' });
  }

  let contactsSnap = await db.collection('tenants').doc(tenantId).collection('contacts').get();
  let phones = contactsSnap.docs.map((d) => d.id);
  if (audience === 'tag') {
    const needle = String(tag).trim().toLowerCase();
    phones = contactsSnap.docs
      .filter((d) => {
        const tags = (d.data().tags || []).map((t) => String(t).toLowerCase());
        return tags.includes(needle);
      })
      .map((d) => d.id);
  }

  if (phones.length === 0) {
    return res.status(400).json({ error: 'No contacts match this audience.' });
  }

  const ref = db.collection('tenants').doc(tenantId).collection('broadcasts').doc();
  const recipients = phones.slice(0, 500); // safety cap
  await ref.set({
    name: (name || '').trim() || `Broadcast ${new Date().toISOString().slice(0, 16)}`,
    audience,
    tag: audience === 'tag' ? String(tag).trim() : null,
    mode,
    text: mode === 'text' ? String(text).trim() : null,
    templateName: mode === 'template' ? String(templateName).trim() : null,
    languageCode: languageCode || 'en_US',
    components: components || null,
    status: 'queued',
    total: recipients.length,
    sent: 0,
    failed: 0,
    createdBy: req.uid,
    createdAt: new Date(),
    recipientPhones: recipients,
    cursor: 0,
  });

  res.json({ ok: true, id: ref.id, total: recipients.length });
});

router.get('/tenants/:tenantId/broadcasts', requireTenantRole('member'), async (req, res) => {
  const { tenantId } = req.params;
  const snap = await db
    .collection('tenants')
    .doc(tenantId)
    .collection('broadcasts')
    .orderBy('createdAt', 'desc')
    .limit(30)
    .get();

  res.json({
    ok: true,
    broadcasts: snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        name: data.name,
        status: data.status,
        total: data.total || 0,
        sent: data.sent || 0,
        failed: data.failed || 0,
        mode: data.mode,
        createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
      };
    }),
  });
});

async function processBroadcastQueue() {
  const tenants = await db.collection('tenants').listDocuments();
  for (const tenantRef of tenants) {
    const queued = await tenantRef
      .collection('broadcasts')
      .where('status', 'in', ['queued', 'sending'])
      .limit(5)
      .get();

    for (const doc of queued.docs) {
      const data = doc.data();
      const config = await getTenantWhatsappConfig(tenantRef.id);
      if (!config) {
        await doc.ref.update({ status: 'failed', error: 'WhatsApp not connected', updatedAt: new Date() });
        continue;
      }

      const phones = data.recipientPhones || [];
      let cursor = data.cursor || 0;
      let sent = data.sent || 0;
      let failed = data.failed || 0;

      await doc.ref.update({ status: 'sending', updatedAt: new Date() });

      const batchSize = 8;
      const slice = phones.slice(cursor, cursor + batchSize);
      for (const phone of slice) {
        try {
          let result;
          let preview;
          let type;
          let templateName = null;
          if (data.mode === 'template') {
            result = await sendTemplateMessage(config.phoneNumberId, config.accessToken, phone, {
              name: data.templateName,
              languageCode: data.languageCode || 'en_US',
              components: data.components,
            });
            type = 'template';
            templateName = data.templateName;
            preview = `Template: ${data.templateName}`;
          } else {
            result = await sendTextMessage(config.phoneNumberId, config.accessToken, phone, data.text);
            type = 'text';
            preview = data.text;
          }

          const contactRef = tenantRef.collection('contacts').doc(phone);
          await contactRef.set(
            {
              phone,
              lastMessageAt: new Date(),
              lastMessageDirection: 'outbound',
              lastMessageText: preview,
            },
            { merge: true }
          );
          await contactRef.collection('messages').add({
            direction: 'outbound',
            type,
            text: type === 'text' ? data.text : preview,
            templateName,
            waMessageId: result.messages?.[0]?.id,
            status: 'sent',
            timestamp: new Date(),
            source: 'broadcast',
            broadcastId: doc.id,
            sentBy: data.createdBy || null,
          });
          sent += 1;
        } catch (err) {
          failed += 1;
          console.error(`Broadcast ${doc.id} → ${phone}:`, err.response?.data || err.message);
        }
        cursor += 1;
      }

      const done = cursor >= phones.length;
      await doc.ref.update({
        cursor,
        sent,
        failed,
        status: done ? 'completed' : 'sending',
        updatedAt: new Date(),
        ...(done ? { completedAt: new Date() } : {}),
      });
    }
  }
}

function startBroadcastScheduler() {
  setInterval(() => {
    runIfQuotaOk(processBroadcastQueue, 'Broadcast scheduler');
  }, 60000);
  console.log('Broadcast scheduler started (every 60s)');
}

module.exports = { router, startBroadcastScheduler, processBroadcastQueue };
