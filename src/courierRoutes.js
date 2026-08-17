const express = require('express');
const { db } = require('./firebase');
const { requireTenantRole } = require('./auth');
const { testToken } = require('./postex');
const { COURIERS, courierById, isConfigured } = require('./couriers/catalog');
const { bookWithCourier } = require('./couriers/book');
const { syncTenant, syncOneOrder } = require('./cnSync');

const router = express.Router();

async function getCourierSecrets(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).collection('private').doc('courier').get();
  return snap.exists ? snap.data() : {};
}

router.get('/tenants/:tenantId/courier/status', requireTenantRole('member'), async (req, res) => {
  const secrets = await getCourierSecrets(req.params.tenantId);
  const configured = {};
  for (const courier of COURIERS) {
    configured[courier.id] = isConfigured(courier, secrets);
  }
  res.json({ configured, couriers: COURIERS.map((c) => ({ id: c.id, label: c.label })) });
});

router.post('/tenants/:tenantId/courier/:courierId/credentials', requireTenantRole('admin'), async (req, res) => {
  const { tenantId, courierId } = req.params;
  const courier = courierById(courierId);
  if (!courier) return res.status(400).json({ error: 'Unknown courier.' });

  const patch = { updatedAt: new Date() };
  for (const field of courier.fields) {
    const value = req.body?.[field.key];
    if (typeof value === 'string' && value.trim()) {
      patch[field.key] = value.trim();
    }
  }

  const required = courier.fields.filter((f) => !f.optional);
  const missing = required.filter((f) => !patch[f.key]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing: ${missing.map((f) => f.label).join(', ')}` });
  }

  if (courierId === 'PostEx') {
    try {
      await testToken(patch.postexToken);
    } catch (err) {
      return res.status(400).json({
        error: 'PostEx token test failed.',
        details: err.response?.data || err.message,
      });
    }
  }

  await db.collection('tenants').doc(tenantId).collection('private').doc('courier').set(patch, { merge: true });
  res.json({ ok: true, courierId, configured: true });
});

router.post('/tenants/:tenantId/orders/:orderId/book-cn', requireTenantRole('member'), async (req, res) => {
  const { tenantId, orderId } = req.params;
  const secrets = await getCourierSecrets(tenantId);

  const orderRef = db.collection('tenants').doc(tenantId).collection('orders').doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) return res.status(404).json({ error: 'Order not found.' });

  const order = { id: snap.id, ...snap.data() };
  const courierId = String(req.body?.courier || order.courier || '').trim();
  if (!courierId || courierId === 'Manual') {
    return res.status(400).json({ error: 'Select a courier on the order first (PostEx, Leopard, TCS…).' });
  }

  if (order.status === 'cancelled') {
    return res.status(400).json({ error: 'Cancelled orders cannot be booked.' });
  }
  if (order.trackingNumber) {
    return res.status(400).json({ error: `Already booked: ${order.trackingNumber}` });
  }
  if (!order.city || !String(order.city).trim()) {
    return res.status(400).json({ error: 'City is required before booking a CN.' });
  }
  if (!order.address || !String(order.address).trim()) {
    return res.status(400).json({ error: 'Address is required before booking a CN.' });
  }

  try {
    const booked = await bookWithCourier(courierId, secrets, order);
    const trackingNumber = booked.trackingNumber;
    if (!trackingNumber) {
      return res.status(400).json({ error: `${courierId} did not return a tracking number.`, details: booked.raw });
    }

    const nextStatus = order.status === 'delivered' ? order.status : 'shipped';
    await orderRef.update({
      trackingNumber,
      courier: courierId,
      status: nextStatus,
      whatsappConfirmStatus: 'skipped',
      cnBookedAt: new Date(),
      updatedAt: new Date(),
    });

    res.json({ ok: true, trackingNumber, status: nextStatus, courier: courierId });
  } catch (err) {
    console.error(`${courierId} book CN failed:`, err.response?.data || err.message);
    const apiError = err.response?.data;
    const message =
      apiError?.statusMessage ||
      apiError?.message ||
      (typeof apiError === 'string' ? apiError : null) ||
      err.message;
    res.status(400).json({ error: message, details: apiError || null });
  }
});

router.post('/tenants/:tenantId/orders/sync-cns', requireTenantRole('member'), async (req, res) => {
  try {
    const summary = await syncTenant(req.params.tenantId);
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('Sync CNs failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post('/tenants/:tenantId/orders/:orderId/sync-cn', requireTenantRole('member'), async (req, res) => {
  try {
    const result = await syncOneOrder(req.params.tenantId, req.params.orderId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Sync CN failed:', err.response?.data || err.message);
    const apiError = err.response?.data;
    const message =
      apiError?.statusMessage ||
      apiError?.message ||
      (typeof apiError === 'string' ? apiError : null) ||
      err.message;
    res.status(400).json({ error: message, details: apiError || null });
  }
});

module.exports = router;
