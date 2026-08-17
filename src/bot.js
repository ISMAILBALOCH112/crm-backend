const { db } = require('./firebase');
const { getBotConfig, getBotSecrets } = require('./botConfig');
const { getTenantWhatsappConfig } = require('./whatsappConfig');
const { sendBotResponses } = require('./messageSender');
const { generateAiReply } = require('./aiAgent');
const { sendTextMessage } = require('./whatsapp');
const { recordOutboundBotMessage } = require('./messageSender');
const { shouldSendAway, localYmd } = require('./businessHours');
const {
  loadActiveProducts,
  formatCatalogForPrompt,
  formatCatalogListMessage,
  wantsCatalogList,
} = require('./botCatalog');

function botStateRef(tenantId, phone) {
  return db.collection('tenants').doc(tenantId).collection('contacts').doc(phone).collection('meta').doc('botState');
}

function messageText(message) {
  return (message.text?.body || message.image?.caption || message.video?.caption || '').trim();
}

function wantsHandoff(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (keywords || []).some((k) => lower.includes(String(k).toLowerCase()));
}

async function processIncomingBot(tenantId, from, message, contactName, businessName) {
  const config = await getBotConfig(tenantId);
  const awayOn = config.away?.enabled === true;
  const botOn = config.enabled === true;
  if (!botOn && !awayOn) return;

  const stateRef = botStateRef(tenantId, from);
  const stateSnap = await stateRef.get();
  const state = stateSnap.data() || {};

  if (state.humanHandoff) return;
  if (message.type === 'interactive') return;

  const text = messageText(message);
  const handoffKeywords = config.aiAgent?.handoffKeywords || ['human', 'agent'];
  if (botOn && wantsHandoff(text, handoffKeywords)) {
    await stateRef.set({ humanHandoff: true, handoffAt: new Date() }, { merge: true });
    return;
  }

  const waConfig = await getTenantWhatsappConfig(tenantId);
  if (!waConfig) return;

  // Away / after-hours — works even if master bot switch is off.
  if (shouldSendAway(config, state)) {
    const msg = String(config.away.message || '').trim();
    const result = await sendTextMessage(waConfig.phoneNumberId, waConfig.accessToken, from, msg);
    await recordOutboundBotMessage(tenantId, from, { type: 'text', text: msg }, result, 'bot_away');
    const tz = config.businessHours?.timezone || 'Asia/Karachi';
    await stateRef.set(
      {
        awaySentYmd: localYmd(tz),
        awaySentAt: new Date(),
        greetingSent: state.greetingSent || true,
        greetingSentAt: state.greetingSentAt || new Date(),
      },
      { merge: true }
    );
    return;
  }

  if (!botOn) return;

  const isFirstMessage = !state.greetingSent;

  if (isFirstMessage && config.greeting?.enabled) {
    await sendBotResponses(tenantId, from, waConfig, config.greeting.responses || [], 'bot_greeting');
    await stateRef.set({ greetingSent: true, greetingSentAt: new Date() }, { merge: true });
    return;
  }

  // Fast path: catalog / price keywords → send product list (skip AI).
  if (wantsCatalogList(text)) {
    try {
      const products = await loadActiveProducts(tenantId);
      const listText = formatCatalogListMessage(products, businessName);
      const result = await sendTextMessage(waConfig.phoneNumberId, waConfig.accessToken, from, listText);
      await recordOutboundBotMessage(tenantId, from, { type: 'text', text: listText }, result, 'bot_catalog');

      try {
        const { scheduleAutoFollowUp } = require('./abandonedCartScheduler');
        await scheduleAutoFollowUp(tenantId, from, { reason: 'catalog' });
      } catch (err) {
        console.warn('Abandoned cart schedule failed:', err.message);
        await stateRef.set({ lastCatalogReplyAt: new Date() }, { merge: true });
      }
    } catch (err) {
      console.error(`Catalog reply failed for tenant ${tenantId}:`, err.response?.data || err.message);
    }
    return;
  }

  if (config.aiAgent?.enabled) {
    const secrets = await getBotSecrets(tenantId);
    const apiKey = secrets?.openaiApiKey;
    if (!apiKey) {
      console.warn(`AI agent enabled but no API key for tenant ${tenantId}`);
      return;
    }

    let systemPrompt = (config.aiAgent.systemPrompt || '')
      .replaceAll('{businessName}', businessName || 'our business')
      .replaceAll('{customerName}', contactName || 'customer');

    try {
      const products = await loadActiveProducts(tenantId);
      systemPrompt += formatCatalogForPrompt(products);

      const reply = await generateAiReply({
        apiKey,
        model: config.aiAgent.model,
        systemPrompt,
        temperature: config.aiAgent.temperature,
        maxTokens: config.aiAgent.maxTokens,
        message,
        waConfig,
      });

      if (!reply) return;

      const result = await sendTextMessage(waConfig.phoneNumberId, waConfig.accessToken, from, reply);
      await recordOutboundBotMessage(
        tenantId,
        from,
        { type: 'text', text: reply },
        result,
        'bot_ai'
      );

      await stateRef.set({ lastAiReplyAt: new Date() }, { merge: true });
    } catch (err) {
      console.error(`AI reply failed for tenant ${tenantId}:`, err.response?.data || err.message);
    }
  }
}

module.exports = { processIncomingBot };
