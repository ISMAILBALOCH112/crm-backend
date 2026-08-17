require('dotenv').config();
const express = require('express');
const webhookRouter = require('./webhook');
const sendRouter = require('./send');
const connectRouter = require('./connect');
const botRoutes = require('./botRoutes');
const courierRoutes = require('./courierRoutes');
const waTemplatesRouter = require('./waTemplates');
const { startOrderConfirmScheduler } = require('./orderConfirmScheduler');
const { startCnSyncScheduler } = require('./cnSync');
const { router: broadcastRouter, startBroadcastScheduler } = require('./broadcast');
const { startAbandonedCartScheduler } = require('./abandonedCartScheduler');
const { router: billingRouter } = require('./billing');

const app = express();

// Keep the raw body around too — the webhook signature check is computed
// over the exact bytes Meta sent, not the re-serialized JSON.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use('/', webhookRouter);
app.use('/', sendRouter);
app.use('/', connectRouter);
app.use('/', botRoutes);
app.use('/', courierRoutes);
app.use('/', waTemplatesRouter);
app.use('/', broadcastRouter);
app.use('/', billingRouter);

app.get('/', (req, res) => res.send('CRM WhatsApp backend is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startOrderConfirmScheduler();
  startCnSyncScheduler();
  startBroadcastScheduler();
  startAbandonedCartScheduler();
});
