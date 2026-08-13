require('dotenv').config();
const express = require('express');
const webhookRouter = require('./webhook');
const sendRouter = require('./send');
const connectRouter = require('./connect');

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

app.get('/', (req, res) => res.send('CRM WhatsApp backend is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
