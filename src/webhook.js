const express = require('express');
const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./firebase');
const { getTenantWhatsappConfig } = require('./whatsappConfig');
const { getMediaDownloadUrl, downloadMedia } = require('./whatsapp');
const { uploadMediaBuffer, displayImageUrl } = require('./cloudinary');
const { processIncomingBot } = require('./bot');
const { handleOrderButtonReply } = require('./orderConfirm');
const { notifyTenantInbound } = require('./notify');

const router = express.Router();

router.get('/webhook/:tenantId', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const config = await getTenantWhatsappConfig(req.params.tenantId);
  if (mode === 'subscribe' && config && token === config.verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

function isValidSignature(req, appSecret) {
  const signature = req.get('x-hub-signature-256');
  if (!signature || !appSecret) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return signatureBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

router.post('/webhook/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  const config = await getTenantWhatsappConfig(tenantId);

  if (!config || !isValidSignature(req, config.appSecret)) {
    console.warn(`Webhook rejected for tenant ${tenantId}`);
    return res.sendStatus(401);
  }

  res.sendStatus(200);
  console.log(`Webhook received for tenant ${tenantId}`);

  try {
    await processWebhookPayload(tenantId, req.body);
  } catch (err) {
    console.error('Error processing webhook payload:', err);
  }
});

async function processWebhookPayload(tenantId, payload) {
  const entries = payload?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      const field = change?.field;
      const value = change?.value;
      if (!field || !value) continue;

      if (field === 'messages') {
        await recordIncomingMessages(tenantId, value);
        await recordStatusUpdates(tenantId, value);
      }
    }
  }
}

async function resolveInboundMedia(tenantId, message) {
  const config = await getTenantWhatsappConfig(tenantId);
  if (!config) return { imageUrl: null, mediaUrl: null };

  let mediaId = null;
  let mediaKind = null;

  if (message.type === 'image') {
    mediaId = message.image?.id;
    mediaKind = 'image';
  } else if (message.type === 'video') {
    mediaId = message.video?.id;
    mediaKind = 'video';
  } else if (message.type === 'audio') {
    mediaId = message.audio?.id;
    mediaKind = 'audio';
  } else if (message.type === 'document') {
    mediaId = message.document?.id;
    mediaKind = 'document';
  } else if (message.type === 'sticker') {
    mediaId = message.sticker?.id;
    mediaKind = 'sticker';
  }

  if (!mediaId) return { imageUrl: null, mediaUrl: null };

  try {
    const downloadUrl = await getMediaDownloadUrl(mediaId, config.accessToken);
    const { buffer, mimeType } = await downloadMedia(downloadUrl, config.accessToken);
    const uploadKind = mediaKind === 'sticker' ? 'image' : mediaKind;
    const url = await uploadMediaBuffer(buffer, mimeType, uploadKind);
    return {
      imageUrl: mediaKind === 'image' ? displayImageUrl(url) : null,
      mediaUrl: mediaKind !== 'image' ? url : null,
    };
  } catch (err) {
    console.error('Could not store inbound media:', err.message);
    return { imageUrl: null, mediaUrl: null };
  }
}

function previewForMessage(message, caption, referral) {
  if (message.type === 'reaction') return null;
  if (referral?.headline) return String(referral.headline).slice(0, 120);
  if (referral?.body && caption.trim()) return `${caption.trim().slice(0, 60)} · Ad`;
  if (referral?.body) return String(referral.body).slice(0, 120);
  if (referral?.sourceUrl) return 'Message from ad';
  if (message.type === 'image') return caption.trim() || 'Photo';
  if (message.type === 'video') return caption.trim() || 'Video';
  if (message.type === 'sticker') return 'Sticker';
  if (message.type === 'audio') return 'Voice message';
  if (message.type === 'document') return message.document?.filename || 'Document';
  if (message.type === 'location') {
    return message.location?.name || message.location?.address || 'Location';
  }
  if (message.type === 'contacts') {
    const n = message.contacts?.[0]?.name?.formatted_name || message.contacts?.[0]?.name?.first_name;
    return n ? `Contact: ${n}` : 'Contact';
  }
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title || caption || 'Button';
  }
  return caption;
}

function normalizeReferral(message) {
  const r = message.referral;
  if (!r || typeof r !== 'object') return null;

  const sourceUrl = r.source_url || null;
  const headline = r.headline || null;
  const body = r.body || null;
  const imageUrl = r.image_url || null;
  const videoUrl = r.video_url || null;
  const thumbnailUrl = r.thumbnail_url || null;

  if (!sourceUrl && !headline && !body && !imageUrl && !videoUrl && !thumbnailUrl) {
    return null;
  }

  return {
    sourceUrl,
    sourceId: r.source_id || null,
    sourceType: r.source_type || null,
    headline,
    body,
    mediaType: r.media_type || null,
    imageUrl,
    videoUrl,
    thumbnailUrl,
    ctwaClid: r.ctwa_clid || null,
  };
}

