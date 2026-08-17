const express = require('express');
const crypto = require('crypto');
const { db } = require('./firebase');
const { verifyCredentials, resolveWabaId } = require('./whatsapp');
const { getTenantWhatsappConfig, invalidateWhatsappConfig } = require('./whatsappConfig');
const { requireTenantRole } = require('./auth');

const router = express.Router();

function webhookBaseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Returns the current webhook URL + verify token without rotating credentials.
router.get('/tenants/:tenantId/whatsapp/webhook-info', requireTenantRole('admin'), async (req, res) => {
  const { tenantId } = req.params;
  const config = await getTenantWhatsappConfig(tenantId);
  if (!config) {
    return res.status(400).json({ error: 'WhatsApp is not connected for this business.' });
  }

  res.json({
    webhookUrl: `${webhookBaseUrl(req)}/webhook/${tenantId}`,
    verifyToken: config.verifyToken,
    wabaId: config.wabaId || null,
  });
});

// A tenant admin pastes their own Meta App Secret / Phone Number ID / Access
// Token here (manual connect). We verify them against Meta before saving, then
// hand back the webhook URL + verify token for the Meta App Dashboard.
router.post('/tenants/:tenantId/whatsapp/connect', requireTenantRole('admin'), async (req, res) => {
  const { tenantId } = req.params;
  const { phoneNumberId, accessToken, appSecret, wabaId: rawWabaId } = req.body;

  if (!phoneNumberId || !accessToken || !appSecret) {
    return res.status(400).json({ error: 'phoneNumberId, accessToken and appSecret are all required.' });
  }

  let phoneInfo;
  try {
    phoneInfo = await verifyCredentials(phoneNumberId, accessToken);
  } catch (err) {
    return res.status(400).json({
      error: 'Could not verify these credentials with Meta. Double-check the Phone Number ID and Access Token.',
      details: err.response?.data || err.message,
    });
  }

  const verifyToken = crypto.randomBytes(16).toString('hex');
  let wabaId = typeof rawWabaId === 'string' ? rawWabaId.trim() : '';
  if (!wabaId) {
    wabaId = (await resolveWabaId(phoneNumberId, accessToken)) || '';
  }

  const privateData = {
    phoneNumberId,
    accessToken,
    appSecret,
    verifyToken,
    connectedAt: new Date(),
  };
  if (wabaId) privateData.wabaId = wabaId;

  await db.collection('tenants').doc(tenantId).collection('private').doc('whatsapp').set(privateData);
  invalidateWhatsappConfig(tenantId);

  await db.collection('tenants').doc(tenantId).update({
    whatsappConnected: true,
    whatsappPhoneDisplay: phoneInfo.display_phone_number || null,
    whatsappVerifiedName: phoneInfo.verified_name || null,
    whatsappQualityRating: phoneInfo.quality_rating || null,
    whatsappCodeVerificationStatus: phoneInfo.code_verification_status || null,
  });

  const baseUrl = webhookBaseUrl(req);
  res.json({
    ok: true,
    phoneNumber: phoneInfo.display_phone_number,
    verifiedName: phoneInfo.verified_name,
    webhookUrl: `${baseUrl}/webhook/${tenantId}`,
    verifyToken,
    wabaId: wabaId || null,
  });
});

// Save / refresh WhatsApp Business Account ID (needed to list message templates).
router.post('/tenants/:tenantId/whatsapp/waba', requireTenantRole('admin'), async (req, res) => {
  const { tenantId } = req.params;
  const config = await getTenantWhatsappConfig(tenantId);
  if (!config) {
    return res.status(400).json({ error: 'WhatsApp is not connected for this business.' });
  }

  let wabaId = typeof req.body?.wabaId === 'string' ? req.body.wabaId.trim() : '';
  if (!wabaId) {
    wabaId = (await resolveWabaId(config.phoneNumberId, config.accessToken)) || '';
  }
  if (!wabaId) {
    return res.status(400).json({
      error: 'Could not detect WABA ID. Paste WhatsApp Business Account ID from Meta Business Suite.',
    });
  }

  await db.collection('tenants').doc(tenantId).collection('private').doc('whatsapp').set(
    { wabaId, updatedAt: new Date() },
    { merge: true }
  );
  invalidateWhatsappConfig(tenantId);
  res.json({ ok: true, wabaId });
});

/** Business profile snapshot for CRM settings (display only — edit in Meta). */
router.get('/tenants/:tenantId/whatsapp/profile', requireTenantRole('member'), async (req, res) => {
  const { tenantId } = req.params;
  const config = await getTenantWhatsappConfig(tenantId);
  const tenantSnap = await db.collection('tenants').doc(tenantId).get();
  const tenant = tenantSnap.data() || {};

  if (!config) {
    return res.json({
      connected: false,
      businessName: tenant.businessName || null,
    });
  }

  let live = null;
  try {
    live = await verifyCredentials(config.phoneNumberId, config.accessToken);
  } catch (_) {}

  res.json({
    connected: true,
    businessName: tenant.businessName || null,
    displayPhone: live?.display_phone_number || tenant.whatsappPhoneDisplay || null,
    verifiedName: live?.verified_name || tenant.whatsappVerifiedName || null,
    qualityRating: live?.quality_rating || tenant.whatsappQualityRating || null,
    codeVerificationStatus:
      live?.code_verification_status || tenant.whatsappCodeVerificationStatus || null,
    wabaId: config.wabaId || null,
    editHint: 'Business hours, address, and catalog on Meta are edited in Meta Business Suite / WhatsApp Manager — not via Cloud API from this CRM.',
  });
});

module.exports = router;
