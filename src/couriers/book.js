const { createPostexOrder } = require('../postex');
const { bookLeopard } = require('./leopard');
const { bookTcs } = require('./tcs');
const { bookTrax } = require('./trax');
const { bookBlueEx } = require('./blueex');
const { bookCallCourier } = require('./callCourier');
const { isConfigured, courierById } = require('./catalog');

async function bookWithCourier(courierId, secrets, order) {
  const courier = courierById(courierId);
  if (!courier) throw new Error(`Unknown courier: ${courierId}`);
  if (!isConfigured(courier, secrets)) {
    throw new Error(`${courier.label} is not connected. Add API details in courier settings.`);
  }

  switch (courierId) {
    case 'PostEx':
      return createPostexOrder(secrets.postexToken, order);
    case 'Leopard':
      return bookLeopard(secrets, order);
    case 'TCS':
      return bookTcs(secrets, order);
    case 'Trax':
      return bookTrax(secrets, order);
    case 'BlueEx':
      return bookBlueEx(secrets, order);
    case 'CallCourier':
      return bookCallCourier(secrets, order);
    case 'M&P':
    case 'Rider':
    case 'Daewoo':
      throw new Error(`${courier.label} API booking is saved, but live booking is not enabled yet. Use Manual tracking or pick PostEx / Leopard / TCS / Trax / BlueEx / Call Courier.`);
    default:
      throw new Error(`Booking is not supported for ${courierId}.`);
  }
}

module.exports = { bookWithCourier };