async function applyInboundReaction(tenantId, from, message) {
  const waTargetId = message.reaction?.message_id;
  if (!waTargetId) return;
  const emoji = message.reaction?.emoji || '';
  const messagesRef = db
    .collection('tenants')
    .doc(tenantId)
    .collection('contacts')
    .doc(from)
    .collection('messages');
  const snap = await messagesRef.where('waMessageId', '==', waTargetId).limit(1).get();
  if (snap.empty) return;
  await snap.docs[0].ref.set(
    {
      customerReaction: emoji || null,
      localReaction: emoji || null,
      reaction: emoji || null,
      reactionBy: 'customer',
      reactionAt: new Date(),
    },
    { merge: true }
  );
}

async function resolveInboundReply(contactRef, message) {
  const contextId = message.context?.id || message.context?.message_id;
  if (!contextId) return { replyToWaMessageId: null, replyPreview: null };
  try {
    const snap = await contactRef.collection('messages').where('waMessageId', '==', contextId).limit(1).get();
    if (snap.empty) {
      return { replyToWaMessageId: contextId, replyPreview: 'Message' };
    }
    const data = snap.docs[0].data() || {};
    const preview =
      (data.text && String(data.text).trim()) ||
      (data.type === 'image' ? 'Photo' : null) ||
      (data.type === 'video' ? 'Video' : null) ||
      (data.type === 'audio' ? 'Voice message' : null) ||
      (data.filename || null) ||
      'Message';
    return { replyToWaMessageId: contextId, replyPreview: String(preview).slice(0, 120) };
  } catch (_) {
    return { replyToWaMessageId: contextId, replyPreview: 'Message' };
  }
}

async function recordIncomingMessages(tenantId, value) {
  const messages = value?.messages;
  if (!messages) return;

  const contact = value.contacts?.[0];
  const tenantSnap = await db.collection('tenants').doc(tenantId).get();
  const businessName = tenantSnap.data()?.businessName || 'Your Business';

  for (const message of messages) {
    const from = message.from;
    const contactRef = db.collection('tenants').doc(tenantId).collection('contacts').doc(from);

    if (message.type === 'reaction') {
      try {
        await applyInboundReaction(tenantId, from, message);
      } catch (err) {
        console.error('Reaction handling failed:', err.message);
      }
      continue;
    }

    const caption =
      message.text?.body ||
      message.image?.caption ||
      message.video?.caption ||
      message.document?.caption ||
      message.interactive?.button_reply?.title ||
      '';
    const referral = normalizeReferral(message);
    const { imageUrl, mediaUrl } = await resolveInboundMedia(tenantId, message);
    const preview = previewForMessage(message, caption, referral);
    const replyMeta = await resolveInboundReply(contactRef, message);

    await contactRef.set(
      {
        phone: from,
        name: contact?.profile?.name || from,
        lastMessageAt: new Date(),
        lastMessageDirection: 'inbound',
        lastMessageText: preview,
        lastCustomerMessageAt: new Date(),
        unreadCount: FieldValue.increment(1),
      },
      { merge: true }
    );

    try {
      const { cancelAutoFollowUp } = require('./abandonedCartScheduler');
      await cancelAutoFollowUp(tenantId, from, 'replied');
    } catch (_) {}

    await contactRef.collection('messages').add({
      direction: 'inbound',
      text: caption,
      type: message.type || 'text',
      imageUrl,
      mediaUrl,
      documentUrl: message.type === 'document' ? mediaUrl : null,
      filename: message.document?.filename || null,
      referral: referral || null,
      location:
        message.type === 'location'
          ? {
              latitude: message.location?.latitude ?? null,
              longitude: message.location?.longitude ?? null,
              name: message.location?.name || null,
              address: message.location?.address || null,
            }
          : null,
      contacts: message.type === 'contacts' ? message.contacts || null : null,
      waMessageId: message.id,
      status: 'delivered',
      timestamp: new Date(Number(message.timestamp) * 1000),
      replyToWaMessageId: replyMeta.replyToWaMessageId,
      replyPreview: replyMeta.replyPreview,
    });

    try {
      await notifyTenantInbound(tenantId, {
        from,
        preview,
        contactName: contact?.profile?.name || from,
      });
    } catch (err) {
      console.error('Inbound push notify failed:', err.message);
    }

    try {
      const handledButton = await handleOrderButtonReply(tenantId, from, message);
      if (handledButton) continue;
    } catch (err) {
      console.error('Order button handling failed:', err.message);
    }

    try {
      await processIncomingBot(
        tenantId,
        from,
        message,
        contact?.profile?.name || from,
        businessName
      );
    } catch (err) {
      console.error('Bot processing failed:', err.message);
    }
  }
}

async function recordStatusUpdates(tenantId, value) {
  const statuses = value?.statuses;
  if (!statuses) return;

  for (const status of statuses) {
    const recipientId = status.recipient_id;
    if (!recipientId) continue;

    const messagesRef = db
      .collection('tenants')
      .doc(tenantId)
      .collection('contacts')
      .doc(recipientId)
      .collection('messages');

    const snap = await messagesRef.where('waMessageId', '==', status.id).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({
        status: status.status,
        ...(status.status === 'failed' && status.errors ? { sendError: status.errors } : {}),
      });
    }

    if (status.status === 'read') {
      try {
        const { markFollowUpSeen } = require('./abandonedCartScheduler');
        await markFollowUpSeen(tenantId, recipientId);
      } catch (_) {}
    }
  }
}

module.exports = router;
