const { db } = require('./firebase');
const {
  sendTextMessage,
  sendImageMessage,
  sendAudioMessage,
  sendVideoMessage,
} = require('./whatsapp');

function previewForResponse(item) {
  switch (item.type) {
    case 'text':
      return item.text || '';
    case 'image':
      return item.caption?.trim() || 'Photo';
    case 'audio':
      return 'Audio';
    case 'video':
      return item.caption?.trim() || 'Video';
    default:
      return 'Message';
  }
}

async function sendWhatsAppResponse(phoneNumberId, accessToken, to, item) {
  switch (item.type) {
    case 'text':
      return sendTextMessage(phoneNumberId, accessToken, to, item.text || '');
    case 'image':
      return sendImageMessage(phoneNumberId, accessToken, to, item.mediaUrl, item.caption);
    case 'audio':
      return sendAudioMessage(phoneNumberId, accessToken, to, item.mediaUrl, item.voice === true);
    case 'video':
      return sendVideoMessage(phoneNumberId, accessToken, to, item.mediaUrl, item.caption);
    default:
      throw new Error(`Unsupported response type: ${item.type}`);
  }
}

async function recordOutboundBotMessage(tenantId, to, item, waResult, source = 'bot') {
  const preview = previewForResponse(item);
  const contactRef = db.collection('tenants').doc(tenantId).collection('contacts').doc(to);

  await contactRef.set(
    {
      phone: to,
      lastMessageAt: new Date(),
      lastMessageDirection: 'outbound',
      lastMessageText: preview,
    },
    { merge: true }
  );

  await contactRef.collection('messages').add({
    direction: 'outbound',
    type: item.type,
    text: item.type === 'text' ? item.text || '' : item.caption || '',
    imageUrl: item.type === 'image' ? item.mediaUrl : null,
    mediaUrl: item.type === 'audio' || item.type === 'video' ? item.mediaUrl : null,
    waMessageId: waResult.messages?.[0]?.id,
    status: 'sent',
    timestamp: new Date(),
    source,
  });
}

async function sendBotResponses(tenantId, to, waConfig, responses, source = 'bot') {
  if (!responses?.length) return;

  for (const item of responses) {
    if (item.type === 'text' && !(item.text || '').trim()) continue;
    if (item.type !== 'text' && !item.mediaUrl) continue;

    const result = await sendWhatsAppResponse(waConfig.phoneNumberId, waConfig.accessToken, to, item);
    await recordOutboundBotMessage(tenantId, to, item, result, source);
  }
}

module.exports = { sendBotResponses, sendWhatsAppResponse, recordOutboundBotMessage, previewForResponse };
