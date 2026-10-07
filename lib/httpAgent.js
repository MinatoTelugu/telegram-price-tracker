/**
 * lib/httpAgent.js
 * ---------------------------------------------------------------------------
 * Shared keep-alive HTTP agents.
 *
 * By default Node opens a fresh TCP + TLS connection for every request, which
 * costs a full handshake each time — very noticeable when a single user action
 * makes several calls (convert → scrape → resolve). Reusing connections removes
 * that cost from all but the first request to each host.
 * ---------------------------------------------------------------------------
 */

const http = require('http');
const https = require('https');
const axios = require('axios');

const KEEP_ALIVE_MSECS = 20000;

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_MSECS,
  maxSockets: 32,
  maxFreeSockets: 16,
  scheduling: 'lifo',
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_MSECS,
  maxSockets: 32,
  maxFreeSockets: 16,
  scheduling: 'lifo',
});

/** Spread into any axios request config: { ...AGENT }. */
const AGENT = { httpAgent, httpsAgent };

// Apply globally so EVERY axios call in the app reuses connections. Requiring
// this module once is enough; the assignment is idempotent.
// Guarded: a test harness may supply a minimal axios stub without `defaults`.
if (axios && axios.defaults) {
  axios.defaults.httpsAgent = httpsAgent;
  axios.defaults.httpAgent = httpAgent;
}

module.exports = { httpAgent, httpsAgent, AGENT };
