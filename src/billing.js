const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');
const { auth, db } = require('./firebase');

const PLANS = {
  d7: { planId: 'd7', label: '7 days', durationDays: 7 },
  d15: { planId: 'd15', label: '15 days', durationDays: 15 },
  m1: { planId: 'm1', label: '1 month', durationDays: 30 },
  m6: { planId: 'm6', label: '6 months', durationDays: 182 },
  m12: { planId: 'm12', label: '12 months', durationDays: 365 },
  trial_7: { planId: 'trial_7', label: '7-day trial', durationDays: 7 },
};

function normalizeKey(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9-]/g, '');
}

function generateKeyCode(planId) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chunk = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  };
  const prefix = String(planId || 'KEY').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'KEY';
  return `WT-${prefix}-${chunk(4)}-${chunk(4)}`;
}

function toDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isPlanActiveFromData(data) {
  if (!data) return true; // legacy tenants without billing fields stay usable
  const expires = toDate(data.planExpiresAt);
  if (!expires) return true;
  return expires.getTime() > Date.now();
}

const BILLING_CACHE_MS = 60 * 1000;
const _billingCache = new Map();

async function getTenantBilling(tenantId) {
  const hit = _billingCache.get(tenantId);
  if (hit && Date.now() - hit.at < BILLING_CACHE_MS) return hit.data;
  const snap = await db.collection('tenants').doc(tenantId).get();
  if (!snap.exists) {
    _billingCache.set(tenantId, { at: Date.now(), data: null });
    return null;
  }
  const data = snap.data() || {};
  const expires = toDate(data.planExpiresAt);
  const active = isPlanActiveFromData(data);
  const billing = {
    planId: data.planId || null,
    planStatus: active ? 'active' : 'expired',
    planExpiresAt: expires ? expires.toISOString() : null,
    planActivatedAt: toDate(data.planActivatedAt)?.toISOString() || null,
    lastLicenseKeyId: data.lastLicenseKeyId || null,
    writeAllowed: active,
  };
  _billingCache.set(tenantId, { at: Date.now(), data: billing });
  return billing;
}

async function assertTenantPlanActive(tenantId) {
  const billing = await getTenantBilling(tenantId);
  if (!billing) {
    const err = new Error('Business not found.');
    err.status = 404;
    err.code = 'TENANT_NOT_FOUND';
    throw err;
  }
  if (!billing.writeAllowed) {
    const err = new Error('Plan expired. Renew with a license key to send messages or create orders.');
    err.status = 403;
    err.code = 'PLAN_EXPIRED';
    throw err;
  }
  return billing;
}

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Missing Authorization bearer token.' });
  }
  try {
    const decoded = await auth.verifyIdToken(idToken);
    req.uid = decoded.uid;
    req.authEmail = decoded.email || null;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

async function requirePlatformAdmin(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: 'Missing Authorization bearer token.' });
    }
    const decoded = await auth.verifyIdToken(idToken);
    req.uid = decoded.uid;
    req.authEmail = decoded.email || null;
    const snap = await db.collection('platformAdmins').doc(req.uid).get();
    if (!snap.exists) {
      return res.status(403).json({ error: 'Platform admin required.' });
    }
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

const router = express.Router();

router.get('/platform/me', requireAuth, async (req, res) => {
  const snap = await db.collection('platformAdmins').doc(req.uid).get();
  res.json({ ok: true, isPlatformAdmin: snap.exists, uid: req.uid });
});

router.get('/platform/plans', requireAuth, async (_req, res) => {
  res.json({
    ok: true,
    plans: Object.values(PLANS)
      .filter((p) => p.planId !== 'trial_7')
      .map((p) => ({ planId: p.planId, label: p.label, durationDays: p.durationDays })),
  });
});

