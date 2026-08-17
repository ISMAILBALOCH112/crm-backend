const express = require('express');
const { db } = require('./firebase');
const { requireTenantRole } = require('./auth');
const { hasBotApiKey } = require('./botConfig');
const axios = require('axios');

const router = express.Router();

// Save OpenAI API key (admin only, stored in private/bot).
router.post('/tenants/:tenantId/bot/api-key', requireTenantRole('admin'), async (req, res) => {
  const { tenantId } = req.params;
  const { openaiApiKey } = req.body;

  if (!openaiApiKey || typeof openaiApiKey !== 'string' || openaiApiKey.trim().length < 10) {
    return res.status(400).json({ error: 'A valid OpenAI API key is required.' });
  }

  await db.collection('tenants').doc(tenantId).collection('private').doc('bot').set(
    { openaiApiKey: openaiApiKey.trim(), updatedAt: new Date() },
    { merge: true }
  );

  res.json({ ok: true, configured: true });
});

router.get('/tenants/:tenantId/bot/api-key/status', requireTenantRole('admin'), async (req, res) => {
  const configured = await hasBotApiKey(req.params.tenantId);
  res.json({ configured });
});

// Quick test that the stored key works.
router.post('/tenants/:tenantId/bot/test-ai', requireTenantRole('admin'), async (req, res) => {
  const { tenantId } = req.params;
  const snap = await db.collection('tenants').doc(tenantId).collection('private').doc('bot').get();
  const apiKey = snap.data()?.openaiApiKey;
  if (!apiKey) {
    return res.status(400).json({ error: 'No API key saved yet.' });
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 10,
      },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    const text = response.data.choices?.[0]?.message?.content?.trim();
    res.json({ ok: true, reply: text });
  } catch (err) {
    res.status(400).json({
      error: 'API key test failed. Check the key and billing.',
      details: err.response?.data?.error?.message || err.message,
    });
  }
});

module.exports = router;
