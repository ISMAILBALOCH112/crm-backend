const axios = require('axios');
const FormData = require('form-data');
const { getMediaDownloadUrl, downloadMedia } = require('./whatsapp');

async function transcribeAudioBuffer(apiKey, buffer, mimeType = 'audio/ogg') {
  const form = new FormData();
  form.append('file', buffer, { filename: 'voice.ogg', contentType: mimeType });
  form.append('model', 'whisper-1');

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
  });

  return response.data.text?.trim() || '';
}

async function buildUserContent(message, waConfig, apiKey) {
  const parts = [];

  if (message.type === 'text') {
    parts.push({ type: 'text', text: message.text?.body || '' });
    return parts;
  }

  if (message.type === 'image' && message.image?.id) {
    const caption = message.image?.caption?.trim();
    if (caption) parts.push({ type: 'text', text: caption });

    const mediaUrl = await getMediaDownloadUrl(message.image.id, waConfig.accessToken);
    const { buffer, mimeType } = await downloadMedia(mediaUrl, waConfig.accessToken);
    const base64 = buffer.toString('base64');
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64}` },
    });
    return parts;
  }

  if (message.type === 'audio' && message.audio?.id) {
    const mediaUrl = await getMediaDownloadUrl(message.audio.id, waConfig.accessToken);
    const { buffer, mimeType } = await downloadMedia(mediaUrl, waConfig.accessToken);
    const transcript = await transcribeAudioBuffer(apiKey, buffer, mimeType);
    parts.push({
      type: 'text',
      text: transcript ? `[Voice message]: ${transcript}` : '[Voice message received but could not be transcribed]',
    });
    return parts;
  }

  if (message.type === 'video' && message.video?.id) {
    const caption = message.video?.caption?.trim();
    parts.push({
      type: 'text',
      text: caption
        ? `[Video message with caption]: ${caption}`
        : '[Video message received — describe that you received their video and ask what they need help with]',
    });
    return parts;
  }

  parts.push({
    type: 'text',
    text: `[${message.type || 'message'} received] Please help the customer based on this message type.`,
  });
  return parts;
}

async function generateAiReply({ apiKey, model, systemPrompt, temperature, maxTokens, message, waConfig, history = [] }) {
  const userContent = await buildUserContent(message, waConfig, apiKey);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: userContent.length === 1 && userContent[0].type === 'text' ? userContent[0].text : userContent },
  ];

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: model || 'gpt-4o-mini',
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 500,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.choices?.[0]?.message?.content?.trim() || '';
}

module.exports = { generateAiReply, transcribeAudioBuffer };
