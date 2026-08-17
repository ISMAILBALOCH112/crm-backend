const { db } = require('./firebase');
const { getTenantWhatsappConfig } = require('./whatsappConfig');
const { sendInteractiveButtons, sendTextMessage } = require('./whatsapp');
const { recordOutboundBotMessage } = require('./messageSender');

const DEFAULT_PENDING =
  'Assalam o Alaikum {name}! 🌟';
const DEFAULT_CONFIRMED =
  'Shukriya {name}! ✅\nAapka order *{orderCode}* confirm ho gaya hai.\nAmount: *PKR {amount}*\nJaldi pack karke ship karenge inshaAllah 🚚';
const DEFAULT_CANCELLED =
  '{name}, aapka order *{orderCode}* cancel kar diya gaya hai.\nKoi help chahiye ho to yahan message karein. 💬';
const DEFAULT_SHIPPED =
  '{name}, aapka order {orderCode} ship ho gaya hai.\nCourier: {courier}\nTracking: {tracking}';
const DEFAULT_DELIVERED =
  '{name}, aapka order {orderCode} deliver ho gaya. Shukriya! 🙏';
const DEFAULT_RETURNED =
  '{name}, aapka order {orderCode} courier se return ho gaya hai.\nTracking: {tracking}\nCourier: {courier}';

function itemsSummary(items = []) {
  if (!items.length) return 'No items';
  return items.map((i) => `${i.name || 'Item'} × ${i.qty || 1}`).join(', ');
}

function paymentMethodLabel(order) {
  const method = String(order.paymentMethod || 'cod').toLowerCase();
  if (method === 'jazzcash') return 'JazzCash';
  if (method === 'easypaisa') return 'EasyPaisa';
  return 'COD';
}

function fillTemplate(template, order) {
  const amount = Number(order.totalAmount || 0).toFixed(0);
  const code = order.orderCode || `#${order.orderNumber || ''}`;
  return String(template || '')
    .replaceAll('{name}', order.customerName || '')
    .replaceAll('{orderCode}', code)
    .replaceAll('{amount}', amount)
    .replaceAll('{items}', itemsSummary(order.items))
    .replaceAll('{city}', order.city || '—')
    .replaceAll('{address}', order.address || '—')
    .replaceAll('{tracking}', order.trackingNumber || '—')
    .replaceAll('{courier}', order.courier || 'Manual')
    .replaceAll('{phone}', order.customerPhone || '—')
    .replaceAll('{notes}', order.notes || '—')
    .replaceAll('{paymentMethod}', paymentMethodLabel(order));
}

function buildDetails(order, parcelPay) {
  const code = order.orderCode || `#${order.orderNumber || ''}`;
  const amount = Number(order.totalAmount || 0).toFixed(0);
  const method = String(order.paymentMethod || 'cod').toLowerCase();
  const methodLabel =
    method === 'jazzcash' ? 'JazzCash' : method === 'easypaisa' ? 'EasyPaisa' : 'COD (delivery)';
  const lines = [
    '━━━━━━━━━━━━',
    '📦 *Order details*',
    '━━━━━━━━━━━━',
    `🧾 Order: *${code}*`,
    `👤 Name: ${order.customerName || '—'}`,
    `📱 Phone: ${order.customerPhone || '—'}`,
    `🛍️ Items: ${itemsSummary(order.items)}`,
    `💰 Amount: *PKR ${amount}*`,
    `💳 Payment: *${methodLabel}*`,
  ];
  if (order.city) lines.push(`🏙️ City: ${order.city}`);
  if (order.address) lines.push(`📍 Address: ${order.address}`);
  if (order.notes) lines.push(`📝 Notes: ${order.notes}`);

  if (method === 'jazzcash' && parcelPay?.jazzcashNumber) {
    lines.push('━━━━━━━━━━━━');
    lines.push('📱 *JazzCash*');
    lines.push(`Number: *${parcelPay.jazzcashNumber}*`);
    if (parcelPay.jazzcashAccountName) lines.push(`Name: ${parcelPay.jazzcashAccountName}`);
    if (parcelPay.note) lines.push(parcelPay.note);
  } else if (method === 'easypaisa' && parcelPay?.easypaisaNumber) {
    lines.push('━━━━━━━━━━━━');
    lines.push('📱 *EasyPaisa*');
    lines.push(`Number: *${parcelPay.easypaisaNumber}*`);
    if (parcelPay.easypaisaAccountName) lines.push(`Name: ${parcelPay.easypaisaAccountName}`);
    if (parcelPay.note) lines.push(parcelPay.note);
  }

  return lines.join('\n');
}

