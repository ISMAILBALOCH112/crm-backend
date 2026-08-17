const axios = require('axios');
const { codCollectAmount } = require('./couriers/util');

const POSTEX_BASE = 'https://api.postex.pk/services/integration/api/order';

function client(token) {
  return axios.create({
    baseURL: POSTEX_BASE,
    headers: { token, 'Content-Type': 'application/json' },
    timeout: 25000,
  });
}

function toLocalPkPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('92')) digits = `0${digits.slice(2)}`;
  if (!digits.startsWith('0') && digits.length === 10) digits = `0${digits}`;
  return digits;
}

function extractTracking(payload) {
  const dist = payload?.dist || payload?.data || payload;
  return (
    dist?.trackingNumber ||
    dist?.TrackingNumber ||
    dist?.cnNumber ||
    dist?.airwayBill ||
    payload?.trackingNumber ||
    null
  );
}

async function testToken(token) {
  try {
    const response = await client(token).get('/v2/get-operational-city', {
      params: { operationalCityType: 'Normal' },
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) throw err;
    if (status === 400) return err.response.data;
    throw err;
  }
}

async function createPostexOrder(token, order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const pieces = items.reduce((sum, i) => sum + (Number(i.qty) || 1), 0) || 1;
  const phone = toLocalPkPhone(order.customerPhone);
  const payload = {
    orderRefNumber: order.orderCode || order.id,
    invoicePayment: String(codCollectAmount(order)),
    orderDetail: items.map((i) => `${i.name || 'Item'} x${i.qty || 1}`).join(', ') || 'Order',
    customerName: order.customerName,
    customerPhone: phone,
    deliveryAddress: order.address || order.city || 'Pakistan',
    cityName: order.city,
    invoiceDivision: 1,
    items: pieces,
    orderType: 'Normal',
  };
  if (order.notes) payload.transactionNotes = order.notes;

  const response = await client(token).post('/v3/create-order', payload);
  return { raw: response.data, trackingNumber: extractTracking(response.data), payload };
}

async function trackPostex(token, trackingNumber) {
  const response = await client(token).get(`/v1/track-order/${encodeURIComponent(trackingNumber)}`);
  const dist = response.data?.dist;
  const rec = Array.isArray(dist) ? dist[0] : dist || {};
  const history = rec.transactionStatusHistory;
  const last = Array.isArray(history) && history.length ? history[history.length - 1] : null;
  return {
    raw: response.data,
    courierStatus: rec.transactionStatus || last?.transactionStatusMessage || '',
    code: last?.transactionStatusMessageCode || '',
  };
}

module.exports = { testToken, createPostexOrder, trackPostex, toLocalPkPhone, extractTracking };
