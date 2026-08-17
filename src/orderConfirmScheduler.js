const { db } = require('./firebase');
const { sendOrderConfirmPrompt } = require('./orderConfirm');
const { runIfQuotaOk } = require('./firestoreQuota');

const POLL_MS = 60000;

async function processDueConfirms() {
  const now = new Date();
  const tenants = await db.collection('tenants').listDocuments();

  for (const tenantRef of tenants) {
    const due = await tenantRef
      .collection('orders')
      .where('whatsappConfirmStatus', '==', 'scheduled')
      .limit(40)
      .get();

    const ready = due.docs.filter((doc) => {
      const at = doc.data().whatsappConfirmDueAt;
      const dueAt = at?.toDate ? at.toDate() : at ? new Date(at) : null;
      return dueAt && dueAt <= now;
    });

    for (const doc of ready) {
      const order = { id: doc.id, ...doc.data() };
      try {
        if (order.status !== 'pending') {
          await doc.ref.update({ whatsappConfirmStatus: 'skipped', updatedAt: new Date() });
          continue;
        }

        const result = await sendOrderConfirmPrompt(tenantRef.id, doc.id, order);
        if (result == null) {
          await doc.ref.update({
            whatsappConfirmStatus: 'skipped',
            updatedAt: new Date(),
          });
          console.log(`Order confirm prompt skipped for ${tenantRef.id}/${doc.id}`);
        } else {
          await doc.ref.update({
            whatsappConfirmStatus: 'sent',
            whatsappConfirmSentAt: new Date(),
            updatedAt: new Date(),
          });
          console.log(`Order confirm prompt sent for ${tenantRef.id}/${doc.id}`);
        }
      } catch (err) {
        console.error(`Order confirm prompt failed for ${tenantRef.id}/${doc.id}:`, err.response?.data || err.message);
        await doc.ref.update({
          whatsappConfirmStatus: 'failed',
          whatsappConfirmError: String(err.response?.data?.error?.message || err.message).slice(0, 300),
          updatedAt: new Date(),
        });
      }
    }
  }
}

function startOrderConfirmScheduler() {
  setInterval(() => {
    runIfQuotaOk(processDueConfirms, 'Order confirm scheduler');
  }, POLL_MS);
  console.log('Order confirm scheduler started (every 60s, 30-min delay)');
}

module.exports = { startOrderConfirmScheduler, processDueConfirms };
