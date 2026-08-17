const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');
const db = require('./firebase').db;
const {
  sendTextMessage,
  sendImageMessage,
  sendDocumentMessage,
  sendVideoMessage,
  sendAudioMessage,
  sendStickerMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  markMessageRead,
  sendReactionMessage,
  sendLocationMessage,
  sendContactsMessage,
} = require('./whatsapp');
const { getTenantWhatsappConfig } = require('./whatsappConfig');
const { requireTenantRole } = require('./auth');
const { assertTenantPlanActive } = require('./billing');

const router = express.Router();

function buildRetryPayload(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function reactionDocUpdate(emoji, { synced } = {}) {
  const removing = !emoji;
  const base = removing
    ? {
        localReaction: FieldValue.delete(),
        reaction: FieldValue.delete(),
        reactionBy: FieldValue.delete(),
        reactionAt: new Date(),
      }
    : {
        localReaction: emoji,
        reaction: emoji,
        reactionBy: 'business',
        reactionAt: new Date(),
      };
  if (synced !== undefined) base.reactionMetaSynced = synced;
  return base;
}

function normalizeWaTo(to) {
  return String(to || '').replace(/\D/g, '');
}

async function findMessageByWaId(tenantId, phone, waMessageId) {
  const digits = normalizeWaTo(phone);
  const candidates = [...new Set([phone, digits, `+${digits}`].filter(Boolean))];
  for (const id of candidates) {
    const snap = await db
      .collection('tenants')
      .doc(tenantId)
      .collection('contacts')
      .doc(id)
      .collection('messages')
      .where('waMessageId', '==', waMessageId)
      .limit(1)
      .get();
    if (!snap.empty) {
      return { ref: snap.docs[0].ref, data: snap.docs[0].data() || {}, contactId: id };
    }
  }
  // Last resort: collection-group (may need index; ignore failure).
  try {
    const snap = await db
      .collectionGroup('messages')
      .where('waMessageId', '==', waMessageId)
      .limit(1)
      .get();
    if (!snap.empty) {
      return { ref: snap.docs[0].ref, data: snap.docs[0].data() || {}, contactId: null };
    }
  } catch (_) {}
  return null;
}

async function resolveReplySnippet(contactRef, replyToMessageId) {
  if (!replyToMessageId) return { replyToWaMessageId: null, replyPreview: null };
  try {
    const snap = await contactRef
      .collection('messages')
      .where('waMessageId', '==', replyToMessageId)
      .limit(1)
      .get();
    if (snap.empty) {
      return { replyToWaMessageId: replyToMessageId, replyPreview: 'Message' };
    }
    const data = snap.docs[0].data() || {};
    const preview =
      (data.text && String(data.text).trim()) ||
      (data.type === 'image' ? 'Photo' : null) ||
      (data.type === 'video' ? 'Video' : null) ||
      (data.type === 'audio' ? 'Voice message' : null) ||
      (data.type === 'document' ? data.filename || 'Document' : null) ||
      (data.type === 'sticker' ? 'Sticker' : null) ||
      (data.type === 'gif' ? 'GIF' : null) ||
      'Message';
    return { replyToWaMessageId: replyToMessageId, replyPreview: String(preview).slice(0, 120) };
  } catch (_) {
    return { replyToWaMessageId: replyToMessageId, replyPreview: 'Message' };
  }
}

// POST payloads:
// { to, text } | { to, imageUrl, caption? } | ... | { to, template } | { to, reaction: { waMessageId, emoji } }
// | { to, interactiveButtons: { body, buttons, header?, footer? } }
router.post('/tenants/:tenantId/send', requireTenantRole('member'), async (req, res) => {
  const tenantId = req.params.tenantId;

  try {
    await assertTenantPlanActive(tenantId);
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message, code: err.code || 'PLAN_EXPIRED' });
  }
  const {
    to,
    text,
    imageUrl,
    caption,
    documentUrl,
    filename,
    videoUrl,
    gifUrl,
    stickerUrl,
    audioUrl,
    voice,
    durationMs,
    replyToMessageId,
    template,
    reaction,
    interactiveButtons,
    location,
    contacts,
  } = req.body;

  const hasReaction = reaction && reaction.waMessageId;
  const hasInteractive =
    interactiveButtons &&
    interactiveButtons.body &&
    Array.isArray(interactiveButtons.buttons) &&
    interactiveButtons.buttons.length > 0;
  const hasLocation =
    location &&
    location.latitude != null &&
    location.longitude != null &&
    Number.isFinite(Number(location.latitude)) &&
    Number.isFinite(Number(location.longitude));
  const hasContacts = Array.isArray(contacts) && contacts.length > 0;

  if (
    !to ||
    (!text &&
      !imageUrl &&
      !documentUrl &&
      !videoUrl &&
      !gifUrl &&
      !stickerUrl &&
      !audioUrl &&
      !template &&
      !hasReaction &&
      !hasInteractive &&
      !hasLocation &&
      !hasContacts)
  ) {
    return res.status(400).json({ error: 'Provide "to" plus a message payload.' });
  }

  const config = await getTenantWhatsappConfig(tenantId);
  if (!config) {
    return res.status(400).json({ error: 'This business has not connected a WhatsApp number yet.' });
  }

  try {
    // Reactions disabled — Meta returns undocumented error 1033 for this WABA.
    if (hasReaction) {
      return res.status(410).json({
        error: 'Reactions are disabled for this WhatsApp Business account (Meta error 1033).',
        code: 1033,
      });
    }

    let result;
    let type = 'text';
    let preview = text;
    let storedMediaUrl = null;
    let storedImageUrl = null;
    let storedDocumentUrl = null;
    let storedFilename = null;
    let templateName = null;
    let interactivePayload = null;
    let locationPayload = null;
    let contactsPayload = null;

    if (template && template.name) {
      result = await sendTemplateMessage(config.phoneNumberId, config.accessToken, to, {
        name: template.name,
        languageCode: template.languageCode || template.language || 'en_US',
        components: template.components,
      });
      type = 'template';
      templateName = template.name;
      preview = `Template: ${template.name}`;
    } else if (hasInteractive) {
      result = await sendInteractiveButtons(config.phoneNumberId, config.accessToken, to, {
        body: interactiveButtons.body,
        buttons: interactiveButtons.buttons,
        header: interactiveButtons.header,
        footer: interactiveButtons.footer,
      });
      type = 'interactive';
      preview = interactiveButtons.body;
      interactivePayload = {
        body: interactiveButtons.body,
        buttons: interactiveButtons.buttons,
        header: interactiveButtons.header || null,
        footer: interactiveButtons.footer || null,
      };
    } else if (hasLocation) {
      locationPayload = {
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        name: location.name || null,
        address: location.address || null,
      };
      result = await sendLocationMessage(config.phoneNumberId, config.accessToken, to, locationPayload);
      type = 'location';
      preview = locationPayload.name || locationPayload.address || 'Location';
    } else if (hasContacts) {
      contactsPayload = contacts;
      result = await sendContactsMessage(config.phoneNumberId, config.accessToken, to, contacts);
      type = 'contacts';
      const firstName = contacts[0]?.name?.formatted_name || contacts[0]?.name?.first_name;
      preview = firstName ? `Contact: ${firstName}` : 'Contact';
    } else if (documentUrl) {
      result = await sendDocumentMessage(
        config.phoneNumberId,
        config.accessToken,
        to,
        documentUrl,
        filename || 'invoice.pdf',
        caption
      );
      type = 'document';
      preview = caption?.trim() || filename || 'Document';
      storedDocumentUrl = documentUrl;
      storedFilename = filename || 'invoice.pdf';
    } else if (stickerUrl) {
      result = await sendStickerMessage(config.phoneNumberId, config.accessToken, to, stickerUrl);
      type = 'sticker';
      preview = 'Sticker';
      storedMediaUrl = stickerUrl;
    } else if (gifUrl) {
      result = await sendVideoMessage(config.phoneNumberId, config.accessToken, to, gifUrl, caption);
      type = 'gif';
      preview = caption?.trim() || 'GIF';
      storedMediaUrl = gifUrl;
    } else if (videoUrl) {
      result = await sendVideoMessage(config.phoneNumberId, config.accessToken, to, videoUrl, caption);
      type = 'video';
      preview = caption?.trim() || 'Video';
      storedMediaUrl = videoUrl;
    } else if (audioUrl) {
      result = await sendAudioMessage(config.phoneNumberId, config.accessToken, to, audioUrl, voice === true);
      type = 'audio';
      preview = 'Voice message';
      storedMediaUrl = audioUrl;
    } else if (imageUrl) {
      result = await sendImageMessage(config.phoneNumberId, config.accessToken, to, imageUrl, caption);
      type = 'image';
      preview = caption?.trim() || 'Photo';
      storedImageUrl = imageUrl;
    } else {
      result = await sendTextMessage(config.phoneNumberId, config.accessToken, to, text, replyToMessageId);
      type = 'text';
      preview = text;
    }

    res.json({ ok: true, result });

    const contactRef = db.collection('tenants').doc(tenantId).collection('contacts').doc(to);
    const persistOutbound = async () => {
      try {
        const replyMeta = await resolveReplySnippet(contactRef, replyToMessageId);
        await Promise.all([
          contactRef.set(
            { phone: to, lastMessageAt: new Date(), lastMessageDirection: 'outbound', lastMessageText: preview },
            { merge: true }
          ),
          contactRef.collection('messages').add({
            direction: 'outbound',
            type,
            text:
              type === 'text'
                ? text
                : type === 'template'
                  ? preview
                  : type === 'interactive'
                    ? preview
                    : type === 'location' || type === 'contacts'
                      ? preview
                      : caption || '',
            templateName,
            imageUrl: storedImageUrl,
            mediaUrl: storedMediaUrl,
            documentUrl: storedDocumentUrl,
            filename: storedFilename,
            interactive: interactivePayload,
            location: locationPayload,
            contacts: contactsPayload,
            durationMs: type === 'audio' && Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
            waMessageId: result.messages?.[0]?.id,
            status: 'sent',
            timestamp: new Date(),
            sentBy: req.uid || null,
            replyToWaMessageId: replyMeta.replyToWaMessageId,
            replyPreview: replyMeta.replyPreview,
            retryPayload: buildRetryPayload({
              to,
              text: text || undefined,
              imageUrl: imageUrl || undefined,
              caption: caption || undefined,
              documentUrl: documentUrl || undefined,
              filename: filename || undefined,
              videoUrl: videoUrl || undefined,
              gifUrl: gifUrl || undefined,
              stickerUrl: stickerUrl || undefined,
              audioUrl: audioUrl || undefined,
              voice: voice === true ? true : undefined,
              durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : undefined,
              template: template || undefined,
              interactiveButtons: hasInteractive ? interactiveButtons : undefined,
              location: hasLocation ? locationPayload : undefined,
              contacts: hasContacts ? contactsPayload : undefined,
              replyToMessageId: replyToMessageId || undefined,
            }),
          }),
        ]);
        try {
          const { scheduleAutoFollowUp } = require('./abandonedCartScheduler');
          await scheduleAutoFollowUp(tenantId, to, { reason: 'manual' });
        } catch (err) {
          console.warn('Auto follow-up schedule failed:', err.message);
        }
      } catch (err) {
        console.error('Persist outbound failed:', err.message);
      }
    };
    persistOutbound();
  } catch (err) {
    console.error('Error sending message:', err.response?.data || err.message);
    const meta = err.response?.data;
    const metaMsg = meta?.error?.message || meta?.error?.error_user_msg;
    res.status(500).json({ error: metaMsg || meta || err.message });
  }
});

