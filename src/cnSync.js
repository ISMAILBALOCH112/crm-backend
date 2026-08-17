const { db } = require('./firebase');
const { runIfQuotaOk } = require('./firestoreQuota');
const { trackWithCourier } = require('./couriers/track');
const { sendStatusNotify } = require('./orderConfirm');

const POLL_MS = 5 * 60 * 1000;
const TERMINAL = new Set(['delivered', 'cancelled', 'returned']);
const OPEN_STATUSES = ['shipped', 'confirmed'];

async function getCourierSecrets(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).collection('private').doc('courier').get();
  return snap.exists ? snap.data() : {};
}

async function syncOrderDoc(tenantId, orderDoc, secrets) {
  const order = { id: orderDoc.id, ...orderDoc.data() };
  const trackingNumber = String(order.trackingNumber || '').trim();
  if (!trackingNumber) throw new Error('No tracking number.');
  if (TERMINAL.has(order.status)) {
    return { updated: false, statusChanged: false, status: order.status, courierStatus: order.courierStatus || null };
  }

  const courierId = String(order.courier || '').trim();
  if (!courierId || courierId === 'Manual') {
    throw new Error('Select a courier (not Manual) to sync this CN.');
  }

  const tracked = await trackWithCourier(courierId, secrets, trackingNumber);
  const patch = {
    courierStatus: tracked.courierStatus,
    courierSyncedAt: new Date(),
    updatedAt: new Date(),
  };

  let statusChanged = false;
  if (tracked.mappedStatus === 'delivered' || tracked.mappedStatus === 'returned') {
    if (order.status !== tracked.mappedStatus) {
      patch.status = tracked.mappedStatus;
      patch.whatsappConfirmStatus = 'skipped';
      statusChanged = true;
    }
  }

  const sameStatusText = String(order.courierStatus || '') === tracked.courierStatus;
  if (!statusChanged && sameStatusText) {
    return { updated: false, statusChanged: false, status: order.status, courierStatus: tracked.courierStatus };
  }

  await orderDoc.ref.update(patch);

  if (statusChanged) {
    try {
      await sendStatusNotify(tenantId, { ...order, ...patch }, patch.status);
    } catch (err) {
      console.error(`CN sync WhatsApp failed for ${tenantId}/${order.id}:`, err.response?.data || err.message);
    }
  }

  return {
    updated: true,
    statusChanged,
    status: patch.status || order.status,
    courierStatus: tracked.courierStatus,
  };
}

async function syncTenant(tenantId) {
  const secrets = await getCourierSecrets(tenantId);
  const summary = { checked: 0, updated: 0, delivered: 0, returned: 0, errors: [] };
  const ordersRef = db.collection('tenants').doc(tenantId).collection('orders');

  for (const status of OPEN_STATUSES) {
    const snap = await ordersRef.where('status', '==', status).limit(80).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (!String(data.trackingNumber || '').trim()) continue;
      if (!data.courier || data.courier === 'Manual') continue;
      summary.checked += 1;
      try {
        const result = await syncOrderDoc(tenantId, doc, secrets);
        if (result.statusChanged) {
          summary.updated += 1;
          if (result.status === 'delivered') summary.delivered += 1;
          if (result.status === 'returned') summary.returned += 1;
        }
      } catch (err) {
        summary.errors.push({
          orderId: doc.id,
          orderCode: data.orderCode || doc.id,
          error: String(err.response?.data?.statusMessage || err.response?.data?.message || err.message).slice(0, 200),
        });
      }
    }
  }

  return summary;
}

async function syncOneOrder(tenantId, orderId) {
  const secrets = await getCourierSecrets(tenantId);
  const orderRef = db.collection('tenants').doc(tenantId).collection('orders').doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) throw new Error('Order not found.');
  return syncOrderDoc(tenantId, snap, secrets);
}

async function syncAllTenants() {
  const tenants = await db.collection('tenants').listDocuments();
  for (const tenantRef of tenants) {
    try {
      const summary = await syncTenant(tenantRef.id);
      if (summary.checked) {
        console.log(
          `CN sync ${tenantRef.id}: checked ${summary.checked}, updated ${summary.updated}, delivered ${summary.delivered}, returned ${summary.returned}, errors ${summary.errors.length}`
        );
      }
    } catch (err) {
      console.error(`CN sync failed for ${tenantRef.id}:`, err.message);
    }
  }
}

function startCnSyncScheduler() {
  setTimeout(() => {
    runIfQuotaOk(syncAllTenants, 'CN sync');
  }, 25000);
  setInterval(() => {
    runIfQuotaOk(syncAllTenants, 'CN sync');
  }, POLL_MS);
  console.log('CN sync scheduler started (every 5 min)');
}

module.exports = { startCnSyncScheduler, syncTenant, syncOneOrder };
