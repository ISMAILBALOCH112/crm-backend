const axios = require('axios');

const GRAPH_API_VERSION = 'v22.0';

function client(phoneNumberId, accessToken) {
  return axios.create({
    baseURL: `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}`,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function sendTextMessage(phoneNumberId, accessToken, to, body, replyToMessageId) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  };
  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }
  const response = await client(phoneNumberId, accessToken).post('/messages', payload);
  return response.data;
}

/** Mark an inbound customer message as read (gives them blue ticks). */
async function markMessageRead(phoneNumberId, accessToken, messageId) {
  const response = await client(phoneNumberId, accessToken).post('/messages', {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  });
  return response.data;
}

/** React to a WhatsApp message (emoji). Empty emoji removes the reaction. */
async function sendReactionMessage(phoneNumberId, accessToken, to, waMessageId, emoji) {
  const digits = String(to || '').replace(/\D/g, '');
  const bare = digits.startsWith('00') ? digits.slice(2) : digits;
  // Meta reaction docs use E.164 with leading + (e.g. +16505551234).
  const toE164 = bare.startsWith('+') ? bare : `+${bare}`;
  const reaction = { message_id: String(waMessageId || '').trim() };
  if (emoji && String(emoji).trim()) {
    reaction.emoji = String(emoji).trim();
  } else {
    reaction.emoji = '';
  }
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toE164,
    type: 'reaction',
    reaction,
  };
  console.log('Reaction Meta request:', JSON.stringify({ to: payload.to, message_id: reaction.message_id, emoji: reaction.emoji }));
  const response = await client(phoneNumberId, accessToken).post('/messages', payload);
  return response.data;
}

async function sendImageMessage(phoneNumberId, accessToken, to, imageUrl, caption) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link: imageUrl },
  };
  if (caption) payload.image.caption = caption;

  const response = await client(phoneNumberId, accessToken).post('/messages', payload);
  return response.data;
}

async function sendVideoMessage(phoneNumberId, accessToken, to, videoUrl, caption) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'video',
    video: { link: videoUrl },
  };
  if (caption) payload.video.caption = caption;

  const response = await client(phoneNumberId, accessToken).post('/messages', payload);
  return response.data;
}

