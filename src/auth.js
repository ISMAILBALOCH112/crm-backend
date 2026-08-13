const { auth, db } = require('./firebase');

// Gates a /tenants/:tenantId/... route behind a Firebase ID token, and
// checks the caller is actually a member (or admin) of that tenant — without
// this, anyone who guessed a tenantId could connect a WhatsApp number or
// send messages as that business.
function requireTenantRole(role) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: 'Missing Authorization bearer token.' });
    }

    let uid;
    try {
      uid = (await auth.verifyIdToken(idToken)).uid;
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    const tenantId = req.params.tenantId;
    const memberSnap = await db.collection('tenants').doc(tenantId).collection('members').doc(uid).get();
    if (!memberSnap.exists) {
      return res.status(403).json({ error: 'Not a member of this business.' });
    }
    if (role === 'admin' && memberSnap.data().role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required.' });
    }

    req.uid = uid;
    next();
  };
}

module.exports = { requireTenantRole };
