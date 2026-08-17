const express = require('express');
const { listMessageTemplates, resolveWabaId } = require('./whatsapp');
const { getTenantWhatsappConfig } = require('./whatsappConfig');
const { requireTenantRole } = require('./auth');
const { db } = require('./firebase');

const router = express.Router();

async function ensureWabaId(tenantId, config) {
  if (config.wabaId) return config.wabaId;
  const resolved = await resolveWabaId(config.phoneNumberId, config.accessToken);
  if (!resolved) return null;
  await db.collection('tenants').doc(tenantId).collection('private').doc('whatsapp').set(
    { wabaId: resolved, updatedAt: new Date() },
    { merge: true }
  );
  return resolved;
}

// List Meta-approved WhatsApp message templates for this tenant's WABA.
router.get('/tenants/:tenantId/wa-templates', requireTenantRole('member'), async (req, res) => {
  const { tenantId } = req.params;
  const config = await getTenantWhatsappConfig(tenantId);
  if (!config) {
    return res.status(400).json({ error: 'This business has not connected a WhatsApp number yet.' });
  }

  try {
    const wabaId = await ensureWabaId(tenantId, config);
    if (!wabaId) {
      return res.status(400).json({
        error:
          'WhatsApp Business Account ID missing. Open Settings → WhatsApp and save your WABA ID (from Meta Business Suite).',
        code: 'WABA_REQUIRED',
      });
    }

    const templates = await listMessageTemplates(wabaId, config.accessToken, { status: 'APPROVED' });
    const mapped = templates.map((t) => {
      const bodyComp = (t.components || []).find((c) => c.type === 'BODY');
      const headerComp = (t.components || []).find((c) => c.type === 'HEADER');
      const bodyText = bodyComp?.text || '';
      const bodyVars = (bodyText.match(/\{\{\d+\}\}/g) || []).length;
      const headerVars =
        headerComp?.format === 'TEXT' ? (String(headerComp.text || '').match(/\{\{\d+\}\}/g) || []).length : 0;
      return {
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
        bodyText,
        bodyVarCount: bodyVars,
        headerVarCount: headerVars,
        headerFormat: headerComp?.format || null,
        components: t.components || [],
      };
    });

    res.json({ ok: true, wabaId, templates: mapped });
  } catch (err) {
    console.error('List WA templates failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

module.exports = router;
