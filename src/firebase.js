const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');

const serviceAccountPath = path.resolve(
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json'
);

initializeApp({
  credential: cert(require(serviceAccountPath)),
});

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = {
  db,
  auth: getAuth(),
};
