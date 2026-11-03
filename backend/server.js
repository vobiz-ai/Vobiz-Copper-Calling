/**
 * Vobiz calling for Copper CRM: one backend serving the softphone page, the
 * Copper panel (an embedded app in Copper's action bar), the Vobiz webhooks
 * and the Copper writer.
 *
 * Run exactly one instance: sessions, SIP routing and Vobiz Auth Tokens live in
 * memory, and a restart means agents sign in again.
 *
 * Design and rationale: docs/architecture.md.
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const config = require('./src/config');
const store = require('./src/store');
const logger = require('./src/call-logger');
const vobizRoutes = require('./src/routes-vobiz');
const phone = require('./src/routes-phone');
const { sweep } = require('./src/state');
const { log } = require('./src/util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const app = express();
app.disable('x-powered-by');
// Behind a tunnel or proxy, PUBLIC_BASE_URL (not the Host header) is the only
// source of public URLs, so no trust proxy setting is needed.

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  // Only the Copper panel may be framed, and only by Copper (its CSP says so).
  if (req.path !== '/copper') res.set('X-Frame-Options', 'DENY');
  if (config.PUBLIC_BASE_URL.startsWith('https://')) res.set('Strict-Transport-Security', 'max-age=31536000');
  // No CORS. Every browser request comes from pages this server serves (the
  // Copper panel is framed, but it is this origin's page), so none is
  // cross-origin. Never "*", never a reflected origin.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/vobiz', vobizRoutes.router);
app.use('/recordings', vobizRoutes.recordings);
app.use('/copper/oauth', phone.oauth);
app.use('/api/panel', phone.panel);
app.use('/api', phone.api);

const csp = (connect, frameAncestors = "'none'") => [
  "default-src 'self'",
  "script-src 'self'",
  // Satoshi, from the same font CDN the Zendesk, ClickUp and Help Scout panels use.
  "style-src 'self' https://fonts.cdnfonts.com",
  'font-src https://fonts.cdnfonts.com',
  `connect-src ${connect}`,
  "media-src 'self' blob:",
  "img-src 'self' data:",
  `frame-ancestors ${frameAncestors}`,
  "form-action 'self'",
].join('; ');

app.get('/phone', (req, res) => {
  res.set({ 'Content-Security-Policy': csp(`'self' wss://${config.VOBIZ_REGISTRAR}:5063`), 'Cache-Control': 'no-store', 'Permissions-Policy': 'microphone=(self)' });
  res.sendFile(path.join(PUBLIC_DIR, 'phone.html'));
});
// The Copper panel: Copper frames it in the action bar (and any record
// sidebar it is added to). It never holds a call; it sends clicked numbers to
// the agent's softphone tab.
app.get('/copper', (req, res) => {
  res.set({ 'Content-Security-Policy': csp("'self'", config.COPPER_FRAME_ORIGINS.join(' ') || "'none'"), 'Cache-Control': 'no-store' });
  res.sendFile(path.join(PUBLIC_DIR, 'copper.html'));
});
// Copper's {"verifyServer": true} option POSTs to the app URL first; answer
// with the page so the option does not break the panel.
app.post('/copper', (req, res) => res.redirect(303, req.originalUrl));
app.get('/copper/config', (req, res) => res.json({ origins: config.COPPER_FRAME_ORIGINS }));
// The popup the Copper panel opens to link itself to the softphone tab.
app.get('/pair', (req, res) => {
  res.set({ 'Content-Security-Policy': csp("'self'"), 'Cache-Control': 'no-store' });
  res.sendFile(path.join(PUBLIC_DIR, 'pair.html'));
});
// The browser's tel: handler. It only hands the number to an open softphone
// tab of this origin; it never dials by itself.
app.get('/dial', (req, res) => {
  res.set({ 'Content-Security-Policy': csp("'self'"), 'Cache-Control': 'no-store' });
  res.sendFile(path.join(PUBLIC_DIR, 'dial.html'));
});
// express.static refuses dotfiles and never leaves its root.
app.use('/static', express.static(PUBLIC_DIR, { dotfiles: 'deny', index: false, redirect: false }));
app.get('/', (req, res) => res.redirect(302, '/phone'));
app.get('/health', (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log(`x ${req.method} ${req.path}: ${err.message}`);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  res.status(500).json({ error: 'Internal error' });
});

if (require.main === module) {
  store.load();
  const sweeper = setInterval(sweep, 60 * 1000);
  const retrier = setInterval(() => logger.retryPending().catch(err => log(`x retry: ${err.message}`)), 60 * 1000);
  sweeper.unref(); retrier.unref();
  app.listen(config.PORT, () => {
    const oauthApp = !!(config.COPPER_CLIENT_ID && config.COPPER_CLIENT_SECRET);
    console.log(`Vobiz Copper calling backend on http://localhost:${config.PORT}`);
    console.log(`  public base  ${config.PUBLIC_BASE_URL || '(NOT SET: Vobiz cannot reach /vobiz/answer, sign-in will refuse)'}`);
    console.log(`  softphone    ${config.PUBLIC_BASE_URL || ''}/phone`);
    console.log(`  copper panel ${config.PUBLIC_BASE_URL || ''}/copper   (framed by ${config.COPPER_FRAME_ORIGINS.join(', ') || 'nobody'})`);
    console.log(`  data dir     ${config.DATA_DIR}`);
    console.log(`  copper       ${oauthApp ? 'OAuth app' : 'no OAuth app'}${config.COPPER_ALLOW_API_KEYS || !oauthApp ? ', API keys allowed' : ''}`);
    console.log(`  sip auth     ${config.VOBIZ_SIP_AUTH}${config.VOBIZ_SIP_AUTH === 'jwt' ? ` (access tokens, ${config.VOBIZ_JWT_TTL_SECONDS}s)` : ' (one endpoint per agent)'}`);
    console.log(`  signatures   vobiz=${config.VOBIZ_WEBHOOK_SIGNATURES}`);
    if (config.SIGNING_SECRET_IS_EPHEMERAL) console.log('  ! SIGNING_SECRET is not set: recording links and stored Copper credentials stop working after a restart');
  });
}

module.exports = { app };
