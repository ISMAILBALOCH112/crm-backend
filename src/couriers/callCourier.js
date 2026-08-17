const axios = require('axios');
const { toLocalPkPhone, piecesFromOrder, itemsText, pickTracking, codCollectAmount } = require('./util');

async function bookCallCourier(secrets, order) {
  const loginId = secrets.callCourierLoginId;
  const apiKey = secrets.callCourierApiKey;
  if (!loginId || !apiKey) throw new Error('Add Call Courier login id and API key in courier settings.');

  const params = {
    loginId,
    apiKey,
    ConsigneeName: order.customerName,
    ConsigneeRefNo: order.orderCode || order.id,
    ConsigneeCellNo: toLocalPkPhone(order.customerPhone),
    Address: order.address || order.city,
    Origin: secrets.callCourierOrigin || 'KARACHI',
    DestCityId: order.city,
    ServiceTypeId: 7,
    Pcs: piecesFromOrder(order),
    Weight: 0.5,
    Description: itemsText(order),
    CodAmount: codCollectAmount(order),
    ShipperName: secrets.callCourierShipperName || 'Shipper',
    Remarks: order.notes || '',
  };

  const response = await axios.get('https://cod.callcourier.com.pk/api/CallCourier/SaveBooking', {
    params,
    timeout: 25000,
  });
  const raw = response.data;
  const tracking = raw?.CNNO || raw?.cnno || raw?.ConsigneeCN || pickTracking(raw);
  if (!tracking) throw new Error(raw?.Response || raw?.message || 'Call Courier did not return a CN.');
  return { raw, trackingNumber: String(tracking) };
}

async function trackCallCourier(secrets, trackingNumber) {
  const response = await axios.get('https://cod.callcourier.com.pk/api/CallCourier/GetTackingHistory', {
    params: { cn: trackingNumber },
    timeout: 25000,
  });
  const raw = response.data;
  const list = Array.isArray(raw) ? raw : raw?.TrackingDetail || raw?.data || [];
  const last = Array.isArray(list) && list.length ? list[list.length - 1] : raw;
  return {
    raw,
    courierStatus: last?.ProcessDesc || last?.Status || last?.status || '',
  };
}

module.exports = { bookCallCourier, trackCallCourier };
