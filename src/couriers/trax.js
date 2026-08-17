const axios = require('axios');
const { toLocalPkPhone, piecesFromOrder, itemsText, pickTracking, codCollectAmount } = require('./util');

async function bookTrax(secrets, order) {
  const apiKey = secrets.traxApiKey;
  if (!apiKey) throw new Error('Add Trax API key in courier settings.');

  const payload = {
    consignee_city_name: order.city,
    consignee_name: order.customerName,
    consignee_address: order.address || order.city,
    consignee_phone_number_1: toLocalPkPhone(order.customerPhone),
    consignee_email: 'na@na.com',
    origin_city_name: secrets.traxOriginCity || 'Karachi',
    shipping_mode_code: 'REG',
    amount: codCollectAmount(order),
    shipping_type: 'REGULAR',
    pieces: piecesFromOrder(order),
    weight: 0.5,
    item_description: itemsText(order),
    order_id: order.orderCode || order.id,
    item_product_type_id: 1,
  };

  const response = await axios.post('https://sonic.pk/api/shipment/book', payload, {
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    timeout: 25000,
  });
  const raw = response.data;
  const tracking = raw?.tracking_number || raw?.trackingNumber || pickTracking(raw);
  if (!tracking) throw new Error(raw?.message || 'Trax did not return a tracking number.');
  return { raw, trackingNumber: String(tracking) };
}

async function trackTrax(secrets, trackingNumber) {
  const apiKey = secrets.traxApiKey;
  if (!apiKey) throw new Error('Add Trax API key in courier settings.');

  const response = await axios.get('https://sonic.pk/api/shipment/track', {
    params: { tracking_number: trackingNumber },
    headers: { Authorization: apiKey },
    timeout: 25000,
  });
  const raw = response.data;
  const rec = raw?.details || raw?.data || raw;
  return {
    raw,
    courierStatus: rec?.current_status || rec?.status || rec?.shipment_status || raw?.status || '',
  };
}

module.exports = { bookTrax, trackTrax };
