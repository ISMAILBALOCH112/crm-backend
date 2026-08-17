const COURIERS = [
  { id: 'PostEx', label: 'PostEx', fields: [{ key: 'postexToken', label: 'API token' }] },
  {
    id: 'Leopard',
    label: 'Leopard',
    fields: [
      { key: 'leopardApiKey', label: 'API key' },
      { key: 'leopardApiPassword', label: 'API password' },
      { key: 'leopardOriginCityId', label: 'Origin city id (or self)', optional: true },
    ],
  },
  {
    id: 'TCS',
    label: 'TCS',
    fields: [
      { key: 'tcsClientId', label: 'Client id' },
      { key: 'tcsClientSecret', label: 'Client secret' },
      { key: 'tcsUsername', label: 'Username' },
      { key: 'tcsPassword', label: 'Password' },
      { key: 'tcsAccount', label: 'TCS account' },
      { key: 'tcsShipperName', label: 'Shipper name' },
      { key: 'tcsShipperAddress', label: 'Shipper address' },
      { key: 'tcsShipperCity', label: 'Shipper city' },
      { key: 'tcsShipperPhone', label: 'Shipper phone 03xx', optional: true },
    ],
  },
  {
    id: 'Trax',
    label: 'Trax',
    fields: [
      { key: 'traxApiKey', label: 'API key' },
      { key: 'traxOriginCity', label: 'Origin city', optional: true },
    ],
  },
  {
    id: 'BlueEx',
    label: 'BlueEx',
    fields: [
      { key: 'blueexUsername', label: 'Username' },
      { key: 'blueexPassword', label: 'Password' },
      { key: 'blueexAccount', label: 'Account no' },
      { key: 'blueexOriginCity', label: 'Origin city code', optional: true },
    ],
  },
  {
    id: 'CallCourier',
    label: 'Call Courier',
    fields: [
      { key: 'callCourierLoginId', label: 'Login id' },
      { key: 'callCourierApiKey', label: 'API key' },
      { key: 'callCourierOrigin', label: 'Origin city', optional: true },
      { key: 'callCourierShipperName', label: 'Shipper name', optional: true },
    ],
  },
  { id: 'M&P', label: 'M&P', fields: [{ key: 'mpApiKey', label: 'API key' }] },
  { id: 'Rider', label: 'Rider', fields: [{ key: 'riderApiKey', label: 'API key' }] },
  { id: 'Daewoo', label: 'Daewoo FastEx', fields: [{ key: 'daewooApiKey', label: 'API key' }] },
];

function courierById(id) {
  return COURIERS.find((c) => c.id === id);
}

function isConfigured(courier, secrets = {}) {
  const required = (courier.fields || []).filter((f) => !f.optional);
  return required.every((f) => Boolean(String(secrets[f.key] || '').trim()));
}

module.exports = { COURIERS, courierById, isConfigured };
