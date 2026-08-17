const axios = require('axios');
const { toLocalPkPhone, piecesFromOrder, itemsText, pickTracking, codCollectAmount } = require('./util');

const BASE = 'https://merchantapi.leopardscourier.com/api';

async function leopardPost(path, body) {
  const response = await axios.post(`${BASE}/${path}`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 25000,
  });
  return response.data;
}

function form(data) {
  return new URLSearchParams(data).toString();
}

async function resolveCityId(apiKey, apiPassword, cityName) {
  const data = await leopardPost(
    'getAllCities/format/json/',
    form({ api_key: apiKey, api_password: apiPassword })
  );
  const cities = data?.city_list || data?.cities || data || [];
  const list = Array.isArray(cities) ? cities : [];
  const needle = String(cityName || '').trim().toLowerCase();
  const match = list.find((c) => String(c.city_name || c.name || '').toLowerCase() === needle)
    || list.find((c) => String(c.city_name || c.name || '').toLowerCase().includes(needle));
  return match?.city_id || match?.id || null;
}

async function bookLeopard(secrets, order) {
  const apiKey = secrets.leopardApiKey;
  const apiPassword = secrets.leopardApiPassword;
  if (!apiKey || !apiPassword) throw new Error('Add Leopard API key and password in courier settings.');

  const destId = await resolveCityId(apiKey, apiPassword, order.city);
  if (!destId) throw new Error(`Leopard city not found: ${order.city}. Use the exact city name from Leopard.`);

  const payload = {
    api_key: apiKey,
    api_password: apiPassword,
    booked_packet_weight: '500',
    booked_packet_no_piece: String(piecesFromOrder(order)),
    booked_packet_collect_amount: String(codCollectAmount(order)),
    booked_packet_order_id: order.orderCode || order.id,
    origin_city: secrets.leopardOriginCityId || 'self',
    destination_city: String(destId),
    shipment_name_eng: 'self',
    shipment_email: 'self',
    shipment_phone: 'self',
    shipment_address: 'self',
    consignment_name_eng: order.customerName,
    consignment_phone: toLocalPkPhone(order.customerPhone),
    consignment_address: order.address || order.city,
    special_instructions: order.notes || itemsText(order),
  };

  const raw = await leopardPost('bookPacket/format/json/', form(payload));
  if (raw?.status === false || raw?.error === 1) {
    throw new Error(raw.error_msg || raw.message || 'Leopard booking failed.');
  }
  return { raw, trackingNumber: raw.track_number || pickTracking(raw) };
}

async function trackLeopard(secrets, trackingNumber) {
  const apiKey = secrets.leopardApiKey;
  const apiPassword = secrets.leopardApiPassword;
  if (!apiKey || !apiPassword) throw new Error('Add Leopard API key and password in courier settings.');

  const response = await axios.get(`${BASE}/trackBookedPacket/format/json/`, {
    params: { api_key: apiKey, api_password: apiPassword, track_numbers: trackingNumber },
    timeout: 25000,
  });
  const raw = response.data;
  const list = raw?.packet_list || raw?.data?.packet_list || [];
  const first = Array.isArray(list) ? list[0] || {} : {};
  return {
    raw,
    courierStatus: first.booked_packet_status || first.packet_status || first.status || '',
  };
}

module.exports = { bookLeopard, trackLeopard };
