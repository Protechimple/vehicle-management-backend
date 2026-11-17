const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const env = require('./config/env');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

if (env.isProduction) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

app.use(helmet());
app.use(cors({ origin: env.clientUrls, credentials: true }));

app.use(express.json({ limit: '100kb' }));

// Simple status response for the bare domain (health checks, host previews).
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'VMMS API' });
});

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
