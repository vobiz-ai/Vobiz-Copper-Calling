/* The /pair popup (see pair.html).
 *
 * Asks a softphone tab of this origin, over a BroadcastChannel, for a panel
 * link token, then posts it to the window that opened this one. postMessage
 * names this origin as the target, so the token only ever reaches our own
 * Copper panel, never a page that opened /pair from somewhere else.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  function say(t) { $('pair-status').textContent = t; }
  $('pair-close').onclick = function () { window.close(); };

  var channel;
  try { channel = new BroadcastChannel('vobiz-copper-pair'); } catch (e) { channel = null; }
  if (!channel) { say('This browser cannot link the panel. Use a current Chrome, Edge, Firefox or Safari.'); return; }
  if (!window.opener) { say('Open this from the Vobiz panel in Copper (click "Link to my softphone").'); return; }

  var id = '';
  var settled = false;
  var busy = false;

  channel.onmessage = function (e) {
    var d = e.data || {};
    if (d.id !== id || settled) return;
    if (d.type === 'pair-busy') { busy = true; return; }
    if (d.type !== 'pair-token' || typeof d.token !== 'string') return;
    settled = true;
    try {
      window.opener.postMessage({ type: 'vobiz-panel-link', token: d.token }, location.origin);
    } catch (err) {
      say('Could not reach the Copper panel. Close this window and click Link again.');
      return;
    }
    say('Linked to ' + (d.name || 'your softphone') + (d.workspace ? ' in ' + d.workspace : '') + '. You can close this window.');
    setTimeout(function () { window.close(); }, 1500);
  };

  function ask() {
    settled = false;
    busy = false;
    id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    $('pair-open').hidden = true;
    $('pair-retry').hidden = true;
    say('Looking for your softphone…');
    channel.postMessage({ type: 'pair-request', id: id });
    setTimeout(function () {
      if (settled) return;
      say(busy
        ? 'Your softphone is open but not connected to Copper. Connect Copper there, then try again.'
        : 'No softphone is open in this browser. Open it, connect Copper, then try again.');
      $('pair-open').hidden = busy;
      $('pair-retry').hidden = false;
    }, 2000);
  }
  $('pair-retry').onclick = ask;
  ask();
})();
