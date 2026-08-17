const axios = require('axios');
const { toLocalPkPhone, piecesFromOrder, itemsText, pickTracking, codCollectAmount } = require('./util');

async function bookBlueEx(secrets, order) {
  const username = secrets.blueexUsername;
  const password = secrets.blueexPassword;
  const account = secrets.blueexAccount;
  if (!username || !password || !account) {
    throw new Error('Add BlueEx username, password and account in courier settings.');
  }

  const payload = {
    username,
    password,
    acno: account,
    testmode: '0',
    consignee: order.customerName,
    customer_cnic: '',
    origin_city: secrets.blueexOriginCity || 'KHI',
    destination_city: order.city,
    address: order.address || order.city,
    phone: toLocalPkPhone(order.customerPhone),
    product_detail: itemsText(order),
    pieces: String(piecesFromOrder(order)),
    weight: '0.5',
    cod_amount: String(codCollectAmount(order)),
    customer_reference: order.orderCode || order.id,
    service_code: 'BE',
    remark: order.notes || '',
  };

  const response = await axios.post('https://bigazure.com/api/json_v3/shipment/create_shipment.php', payload, {
    timeout: 25000,
  });
  const raw = response.data;
  const tracking = raw?.cn || raw?.CN || raw?.success?.cn || pickTracking(raw);
  if (!tracking) throw new Error(raw?.error || raw?.message || 'BlueEx did not return a CN.');
  return { raw, trackingNumber: String(tracking) };
}

async function trackBlueEx(secrets, trackingNumber) {
  const username = secrets.blueexUsername;
  const password = secrets.blueexPassword;
  if (!username || !password) throw new Error('Add BlueEx username and password in courier settings.');

  const response = await axios.post(
    'https://bigazure.com/api/json_v3/shipment/get_status.php',
    { username, password, acno: secrets.blueexAccount || '', consignment: trackingNumber, cn: trackingNumber },
    { timeout: 25000 }
  );
  const raw = response.data;
  const rec = raw?.status || raw?.data || raw;
  return {
    raw,
    courierStatus:
      (typeof rec === 'string' ? rec : rec?.status || rec?.current_status || raw?.message) || '',
  };
}

module.exports = { bookBlueEx, trackBlueEx };
