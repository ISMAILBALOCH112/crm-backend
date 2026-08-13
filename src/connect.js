const express = require('express');
const crypto = require('crypto');
const { db } = require('./firebase');
const { verifyCredentials } = require('./whatsapp');
const { requireTenantRole } = require('./auth');

const router = express.Router();

// A tenant admin pastes their own Meta App Secret / Phone Number ID / Access
// Token here (manual "Option B" connect, no Embedded Signup yet). We verify
// them against Meta before saving, then hand back the webhook URL + verify
// token the admin still has to paste into their own Meta App Dashboard.
router.post('/tenants/:tenantId/whatsapp/connect', requireTenantRole('admin'), async (req, res) => {
  const { tenantId } = req.params;
  const { phoneNumberId, accessToken, appSecret } = req.body;

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

  await db.collection('tenants').doc(tenantId).collection('private').doc('whatsapp').set({
    phoneNumberId,
    accessToken,
    appSecret,
    verifyToken,
    connectedAt: new Date(),
  });

  await db.collection('tenants').doc(tenantId).update({
    whatsappConnected: true,
    whatsappPhoneDisplay: phoneInfo.display_phone_number || null,
    whatsappVerifiedName: phoneInfo.verified_name || null,
    whatsappQualityRating: phoneInfo.quality_rating || null,
    whatsappCodeVerificationStatus: phoneInfo.code_verification_status || null,
  });

  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: true,
    phoneNumber: phoneInfo.display_phone_number,
    verifiedName: phoneInfo.verified_name,
    webhookUrl: `${baseUrl}/webhook/${tenantId}`,
    verifyToken,
  });
});

module.exports = router;
