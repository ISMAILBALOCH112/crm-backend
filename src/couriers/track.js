const { trackPostex } = require('../postex');
const { trackLeopard } = require('./leopard');
const { trackTcs } = require('./tcs');
const { trackTrax } = require('./trax');
const { trackBlueEx } = require('./blueex');
const { trackCallCourier } = require('./callCourier');
const { courierById, isConfigured } = require('./catalog');
const { mapCourierStatus } = require('./statusMap');

async function trackWithCourier(courierId, secrets, trackingNumber) {
  const courier = courierById(courierId);
  if (!courier) throw new Error(`Unknown courier: ${courierId}`);
  if (!isConfigured(courier, secrets)) {
    throw new Error(`${courier.label} is not connected. Add API details in courier settings.`);
  }
  if (!trackingNumber) throw new Error('Tracking number is required.');

  let result;
  switch (courierId) {
    case 'PostEx':
      result = await trackPostex(secrets.postexToken, trackingNumber);
      break;
    case 'Leopard':
      result = await trackLeopard(secrets, trackingNumber);
      break;
    case 'TCS':
      result = await trackTcs(secrets, trackingNumber);
      break;
    case 'Trax':
      result = await trackTrax(secrets, trackingNumber);
      break;
    case 'BlueEx':
      result = await trackBlueEx(secrets, trackingNumber);
      break;
    case 'CallCourier':
      result = await trackCallCourier(secrets, trackingNumber);
      break;
    default:
      throw new Error(`${courier.label} tracking is not enabled yet.`);
  }

  const mapped = mapCourierStatus(result.courierStatus, result.code || '');
  return {
    raw: result.raw,
    courierStatus: mapped.courierStatus,
    mappedStatus: mapped.mappedStatus,
  };
}

module.exports = { trackWithCourier };
