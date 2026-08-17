const { db } = require('./firebase');

const CATALOG_KEYWORDS = [
  'price',
  'prices',
  'catalog',
  'catalogue',
  'product',
  'products',
  'menu',
  'items',
  'kitne',
  'kitna',
  'rate',
  'rates',
  'price list',
  'pricelist',
  'available',
  'stock',
  'kia hai',
  'kya hai',
  'list',
];

async function loadActiveProducts(tenantId, limit = 40) {
  const snap = await db
    .collection('tenants')
    .doc(tenantId)
    .collection('products')
    .where('active', '==', true)
    .limit(limit)
    .get();

  return snap.docs
    .map((doc) => {
      const d = doc.data() || {};
      return {
        id: doc.id,
        name: String(d.name || '').trim(),
        price: Number(d.price || 0),
        description: String(d.description || '').trim(),
        sku: String(d.sku || '').trim(),
      };
    })
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatCatalogForPrompt(products) {
  if (!products.length) return '';
  const lines = products.map((p) => {
    let line = `- ${p.name}: PKR ${p.price.toFixed(0)}`;
    if (p.description) line += ` — ${p.description}`;
    if (p.sku) line += ` (SKU: ${p.sku})`;
    return line;
  });
  return (
    '\n\nProduct catalog (use only these products/prices when customers ask; if something is not listed, say you will check with the team):\n' +
    lines.join('\n')
  );
}

function formatCatalogListMessage(products, businessName) {
  if (!products.length) {
    return 'Abhi catalog empty hai. Team se poochhein — jaldi update karenge.';
  }
  const title = businessName ? `*${businessName} — Catalog*` : '*Product catalog*';
  const lines = products.slice(0, 25).map((p, i) => {
    let line = `${i + 1}. *${p.name}* — PKR ${p.price.toFixed(0)}`;
    if (p.description) line += `\n   ${p.description}`;
    return line;
  });
  let body = `${title}\n\n${lines.join('\n')}`;
  if (products.length > 25) body += `\n\n…aur ${products.length - 25} items. Order ke liye bata dein kaunsa chahiye.`;
  else body += '\n\nOrder ke liye product name + qty likh dein.';
  if (body.length > 3500) body = `${body.slice(0, 3497)}...`;
  return body;
}

function wantsCatalogList(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CATALOG_KEYWORDS.some((k) => lower.includes(k));
}

module.exports = {
  loadActiveProducts,
  formatCatalogForPrompt,
  formatCatalogListMessage,
  wantsCatalogList,
};
