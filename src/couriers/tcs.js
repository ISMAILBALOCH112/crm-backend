const axios = require('axios');
const { toLocalPkPhone, piecesFromOrder, itemsText, pickTracking, codCollectAmount } = require('./util');

const AUTH_URL = 'https://ociconnect.tcscourier.com/auth/api/auth';
const ECOM_TOKEN_URL = 'https://ociconnect.tcscourier.com/ecom/api/authentication/token';
const BOOK_URL = 'https://ociconnect.tcscourier.com/ecom/api/booking/create';
const TRACK_URL = 'https://ociconnect.tcscourier.com/tracking/api/Tracking/GetDynamicTrackDetail';

async function getTcsBearer(secrets) {
  const clientId = secrets.tcsClientId;
  const clientSecret = secrets.tcsClientSecret;
  if (!clientId || !clientSecret) throw new Error('Add TCS client id and secret in courier settings.');
  const authRes = await axios.get(AUTH_URL, {
    params: { clientid: clientId, clientsecret: clientSecret },
    timeout: 25000,
  });
  const bearer = authRes.data?.result?.accessToken || authRes.data?.accessToken;
  if (!bearer) throw new Error('TCS authorization failed.');
  return bearer;
}

async function bookTcs(secrets, order) {
  const username = secrets.tcsUsername;
  const password = secrets.tcsPassword;
  const account = secrets.tcsAccount;
  if (!username || !password || !account) {
    throw new Error('Add TCS client id, secret, username, password and account in courier settings.');
  }

  const bearer = await getTcsBearer(secrets);

  const tokenRes = await axios.get(ECOM_TOKEN_URL, {
    headers: { Authorization: `Bearer ${bearer}` },
    params: { username, password },
    timeout: 25000,
  });
  const accessToken = tokenRes.data?.accesstoken || tokenRes.data?.accessToken;
  if (!accessToken) throw new Error('TCS authentication failed.');

  const names = String(order.customerName || 'Customer').trim().split(/\s+/);
  const firstname = names[0] || 'Customer';
  const lastname = names.slice(1).join(' ') || firstname;
  const phone = toLocalPkPhone(order.customerPhone);
  const shipperCity = secrets.tcsShipperCity || 'Karachi';

  const body = {
    accesstoken: accessToken,
    shipperinfo: {
      tcsaccount: account,
      shippername: secrets.tcsShipperName || 'Shipper',
      address1: secrets.tcsShipperAddress || 'Pakistan',
      countrycode: 'PK',
      countryname: 'Pakistan',
      cityname: shipperCity,
      mobile: secrets.tcsShipperPhone || '03000000000',
    },
    consigneeinfo: {
      firstname,
      middlename: firstname,
      lastname,
      address1: order.address || order.city,
      countrycode: 'PK',
      countryname: 'Pakistan',
      cityname: order.city,
      mobile: phone,
    },
    shipmentinfo: {
      costcentercode: account,
      referenceno: order.orderCode || order.id,
      pieces: piecesFromOrder(order),
      weight: 0.5,
      codamount: codCollectAmount(order),
      servicecode: 'O',
      productdetails: itemsText(order),
      fragile: 'No',
      remarks: order.notes || '',
    },
  };

  const booked = await axios.post(BOOK_URL, body, {
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    timeout: 25000,
  });
  const raw = booked.data;
  const tracking =
    raw?.result?.consignmentno ||
    raw?.result?.consignmentNo ||
    raw?.consignmentno ||
    pickTracking(raw);
  if (!tracking) {
    const msg = raw?.message || raw?.result?.message || 'TCS did not return a CN number.';
    throw new Error(typeof msg === 'string' ? msg : 'TCS booking failed.');
  }
  return { raw, trackingNumber: String(tracking) };
}

async function trackTcs(secrets, trackingNumber) {
  const bearer = await getTcsBearer(secrets);
  const response = await axios.post(
    TRACK_URL,
    { consignee: [String(trackingNumber)] },
    { headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  const raw = response.data;
  const delivery = Array.isArray(raw?.deliveryinfo) ? raw.deliveryinfo[0] : raw?.deliveryinfo;
  const summary = raw?.shipmentsummary || '';
  return {
    raw,
    courierStatus: delivery?.status || summary || raw?.message || '',
  };
}

module.exports = { bookTcs, trackTcs };
