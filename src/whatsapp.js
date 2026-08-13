const axios = require('axios');

const GRAPH_API_VERSION = 'v21.0';

function client(phoneNumberId, accessToken) {
  return axios.create({
    baseURL: `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}`,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function sendTextMessage(phoneNumberId, accessToken, to, body) {
  const response = await client(phoneNumberId, accessToken).post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
  return response.data;
}

// Called right when a tenant submits their credentials, so a typo'd Phone
// Number ID or a token from the wrong app fails immediately with a clear
// error instead of silently breaking the first real send/webhook later.
async function verifyCredentials(phoneNumberId, accessToken) {
  const response = await client(phoneNumberId, accessToken).get('', {
    params: { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status' },
  });
  return response.data;
}

module.exports = { sendTextMessage, verifyCredentials };