async function uploadMediaBuffer(phoneNumberId, accessToken, buffer, mimeType, filename) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', buffer, { filename, contentType: mimeType });

  const response = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`,
    form,
    { headers: { Authorization: `Bearer ${accessToken}`, ...form.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity }
  );
  return response.data.id;
}

async function sendAudioMessage(phoneNumberId, accessToken, to, audioUrl, voice = false) {
  // Download hosted file, then upload to Meta — link-based audio often fails (wrong mime / remuxed mp4).
  const fileRes = await axios.get(audioUrl, { responseType: 'arraybuffer', maxContentLength: Infinity });
  const buffer = Buffer.from(fileRes.data);
  const headerType = String(fileRes.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const looksLikeOgg = /\.ogg(\?|$)/i.test(audioUrl) || headerType.includes('ogg') || headerType.includes('opus');
  const looksLikeM4a =
    /\.m4a(\?|$)/i.test(audioUrl) || headerType === 'audio/mp4' || headerType === 'audio/aac' || /\.mp4(\?|$)/i.test(audioUrl);

  let mimeType = 'audio/mpeg';
  let filename = 'voice.mp3';
  if (looksLikeOgg) {
    mimeType = 'audio/ogg';
    filename = 'voice.ogg';
  } else if (looksLikeM4a) {
    mimeType = 'audio/mp4';
    filename = 'voice.m4a';
  } else if (headerType.startsWith('audio/')) {
    mimeType = headerType;
    filename = 'voice';
  }

  // PTT voice notes require OGG/OPUS only.
  const asVoice = voice === true && looksLikeOgg;
  const mediaId = await uploadMediaBuffer(phoneNumberId, accessToken, buffer, mimeType, filename);

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: { id: mediaId },
  };
  if (asVoice) payload.audio.voice = true;

  const response = await client(phoneNumberId, accessToken).post('/messages', payload);
  return response.data;
}

async function sendInteractiveButtons(phoneNumberId, accessToken, to, { header, body, footer, buttons }) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };
  if (header) payload.interactive.header = { type: 'text', text: header };
  if (footer) payload.interactive.footer = { text: footer };

  const response = await client(phoneNumberId, accessToken).post('/messages', payload);
  return response.data;
}

async function sendDocumentMessage(phoneNumberId, accessToken, to, documentUrl, filename, caption) {
  const document = { link: documentUrl };
  if (filename) document.filename = filename;
  if (caption) document.caption = caption;
  const response = await client(phoneNumberId, accessToken).post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document,
  });
  return response.data;
}

/// WhatsApp stickers must be WebP. Download + upload by media id (link often fails).
async function sendStickerMessage(phoneNumberId, accessToken, to, stickerUrl) {
  const fileRes = await axios.get(stickerUrl, {
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
  });
  const buffer = Buffer.from(fileRes.data);
  const headerType = String(fileRes.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const mimeType = headerType === 'image/webp' || /\.webp(\?|$)/i.test(stickerUrl) ? 'image/webp' : 'image/webp';
  const mediaId = await uploadMediaBuffer(phoneNumberId, accessToken, buffer, mimeType, 'sticker.webp');

  const response = await client(phoneNumberId, accessToken).post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'sticker',
    sticker: { id: mediaId },
  });
  return response.data;
}

async function sendLocationMessage(phoneNumberId, accessToken, to, { latitude, longitude, name, address }) {
  const location = {
    latitude: Number(latitude),
    longitude: Number(longitude),
  };
  if (name) location.name = String(name);
  if (address) location.address = String(address);
  const response = await client(phoneNumberId, accessToken).post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'location',
    location,
  });
  return response.data;
}

async function sendContactsMessage(phoneNumberId, accessToken, to, contacts) {
  const response = await client(phoneNumberId, accessToken).post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'contacts',
    contacts,
  });
  return response.data;
}

async function getMediaDownloadUrl(mediaId, accessToken) {
  const response = await axios.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data.url;
}

async function downloadMedia(url, accessToken) {
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer',
  });
  return { buffer: Buffer.from(response.data), mimeType: response.headers['content-type'] || 'image/jpeg' };
}

async function sendTemplateMessage(phoneNumberId, accessToken, to, { name, languageCode, components }) {
  const template = {
    name,
    language: { code: languageCode || 'en_US' },
  };
  if (Array.isArray(components) && components.length > 0) {
    template.components = components;
  }
  const response = await client(phoneNumberId, accessToken).post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template,
  });
  return response.data;
}

async function resolveWabaId(phoneNumberId, accessToken) {
  try {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { fields: 'whatsapp_business_account{id,name}' },
    });
    const id = response.data?.whatsapp_business_account?.id;
    if (id) return String(id);
  } catch (_) {
    // fall through
  }
  try {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/debug_token`, {
      params: { input_token: accessToken, access_token: accessToken },
    });
    const ids = response.data?.data?.granular_scopes || [];
    for (const scope of ids) {
      if (!Array.isArray(scope.target_ids)) continue;
      for (const targetId of scope.target_ids) {
        if (targetId && String(targetId) !== String(phoneNumberId)) {
          return String(targetId);
        }
      }
    }
  } catch (_) {
    // ignore
  }
  return null;
}

async function listMessageTemplates(wabaId, accessToken, { status = 'APPROVED' } = {}) {
  const response = await axios.get(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        fields: 'name,language,status,category,components',
        limit: 100,
        ...(status ? { status } : {}),
      },
    }
  );
  return response.data?.data || [];
}

async function verifyCredentials(phoneNumberId, accessToken) {
  const response = await client(phoneNumberId, accessToken).get('', {
    params: { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status' },
  });
  return response.data;
}

module.exports = {
  sendTextMessage,
  sendImageMessage,
  sendAudioMessage,
  sendVideoMessage,
  sendStickerMessage,
  sendInteractiveButtons,
  sendDocumentMessage,
  sendTemplateMessage,
  sendLocationMessage,
  sendContactsMessage,
  markMessageRead,
  sendReactionMessage,
  listMessageTemplates,
  resolveWabaId,
  getMediaDownloadUrl,
  downloadMedia,
  verifyCredentials,
  GRAPH_API_VERSION,
};
