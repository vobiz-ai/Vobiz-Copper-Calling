/* The Vobiz panel inside Copper (an embedded app; see copper.html).
 *
 * The Copper SDK takes the parent window's origin from the ?origin= query
 * parameter and trusts it, so the panel checks it against the origins this
 * server allows (COPPER_FRAME_ORIGINS) before it starts the SDK. The page's
 * CSP frame-ancestors says the same thing to the browser.
 *
 * The panel talks to the backend with a panel link token, kept in this
 * frame's own storage (the browser keeps it apart from the softphone tab's).
 * It gets one from the /pair popup, which asks the agent's signed-in
 * softphone tab for it. The token can look numbers up and send a number to
 * this agent's softphone; nothing else.
 */
(function () {
  'use strict';

  var LINK_KEY = 'vz_cp_panel';
  var $ = function (id) { return document.getElementById(id); };
  function show(id, on) { $(id).hidden = !on; }
  function text(id, t) { $(id).textContent = t == null ? '' : String(t); }

  var KIND = { info: 'is-busy', ok: 'is-ok', warn: 'is-pending', error: 'is-error' };
  function notice(msg, kind) {
    var el = $('status-message');
    el.textContent = msg || '';
    el.className = 'status-message ' + (KIND[kind] || KIND.info);
    el.hidden = !msg;
  }
  function setStatus(state, label) {
    var el = $('status');
    el.className = 'status-badge is-' + state;
    el.textContent = label;
  }

  var token = null;
  try { token = localStorage.getItem(LINK_KEY); } catch (e) { token = null; }
  function setToken(t) {
    token = t;
    try { if (t) localStorage.setItem(LINK_KEY, t); else localStorage.removeItem(LINK_KEY); } catch (e) { /* storage blocked: linked for this page only */ }
  }

  var sdk = null;
  var linkedEmail = '';

  function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch('/api/panel' + path, {
      method: opts.body !== undefined ? 'POST' : 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { setToken(null); render(); }
        if (!r.ok) { var err = new Error(data.error || ('HTTP ' + r.status)); err.status = r.status; throw err; }
        return data;
      });
    });
  }

  // ─── views ────────────────────────────────────────────────────────────────

  function render() {
    show('view-outside', false);
    show('view-unlinked', !token);
    show('view-linked', !!token);
    if (!token) { setStatus('pending', 'Not linked'); return; }
    refreshStatus();
    loadContext();
  }

  var SOFTPHONE = {
    ready: ['ok', 'Ready', 'Your softphone is signed in. Numbers you click in Copper go there.'],
    open: ['pending', 'Not signed in', 'Your softphone is open but not signed in to Vobiz. Sign in there to call.'],
    closed: ['off', 'Softphone closed', 'Your softphone is not open. Open it and sign in to call.'],
  };

  function refreshStatus() {
    return api('/status').then(function (r) {
      linkedEmail = r.email || '';
      text('who', 'Linked to ' + r.name + ' in ' + r.workspace + '.');
      var st = SOFTPHONE[r.softphone] || SOFTPHONE.closed;
      setStatus(st[0], st[1]);
      text('softphone-state', st[2]);
      checkUser();
      return r;
    }).catch(function (err) { if (err.status !== 401) notice(err.message, 'error'); });
  }

  /** The panel is per browser: warn when the Copper user is not the linked one. */
  function checkUser() {
    if (!sdk || !linkedEmail || !sdk.getUserInfo) return;
    sdk.getUserInfo().then(function (info) {
      var email = info && info.user && info.user.email ? String(info.user.email).toLowerCase() : '';
      if (email && email !== linkedEmail.toLowerCase()) notice('This panel is linked to ' + linkedEmail + ', but you are signed in to Copper as ' + email + '. Unlink and link again.', 'warn');
    }).catch(function () { /* older Copper: no user info */ });
  }

  // ─── the record on screen ─────────────────────────────────────────────────

  function loadContext() {
    if (!sdk) return;
    sdk.getContext().then(function (data) {
      var ctx = (data && data.context) || {};
      var phones = Array.isArray(ctx.phone_numbers) ? ctx.phone_numbers : [];
      var ul = $('record-phones');
      ul.innerHTML = '';
      show('step-record', !!(data && data.type && (phones.length || ctx.name)));
      text('record-title', ctx.name ? String(ctx.name) : 'This record');
      text('record-hint', phones.length ? '' : 'This record has no phone number.');
      phones.slice(0, 10).forEach(function (p) {
        if (!p || !p.number) return;
        var li = document.createElement('li');
        var info = document.createElement('div'); info.className = 'history-info';
        var num = document.createElement('span'); num.className = 'history-who'; num.textContent = String(p.number);
        var cat = document.createElement('span'); cat.className = 'history-meta'; cat.textContent = p.category ? String(p.category) : '';
        info.appendChild(num); info.appendChild(cat);
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn btn-primary btn-compact'; btn.textContent = 'Call';
        btn.onclick = function () { sendDial(String(p.number), ctx.name ? String(ctx.name) : ''); };
        li.appendChild(info); li.appendChild(btn);
        ul.appendChild(li);
      });
    }).catch(function () { show('step-record', false); });
  }

  // ─── click-to-call ────────────────────────────────────────────────────────

  function sendDial(number, name) {
    if (!token) { notice('Link this panel to your softphone first.', 'warn'); return; }
    notice('Sending ' + number + ' to your softphone…', 'info');
    api('/dial', { body: { number: number, name: name || '' } }).then(function (r) {
      if (r.delivered) notice('Sent ' + r.number + ' to your softphone. Switch to it and click Call.', 'ok');
      else notice('Your softphone is not open, so ' + r.number + ' was not sent. Open it, sign in, then click the number again.', 'warn');
      refreshStatus();
    }).catch(function (err) { notice(err.message, 'error'); });
  }

  $('form-dial').onsubmit = function (e) {
    e.preventDefault();
    var n = $('in-dial').value.trim();
    if (n) sendDial(n, '');
  };

  // ─── linking ──────────────────────────────────────────────────────────────

  var popup = null;
  $('btn-link').onclick = function () {
    popup = window.open('/pair', 'vobiz-pair', 'width=440,height=520');
    if (!popup) { text('link-hint', 'The pop-up was blocked. Allow pop-ups for Copper in your browser, then click Link again.'); return; }
    text('link-hint', 'Finish in the pop-up window.');
  };

  window.addEventListener('message', function (e) {
    // Only our own /pair popup. The Copper SDK's messages come from Copper's
    // origin and are handled by the SDK.
    if (e.origin !== location.origin || !popup || e.source !== popup) return;
    var d = e.data || {};
    if (d.type !== 'vobiz-panel-link' || typeof d.token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(d.token)) return;
    setToken(d.token);
    popup = null;
    text('link-hint', '');
    notice('Linked to your softphone.', 'ok');
    render();
  });

  $('btn-unlink').onclick = function () {
    setToken(null);
    notice('Unlinked. Your softphone can also unlink every panel at once.', 'info');
    render();
  };

  // ─── boot: only inside an allowed Copper frame ────────────────────────────

  function outside() {
    show('view-outside', true);
    show('view-unlinked', false);
    show('view-linked', false);
    setStatus('off', 'Not in Copper');
  }

  var q = new URLSearchParams(location.search);
  var origin = q.get('origin') || '';
  var framed = window.top !== window.self;
  fetch('/copper/config').then(function (r) { return r.json(); }).then(function (cfg) {
    var allowed = Array.isArray(cfg.origins) && cfg.origins.indexOf(origin) !== -1;
    if (!framed || !allowed || !q.get('instanceId') || !window.Copper) { outside(); return; }
    try { sdk = window.Copper.init(); } catch (e) { outside(); return; }
    // With {"voip": true} in the app's advanced configuration, every phone
    // number in Copper is clickable and the click arrives here.
    sdk.on('phoneNumberClicked', function (msg) {
      var number = msg && msg.number ? String(msg.number) : '';
      if (!number) return;
      try { sdk.setAppUI({ showActionBar: true, isActionBarActive: true }); } catch (e) { /* not in the action bar */ }
      sendDial(number, '');
    });
    sdk.on('contextUpdated', loadContext);
    render();
  }).catch(outside);
})();