/** Mark latest inbound WhatsApp message as read for this chat (Meta blue ticks). */
router.post('/tenants/:tenantId/chats/:phone/read', requireTenantRole('member'), async (req, res) => {
  const { tenantId, phone } = req.params;
  const config = await getTenantWhatsappConfig(tenantId);
  if (!config) {
    return res.status(400).json({ error: 'WhatsApp is not connected.' });
  }

  const contactRef = db.collection('tenants').doc(tenantId).collection('contacts').doc(phone);
  const snap = await contactRef.get();
  if (!snap.exists) {
    return res.json({ ok: true, marked: false });
  }

    try {
      // Avoid composite index: scan recent messages for latest inbound with wa id.
      const recent = await contactRef
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(40)
        .get();

      let markedId = null;
      for (const doc of recent.docs) {
        const data = doc.data() || {};
        if (data.direction !== 'inbound') continue;
        const waId = data.waMessageId;
        if (waId) {
          await markMessageRead(config.phoneNumberId, config.accessToken, waId);
          markedId = waId;
          break;
        }
      }

    await contactRef.set(
      {
        unreadCount: 0,
        lastReadAt: new Date(),
      },
      { merge: true }
    );

    res.json({ ok: true, marked: Boolean(markedId), messageId: markedId });
  } catch (err) {
    console.error('mark read failed:', err.response?.data || err.message);
    // Still clear local unread so the inbox stays usable.
    try {
      await contactRef.set({ unreadCount: 0, lastReadAt: new Date() }, { merge: true });
    } catch (_) {}
    const meta = err.response?.data;
    const metaMsg = meta?.error?.message || meta?.error?.error_user_msg;
    res.status(500).json({ error: metaMsg || err.message });
  }
});

module.exports = router;
