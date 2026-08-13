const express = require('express');
const crypto = require('crypto');
const { db } = require('./firebase');
const { getTenantWhatsappConfig } = require('./whatsappConfig');

const router = express.Router();

// Meta calls this once (GET) per tenant when their admin subscribes the
// webhook in their own Meta App Dashboard, to prove we control this URL.
router.get('/webhook/:tenantId', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const config = await getTenantWhatsappConfig(req.params.tenantId);
  if (mode === 'subscribe' && config && token === config.verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

function isValidSignature(req, appSecret) {
  const signature = req.get('x-hub-signature-256');
  if (!signature || !appSecret) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return signatureBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

// Meta calls this (POST) for every incoming message or status update, on
// the tenant whose Meta App the number belongs to.
router.post('/webhook/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  const config = await getTenantWhatsappConfig(tenantId);

  if (!config || !isValidSignature(req, config.appSecret)) {
    return res.sendStatus(401);
  }

  // Meta requires a fast ack (<20s) — process after responding.
  res.sendStatus(200);

  try {
    await recordIncomingMessages(tenantId, req.body);
    await recordStatusUpdates(tenantId, req.body);
  } catch (err) {
    console.error('Error processing webhook payload:', err);
  }
});

async function recordIncomingMessages(tenantId, payload) {
  const value = payload.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  if (!messages) return; // a status update (sent/delivered/read), not a new message

  const contact = value.contacts?.[0];

  for (const message of messages) {
    const from = message.from;
    const contactRef = db.collection('tenants').doc(tenantId).collection('contacts').doc(from);

    await contactRef.set(
      {
        phone: from,
        name: contact?.profile?.name || from,
        lastMessageAt: new Date(),
      },
      { merge: true }
    );

    await contactRef.collection('messages').add({
      direction: 'inbound',
      text: message.text?.body || '',
      type: message.type,
      waMessageId: message.id,
      status: 'delivered',
      timestamp: new Date(Number(message.timestamp) * 1000),
    });
  }
}

// Meta reports delivery progress for messages we sent (sent -> delivered ->
// read) as separate webhook events, matched back to our doc by waMessageId,
// so the UI can show real ticks instead of freezing on "sent".
async function recordStatusUpdates(tenantId, payload) {
  const value = payload.entry?.[0]?.changes?.[0]?.value;
  const statuses = value?.statuses;
  if (!statuses) return;

  for (const status of statuses) {
    const recipientId = status.recipient_id;
    if (!recipientId) continue;

    const messagesRef = db
      .collection('tenants')
      .doc(tenantId)
      .collection('contacts')
      .doc(recipientId)
      .collection('messages');

    const snap = await messagesRef.where('waMessageId', '==', status.id).limit(1).get();
    if (snap.empty) continue;

    await snap.docs[0].ref.update({ status: status.status });
  }
}

module.exports = router;
