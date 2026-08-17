const { db } = require('./firebase');

const DEFAULT_DAY = { open: '09:00', close: '18:00', closed: false };

const DEFAULT_CONFIG = {
  enabled: false,
  greeting: {
    enabled: false,
    responses: [{ type: 'text', text: 'Assalam o Alaikum! Thanks for messaging us. How can we help you today?' }],
  },
  away: {
    enabled: false,
    alwaysOn: false,
    message:
      'Shukriya message karne ka. Abhi hum available nahi — business hours mein jaldi reply karenge.',
  },
  businessHours: {
    enabled: false,
    timezone: 'Asia/Karachi',
    days: {
      mon: { ...DEFAULT_DAY },
      tue: { ...DEFAULT_DAY },
      wed: { ...DEFAULT_DAY },
      thu: { ...DEFAULT_DAY },
      fri: { ...DEFAULT_DAY },
      sat: { open: '10:00', close: '14:00', closed: false },
      sun: { open: '00:00', close: '00:00', closed: true },
    },
  },
  aiAgent: {
    enabled: false,
    provider: 'openai',
    model: 'gpt-4o-mini',
    systemPrompt:
      'You are a helpful WhatsApp sales assistant for {businessName}. Reply briefly in the same language the customer uses. Be polite and professional. If you cannot help, ask them to type "agent" to speak with a human.',
    temperature: 0.7,
    maxTokens: 500,
    handoffKeywords: ['human', 'agent', 'person', 'representative'],
  },
};

function mergeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    greeting: { ...DEFAULT_CONFIG.greeting, ...(raw.greeting || {}) },
    away: { ...DEFAULT_CONFIG.away, ...(raw.away || {}) },
    businessHours: {
      ...DEFAULT_CONFIG.businessHours,
      ...(raw.businessHours || {}),
      days: {
        ...DEFAULT_CONFIG.businessHours.days,
        ...((raw.businessHours && raw.businessHours.days) || {}),
      },
    },
    aiAgent: { ...DEFAULT_CONFIG.aiAgent, ...(raw.aiAgent || {}) },
  };
}

async function getBotConfig(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).collection('bot').doc('config').get();
  if (!snap.exists) return mergeConfig();
  return mergeConfig(snap.data());
}

async function getBotSecrets(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).collection('private').doc('bot').get();
  return snap.exists ? snap.data() : null;
}

async function hasBotApiKey(tenantId) {
  const secrets = await getBotSecrets(tenantId);
  return Boolean(secrets?.openaiApiKey);
}

module.exports = { DEFAULT_CONFIG, getBotConfig, getBotSecrets, hasBotApiKey, mergeConfig };
