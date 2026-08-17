/**
 * One-time seed: platformAdmins + ensure current tenant has an active plan.
 * Usage: node scripts/seedBilling.js [uid]
 * If uid omitted, uses tenants/{id}.createdBy for QBVIUGhehOPsB1PhkV2g or first tenant.
 */
require('dotenv').config();
const { db } = require('../src/firebase');

async function main() {
  const argUid = process.argv[2]?.trim();
  let uid = argUid || null;
  let email = null;

  const preferredTenant = 'QBVIUGhehOPsB1PhkV2g';
  let tenantSnap = await db.collection('tenants').doc(preferredTenant).get();
  if (!tenantSnap.exists) {
    const list = await db.collection('tenants').limit(1).get();
    tenantSnap = list.docs[0] || null;
  }

  if (!uid && tenantSnap) {
    uid = tenantSnap.data()?.createdBy || null;
  }
  if (!uid) {
    console.error('Pass a Firebase UID: node scripts/seedBilling.js <uid>');
    process.exit(1);
  }

  try {
    const userSnap = await db.collection('users').doc(uid).get();
    email = userSnap.data()?.email || null;
  } catch (_) {}

  await db.collection('platformAdmins').doc(uid).set(
    {
      email,
      createdAt: new Date(),
      note: 'Seeded for license key console',
    },
    { merge: true }
  );
  console.log('platformAdmins seeded:', uid, email || '');

  // Give existing tenants without expiry a 12-month active plan so they aren't locked.
  const tenants = await db.collection('tenants').get();
  const year = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  let n = 0;
  for (const doc of tenants.docs) {
    const d = doc.data() || {};
    if (d.planExpiresAt) continue;
    await doc.ref.set(
      {
        planId: 'm12',
        planStatus: 'active',
        planExpiresAt: year,
        planActivatedAt: new Date(),
      },
      { merge: true }
    );
    n++;
  }
  console.log(`Tenants without plan migrated to m12: ${n}`);
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