router.post('/platform/license-keys', requirePlatformAdmin, async (req, res) => {
  try {
    const planIdRaw = String(req.body?.planId || '').trim();
    const count = Math.min(50, Math.max(1, Number(req.body?.count) || 1));
    const notes = (req.body?.notes || '').trim().slice(0, 200) || null;
    const customDays = Number(req.body?.durationDays);

    let planId;
    let durationDays;
    let label;

    if (planIdRaw === 'custom') {
      if (!Number.isFinite(customDays) || customDays < 1 || customDays > 3650) {
        return res.status(400).json({ error: 'Custom days must be between 1 and 3650.' });
      }
      planId = 'custom';
      durationDays = Math.floor(customDays);
      label = `${durationDays} days (custom)`;
    } else {
      const plan = PLANS[planIdRaw];
      if (!plan || planIdRaw === 'trial_7') {
        return res.status(400).json({ error: 'Invalid planId. Use d7, d15, m1, m6, m12, or custom.' });
      }
      planId = plan.planId;
      durationDays = plan.durationDays;
      label = plan.label;
    }

    const keys = [];
    const batch = db.batch();
    const keyPrefix = planId === 'custom' ? `C${durationDays}` : planId;
    for (let i = 0; i < count; i++) {
      let code = generateKeyCode(keyPrefix);
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await db.collection('licenseKeys').doc(code).get();
        if (!existing.exists) break;
        code = generateKeyCode(keyPrefix);
      }
      const ref = db.collection('licenseKeys').doc(code);
      batch.set(ref, {
        planId,
        durationDays,
        label,
        status: 'unused',
        notes,
        createdAt: new Date(),
        createdBy: req.uid,
        usedAt: null,
        usedByTenantId: null,
        usedByUid: null,
      });
      keys.push(code);
    }
    await batch.commit();
    res.json({ ok: true, keys, planId, durationDays, label });
  } catch (err) {
    console.error('Create license keys failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/platform/license-keys', requirePlatformAdmin, async (req, res) => {
  try {
    const status = (req.query.status || '').trim();
    const snap = await db.collection('licenseKeys').orderBy('createdAt', 'desc').limit(100).get();
    let keys = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        key: doc.id,
        planId: d.planId,
        durationDays: d.durationDays,
        label: d.label,
        status: d.status,
        notes: d.notes || null,
        createdAt: toDate(d.createdAt)?.toISOString() || null,
        usedAt: toDate(d.usedAt)?.toISOString() || null,
        usedByTenantId: d.usedByTenantId || null,
      };
    });
    if (status === 'unused' || status === 'used' || status === 'revoked') {
      keys = keys.filter((k) => k.status === status);
    }
    res.json({ ok: true, keys });
  } catch (err) {
    console.error('List license keys failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Lock tenant to read-only when its license key is revoked/deleted. */
async function lockTenantForKey(tenantId, keyId, reason) {
  if (!tenantId) return false;
  const now = new Date();
  // 1 minute in the past so clients clearly treat plan as expired.
  const lockedAt = new Date(now.getTime() - 60 * 1000);
  await db.collection('tenants').doc(tenantId).set(
    {
      planStatus: 'expired',
      planExpiresAt: lockedAt,
      planLockedAt: now,
      planLockReason: reason,
      planLockKeyId: keyId,
    },
    { merge: true }
  );
  return true;
}

router.post('/platform/license-keys/:key/revoke', requirePlatformAdmin, async (req, res) => {
  try {
    const key = normalizeKey(req.params.key);
    const ref = db.collection('licenseKeys').doc(key);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Key not found.' });
    const data = snap.data() || {};
    if (data.status === 'revoked') {
      return res.json({ ok: true, already: true, lockedTenantId: null });
    }

    await ref.set(
      {
        status: 'revoked',
        revokedAt: new Date(),
        revokedBy: req.uid,
      },
      { merge: true }
    );

    let lockedTenantId = null;
    // Unused revoke: no tenant. Used/revoked: always lock the account that used this key.
    if (data.usedByTenantId) {
      await lockTenantForKey(data.usedByTenantId, key, 'key_revoked');
      lockedTenantId = data.usedByTenantId;
    }

    res.json({ ok: true, key, lockedTenantId });
  } catch (err) {
    console.error('Revoke key failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/platform/license-keys/:key', requirePlatformAdmin, async (req, res) => {
  try {
    const key = normalizeKey(req.params.key);
    const ref = db.collection('licenseKeys').doc(key);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Key not found.' });
    const data = snap.data() || {};

    let lockedTenantId = null;
    if (data.usedByTenantId) {
      await lockTenantForKey(data.usedByTenantId, key, 'key_deleted');
      lockedTenantId = data.usedByTenantId;
    }

    await ref.delete();
    res.json({ ok: true, key, lockedTenantId });
  } catch (err) {
    console.error('Delete key failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/tenants/:tenantId/billing', requireAuth, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const member = await db.collection('tenants').doc(tenantId).collection('members').doc(req.uid).get();
    if (!member.exists) {
      return res.status(403).json({ error: 'Not a member of this business.' });
    }
    const billing = await getTenantBilling(tenantId);
    if (!billing) return res.status(404).json({ error: 'Business not found.' });

    // Keep planStatus field on tenant in sync when expired.
    if (billing.planStatus === 'expired') {
      await db.collection('tenants').doc(tenantId).set({ planStatus: 'expired' }, { merge: true });
    }

    res.json({ ok: true, billing, plans: Object.values(PLANS).filter((p) => p.planId !== 'trial_7') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tenants/:tenantId/billing/redeem', requireAuth, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const key = normalizeKey(req.body?.key);
    if (!key || key.length < 8) {
      return res.status(400).json({ error: 'Enter a valid license key.' });
    }

    const member = await db.collection('tenants').doc(tenantId).collection('members').doc(req.uid).get();
    if (!member.exists || member.data()?.role !== 'admin') {
      return res.status(403).json({ error: 'Only business admins can redeem a license key.' });
    }

    const keyRef = db.collection('licenseKeys').doc(key);
    const tenantRef = db.collection('tenants').doc(tenantId);

    const result = await db.runTransaction(async (tx) => {
      const [keySnap, tenantSnap] = await Promise.all([tx.get(keyRef), tx.get(tenantRef)]);
      if (!tenantSnap.exists) {
        const e = new Error('Business not found.');
        e.status = 404;
        throw e;
      }
      if (!keySnap.exists) {
        const e = new Error('Invalid license key.');
        e.status = 404;
        throw e;
      }
      const keyData = keySnap.data() || {};
      if (keyData.status === 'used') {
        const e = new Error('This license key has already been used.');
        e.status = 409;
        throw e;
      }
      if (keyData.status === 'revoked') {
        const e = new Error('This license key has been revoked.');
        e.status = 410;
        throw e;
      }
      if (keyData.status !== 'unused') {
        const e = new Error('License key is not available.');
        e.status = 400;
        throw e;
      }

      const planId = keyData.planId;
      const plan = PLANS[planId];
      const durationDays = Number(keyData.durationDays) || plan?.durationDays;
      if (!durationDays) {
        const e = new Error('License key has an invalid plan.');
        e.status = 400;
        throw e;
      }

      const tenantData = tenantSnap.data() || {};
      const now = new Date();
      const currentExpiry = toDate(tenantData.planExpiresAt);
      const onTrial = tenantData.planId === 'trial_7';
      const expired = !currentExpiry || currentExpiry.getTime() <= now.getTime();
      // Paid renew stacks; trial / expired starts from now so a 2-day key is really 2 days.
      const base = !onTrial && !expired && currentExpiry ? currentExpiry : now;
      const newExpiry = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);

      tx.update(keyRef, {
        status: 'used',
        usedAt: now,
        usedByTenantId: tenantId,
        usedByUid: req.uid,
      });
      tx.set(
        tenantRef,
        {
          planId,
          planStatus: 'active',
          planExpiresAt: newExpiry,
          planActivatedAt: now,
          lastLicenseKeyId: key,
          planLockReason: FieldValue.delete(),
          planLockKeyId: FieldValue.delete(),
          planLockedAt: FieldValue.delete(),
        },
        { merge: true }
      );

      return {
        planId,
        durationDays,
        planExpiresAt: newExpiry.toISOString(),
      };
    });

    _billingCache.delete(tenantId);
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Redeem license failed:', err.message);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

module.exports = {
  router,
  PLANS,
  getTenantBilling,
  assertTenantPlanActive,
  isPlanActiveFromData,
  normalizeKey,
};
