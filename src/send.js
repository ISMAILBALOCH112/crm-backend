const express = require('express');
const db = require('./firebase').db;
const { sendTextMessage } = require('./whatsapp');
const { getTenantWhatsappConfig } = require('./whatsappConfig');
const { requireTenantRole } = require('./auth');

const router = express.Router();

// Called by a signed-in tenant member: POST { "to": "923001234567", "text": "hi" }
router.post('/tenants/:tenantId/send', requireTenantRole('member'), async (req, res) => {
  const tenantId = req.params.tenantId;
  const { to, text } = req.body;
  if (!to || !text) {
    return res.status(400).json({ error: 'Both "to" and "text" are required.' });
  }

  const config = await getTenantWhatsappConfig(tenantId);
  if (!config) {
    return res.status(400).json({ error: 'This business has not connected a WhatsApp number yet.' });
  }

  try {
    const result = await sendTextMessage(config.phoneNumberId, config.accessToken, to, text);

    const contactRef = db.collection('tenants').doc(tenantId).collection('contacts').doc(to);
    await contactRef.set({ phone: to, lastMessageAt: new Date() }, { merge: true });
    await contactRef.collection('messages').add({
      direction: 'outbound',
      text,
      waMessageId: result.messages?.[0]?.id,
      status: 'sent',
      timestamp: new Date(),
    });

    res.json({ ok: true, result });
  } catch (err) {
    console.error('Error sending message:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

module.exports = router;