async function loadNotifyConfig(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).collection('settings').doc('orderNotify').get();
  const data = snap.data() || {};
  const templates = data.templates || {};
  return {
    enabled: data.enabled !== false,
    sendOnCreate: data.sendOnCreate !== false,
    sendOnStatusChange: data.sendOnStatusChange !== false,
    templates: {
      pending: templates.pending || DEFAULT_PENDING,
      confirmed: templates.confirmed || DEFAULT_CONFIRMED,
      shipped: templates.shipped || DEFAULT_SHIPPED,
      delivered: templates.delivered || DEFAULT_DELIVERED,
      cancelled: templates.cancelled || DEFAULT_CANCELLED,
      returned: templates.returned || DEFAULT_RETURNED,
    },
  };
}

async function loadParcelPayment(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).collection('settings').doc('parcelPayment').get();
  return snap.data() || {};
}

function buildPromptBody(introTemplate, order, businessName, parcelPay) {
  const greeting = fillTemplate(introTemplate || DEFAULT_PENDING, order).trim();
  const shop = businessName ? `✨ *${businessName}* ✨\n` : '✨ *New order* ✨\n';
  const details = buildDetails(order, parcelPay);
  let body = `${shop}\n${greeting}\n\nAapka order receive ho gaya hai 💌\n\n${details}\n\nNeeche *Confirm* ya *Cancel* dabain 👇`;
  if (body.length > 1024) body = `${body.slice(0, 1021)}...`;
  return body;
}

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  return digits;
}

async function sendOrderConfirmPrompt(tenantId, orderId, order) {
  const config = await loadNotifyConfig(tenantId);
  if (!config.enabled || config.sendOnCreate === false) {
    return null;
  }

  const wa = await getTenantWhatsappConfig(tenantId);
  if (!wa) throw new Error('WhatsApp is not connected.');

  const templates = config.templates;
  const tenantSnap = await db.collection('tenants').doc(tenantId).get();
  const businessName = tenantSnap.data()?.businessName || '';
  const parcelPay = await loadParcelPayment(tenantId);
  const to = normalizePhone(order.customerPhone);
  const body = buildPromptBody(templates.pending, order, businessName, parcelPay);
  const header = `✨ ${order.orderCode || 'Order'}`.slice(0, 60);

  const result = await sendInteractiveButtons(wa.phoneNumberId, wa.accessToken, to, {
    header,
    body,
    footer: 'Confirm ya Cancel dabain ❤️',
    buttons: [
      { id: `c:${orderId}`, title: 'Confirm' },
      { id: `x:${orderId}`, title: 'Cancel' },
    ],
  });

  await recordOutboundBotMessage(
    tenantId,
    to,
    { type: 'text', text: body },
    result,
    'order_confirm_prompt'
  );

  return result;
}

async function sendStatusNotify(tenantId, order, status) {
  const config = await loadNotifyConfig(tenantId);
  if (!config.enabled || !config.sendOnStatusChange) return;

  const wa = await getTenantWhatsappConfig(tenantId);
  if (!wa) return;

  const template = config.templates[status];
  const text = fillTemplate(template, order);
  const to = normalizePhone(order.customerPhone);
  if (!text.trim() || to.length < 10) return;

  const result = await sendTextMessage(wa.phoneNumberId, wa.accessToken, to, text);
  await recordOutboundBotMessage(tenantId, to, { type: 'text', text }, result, 'order_notify');
}

async function sendStatusText(tenantId, order, status) {
  return sendStatusNotify(tenantId, order, status);
}

async function handleOrderButtonReply(tenantId, from, message) {
  const reply = message.interactive?.button_reply;
  const id = reply?.id || '';
  if (!id.startsWith('c:') && !id.startsWith('x:')) return false;

  const orderId = id.slice(2);
  const action = id.startsWith('c:') ? 'confirmed' : 'cancelled';
  const orderRef = db.collection('tenants').doc(tenantId).collection('orders').doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) return true;

  const order = { id: snap.id, ...snap.data() };
  if (order.status !== 'pending') {
    return true;
  }

  await orderRef.update({
    status: action,
    whatsappConfirmStatus: 'replied',
    updatedAt: new Date(),
  });

  await sendStatusText(tenantId, { ...order, status: action }, action);
  return true;
}

module.exports = {
  sendOrderConfirmPrompt,
  handleOrderButtonReply,
  sendStatusNotify,
  normalizePhone,
};
