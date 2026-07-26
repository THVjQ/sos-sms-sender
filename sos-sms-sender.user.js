// SOS
// ==UserScript==
// @name         SOS SMS Sender
// @namespace    https://sosphonerepairs.com.au
// @version      21.0
// @description  Send SMS to customers via SOS Messenger (SMS Bridge) — sign-in, end-to-end encrypted send, replies, Sent history
// @author       SOS Phone Repairs
// @match        https://app.sospos.com.au/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/THVjQ/sos-sms-sender/main/sos-sms-sender.user.js
// @downloadURL  https://raw.githubusercontent.com/THVjQ/sos-sms-sender/main/sos-sms-sender.user.js
// ==/UserScript==

(function () {
  'use strict';

  const get   = (k, d) => { try { const v = GM_getValue(k, null); return v !== null ? v : d; } catch { return d; } };
  const set   = (k, v) => { try { GM_setValue(k, v); } catch {} };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // The server URL isn't secret (it's gated by the API key below), so it's
  // safe to pre-fill. Set your own API key via the ⚙️ Bridge Settings panel
  // in the SMS FAB — never hardcode a real key here, this script lives in a
  // public repo.
  const DEFAULT_SERVER = 'https://sosmessenger.thvjq.com.au';
  const DEFAULT_APIKEY = '';

  // How long to wait for the phone to confirm the SMS actually went out. "Queued" is not the same
  // as "sent", and silent-pending is the worst possible outcome when the message is "your phone is
  // ready for collection".
  const CONFIRM_TIMEOUT_MS  = 30000;
  const CONFIRM_INTERVAL_MS = 2000;

  // ── End-to-end inbound: this PC's keypair ───────────────────────────────────
  //
  // Replies used to be encrypted to the SERVER's key and decrypted by it on the way out, so the
  // server could read every incoming customer message while the code claimed otherwise. This PC now
  // owns a P-256 keypair; the phone encrypts one envelope per registered desktop and the server
  // relays ciphertext it holds no key for.
  //
  // ECIES v1, byte-compatible with the server (node:crypto) and NexLink (JCA):
  //   ECDH P-256 → HKDF-SHA256, 32 zero bytes of salt, info "sms-bridge-v1" → AES-256-GCM,
  //   12-byte IV, 16-byte tag, AAD = info. Envelope { v, epk, iv, tag, ct }, all base64.

  const E2E_INFO = new TextEncoder().encode('sms-bridge-v1');
  const E2E_SALT = new Uint8Array(32);

  const b64enc = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64dec = s   => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function getOrCreateClientKeys() {
    const stored = get('client_keypair', null);
    if (stored && stored.privateJwk && stored.publicB64) return stored;

    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const fresh = {
      privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
      publicB64:  b64enc(await crypto.subtle.exportKey('spki', pair.publicKey)),
    };
    set('client_keypair', fresh);
    return fresh;
  }

  /** First 8 bytes of SHA-256 over the DER, as hex — computed identically on all three sides. */
  async function clientKeyId(publicB64) {
    const digest = await crypto.subtle.digest('SHA-256', b64dec(publicB64));
    return Array.from(new Uint8Array(digest).slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function deriveAesKey(privateJwk, ephemeralSpkiB64) {
    const priv = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const epk  = await crypto.subtle.importKey('spki', b64dec(ephemeralSpkiB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);

    const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: E2E_SALT, info: E2E_INFO }, hkdfKey, 256);
    return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['decrypt']);
  }

  /**
   * Seals `plaintext` for the holder of `recipientSpkiB64` — used to encrypt outbound texts to the
   * phone before they leave this browser.
   *
   * Until this existed the userscript posted plaintext and the SERVER encrypted it to the phone's
   * key. Ciphertext at rest, but the server read every outgoing message on the way through, which
   * matters the moment someone else's messages are on the same server.
   */
  async function encryptEnvelope(plaintext, recipientSpkiB64) {
    const recipient = await crypto.subtle.importKey(
      'spki', b64dec(recipientSpkiB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);

    const shared  = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256);
    const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const bits    = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: E2E_SALT, info: E2E_INFO }, hkdfKey, 256);
    const aesKey  = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt']);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: E2E_INFO, tagLength: 128 },
      aesKey, new TextEncoder().encode(plaintext)));

    // WebCrypto returns ciphertext||tag; the wire format keeps them as separate fields.
    const ct  = sealed.slice(0, sealed.length - 16);
    const tag = sealed.slice(sealed.length - 16);

    return {
      v:   1,
      epk: b64enc(await crypto.subtle.exportKey('spki', ephemeral.publicKey)),
      iv:  b64enc(iv),
      tag: b64enc(tag),
      ct:  b64enc(ct),
    };
  }

  async function decryptEnvelope(envelope, privateJwk) {
    if (!envelope || envelope.v !== 1) throw new Error('Unknown envelope version');
    const aesKey = await deriveAesKey(privateJwk, envelope.epk);
    // WebCrypto expects ciphertext and tag concatenated; the wire format keeps them apart.
    const ct  = b64dec(envelope.ct);
    const tag = b64dec(envelope.tag);
    const buf = new Uint8Array(ct.length + tag.length);
    buf.set(ct); buf.set(tag, ct.length);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64dec(envelope.iv), additionalData: E2E_INFO, tagLength: 128 }, aesKey, buf);
    return new TextDecoder().decode(plain);
  }

  /**
   * Publishes this PC's public key so phones on the account can address replies to it. Cheap and
   * idempotent, so it runs on startup and again whenever the inbox is opened — a reply that arrives
   * before any PC has registered is the case the phone has to queue for.
   */
  async function registerClientKey() {
    const { server, apikey } = bridgeCreds();
    if (!server || !apikey) return null;
    const keys = await getOrCreateClientKeys();
    try {
      await apiRequest(server, apikey, '/api/tools/sms-bridge/client-key', 'POST',
        { public_key: keys.publicB64, label: get('client_label', 'This PC') });
    } catch (e) {
      console.warn('[SOS SMS] could not register this PC\'s key:', e.message);
    }
    return keys;
  }

  // ── Progress overlay ────────────────────────────────────────────────────────

  let progressEl = null;

  // `opts` (optional): { doneText, doneColor, doneIcon, sticky, hint }. The 100% state used to be
  // hardcoded to "queued for delivery", which said nothing about whether a phone ever collected it.
  function showProgress(step, pct, error, opts) {
    opts = opts || {};
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.65);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
      progressEl.innerHTML = '<div style="background:#111827;border:1.5px solid #1769aa;border-radius:16px;padding:28px 30px;width:340px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.7);color:#e5e7eb;text-align:center"><div style="font-size:26px;margin-bottom:10px" id="pg-icon">📱</div><div style="font-weight:800;font-size:15px;color:#60a5fa;margin-bottom:5px">Sending via SOS Messenger</div><div id="pg-step" style="font-size:12.5px;color:#9ca3af;margin-bottom:16px;min-height:18px"></div><div style="background:#1f2937;border-radius:99px;height:8px;overflow:hidden;margin-bottom:12px"><div id="pg-bar" style="height:100%;border-radius:99px;background:linear-gradient(90deg,#1769aa,#60a5fa);width:0%;transition:width .45s cubic-bezier(.4,0,.2,1)"></div></div><div id="pg-error" style="display:none;background:#450a0a;border:1px solid #7f1d1d;border-radius:8px;padding:10px 12px;font-size:12px;color:#fca5a5;margin-bottom:12px;text-align:left;line-height:1.5"></div><button id="pg-close" style="display:none;padding:8px 22px;background:#1f2937;color:#e5e7eb;border:none;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600">Close</button></div>';
      document.body.appendChild(progressEl);
      document.getElementById('pg-close').onclick = () => { progressEl && progressEl.remove(); progressEl = null; };
    }
    const bar    = document.getElementById('pg-bar');
    const stepEl = document.getElementById('pg-step');
    const icon   = document.getElementById('pg-icon');
    const errEl  = document.getElementById('pg-error');
    const closeBtn = document.getElementById('pg-close');
    if (error) {
      icon.textContent = '❌';
      stepEl.textContent = 'Could not send message';
      bar.style.background = 'linear-gradient(90deg,#7f1d1d,#ef4444)'; bar.style.width = '100%';
      errEl.style.display = 'block';
      errEl.innerHTML = '<b>Error:</b> ' + esc(error)
        + '<br><br><span style="color:#9ca3af">' + (opts.hint ? esc(opts.hint)
            : 'Make sure the SOS Messenger server is running and the bridge is configured correctly.') + '</span>';
      closeBtn.style.display = 'inline-block';
      return;
    }
    bar.style.width = pct + '%'; stepEl.textContent = step;
    if (pct >= 100) {
      icon.textContent   = opts.doneIcon  || '✅';
      stepEl.style.color = opts.doneColor || '#34d399';
      stepEl.textContent = opts.doneText  || step;
      // A warning about an unconfirmed message must not vanish before it is read.
      if (opts.sticky) closeBtn.style.display = 'inline-block';
      else setTimeout(() => { progressEl && progressEl.remove(); progressEl = null; }, 1800);
    }
  }

  // ── Generic authenticated API call (used by send + pairing) ─────────────────

  // Raw call — resolves with { status, data } for any HTTP status, so callers can act on a 409
  // ("that phone has no key") differently from a 500. Only transport failures reject.
  function bridgeCall(server, apikey, path, method, body) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method,
          url: `${server}${path}`,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key':    apikey,
            'ngrok-skip-browser-warning': '1',
          },
          data:    body ? JSON.stringify(body) : undefined,
          timeout: 15000,
          onload: (res) => {
            let data = null;
            try { data = JSON.parse(res.responseText); } catch (_) {}
            resolve({ status: res.status, data });
          },
          onerror:   () => reject(new Error('Network error — is the SOS Messenger server running?')),
          ontimeout: () => reject(new Error('Request timed out — check the server URL and your internet connection.')),
        });
      } catch (e) { reject(e); }
    });
  }

  async function apiRequest(server, apikey, path, method, body) {
    const { status, data } = await bridgeCall(server, apikey, path, method, body);
    if (status === 401 || status === 403) throw new Error('Authentication failed — check your API key.');
    if (!data) throw new Error(`Server returned invalid JSON (HTTP ${status})`);
    return data;
  }

  function bridgeCreds() {
    return {
      server: get('bridge_server', DEFAULT_SERVER).replace(/\/$/, ''),
      apikey: get('bridge_apikey', DEFAULT_APIKEY),
    };
  }

  // Which phone this PC sends through. Empty means "let the server pick", which is only safe while
  // exactly one phone is paired — the picker in Bridge Settings exists so it stops being a guess.
  const getTargetDevice = () => get('bridge_device_id', '');
  const setTargetDevice = id => set('bridge_device_id', id || '');

  // ── Sign-in ─────────────────────────────────────────────────────────────────
  //
  // Signing in mints an API key for this browser and stores it where the key field used to be
  // written by hand, so everything downstream is unchanged — a person just never handles a key.
  // The key is still what authenticates every request; the login is only how it gets here.

  const getSession    = () => get('bridge_session', null);   // { username, role, account_id }
  const setSession    = s  => set('bridge_session', s);
  const clearSession  = () => { set('bridge_session', null); set('bridge_apikey', ''); };
  const isAdmin       = () => { const s = getSession(); return !!s && s.role === 'admin'; };

  async function authRequest(path, body) {
    const { server } = bridgeCreds();
    if (!server) throw new Error('Set the server URL first.');
    const { status, data } = await bridgeCall(server, '', '/api/tools/sms-bridge' + path, 'POST', body);
    if (!data) throw new Error(`Server returned invalid JSON (HTTP ${status})`);
    if (status >= 400) {
      const err = new Error(data.error || `Sign-in failed (HTTP ${status})`);
      err.code = data.code;
      throw err;
    }
    return data;
  }

  async function doLogin(username, password) {
    const data = await authRequest('/auth/login', { username, password, label: navigator.platform || 'Browser' });
    set('bridge_apikey', data.api_key);
    setSession({ username: data.user.username, role: data.user.role, account_id: data.user.account_id });
    // Publish this PC's reply key under the account just signed in to.
    registerClientKey().catch(() => {});
    return data;
  }

  async function doRegister(username, password) {
    return authRequest('/auth/register', { username, password });
  }

  /** Confirms the stored key still works and refreshes the cached role. */
  async function refreshSession() {
    const { server, apikey } = bridgeCreds();
    if (!server || !apikey) return null;
    try {
      const data = await apiRequest(server, apikey, '/api/tools/sms-bridge/auth/me', 'GET');
      if (data.user) {
        setSession({ username: data.user.username, role: data.user.role, account_id: data.user.account_id });
      }
      return data;
    } catch (_) {
      return null;   // offline, or a key that has been revoked — the panel reports it in context
    }
  }

  async function generatePairingCode() {
    const { server, apikey } = bridgeCreds();
    if (!server || !apikey) throw new Error('Set the server URL and API key in ⚙️ Bridge Settings first.');
    const data = await apiRequest(server, apikey, '/api/tools/sms-bridge/generate-code', 'POST');
    if (!data.ok) throw new Error(data.error || 'Could not generate pairing code');
    return data.code;
  }

  async function fetchPairedDevices() {
    const { server, apikey } = bridgeCreds();
    if (!server || !apikey) throw new Error('Set the server URL and API key in ⚙️ Bridge Settings first.');
    const data = await apiRequest(server, apikey, '/api/tools/sms-bridge/devices', 'GET');
    return { devices: data.devices || [], defaultId: data.default_device_id || '' };
  }

  async function deletePairedDevice(deviceId) {
    const { server, apikey } = bridgeCreds();
    const data = await apiRequest(server, apikey, '/api/tools/sms-bridge/devices/' + encodeURIComponent(deviceId), 'DELETE');
    if (!data.ok) throw new Error(data.error || 'Could not remove device');
    if (getTargetDevice() === deviceId) setTargetDevice('');
    return data;
  }

  // ── SOS Messenger bridge send ───────────────────────────────────────────────

  /**
   * Finds the phone this message is for and its public key. Mirrors the server's own resolution —
   * the chosen device, else the account default, else the only phone — so the error you get here
   * reads the same as the one the server would have given.
   */
  async function resolveTargetKey(deviceId) {
    const { devices, defaultId } = await fetchPairedDevices();
    if (!devices.length) {
      const err = new Error('No phone is paired with the server.');
      err.hint = 'Use 🔗 Pair Device to link one.';
      throw err;
    }

    const chosen = deviceId
      ? devices.find(d => d.device_id === deviceId)
      : (devices.find(d => d.device_id === defaultId) || (devices.length === 1 ? devices[0] : null));

    if (!chosen) {
      const err = new Error(deviceId
        ? 'The phone selected in Bridge Settings is no longer paired.'
        : 'Several phones are paired and none is set as default.');
      err.hint = 'Choose which phone this PC sends through in ⚙️ Bridge Settings.';
      throw err;
    }
    if (!chosen.public_key) {
      const err = new Error(`"${chosen.label || 'That phone'}" has no encryption key.`);
      err.hint = 'On the phone: Computer Bridge → Unlink & re-pair, using a fresh code from 🔗 Pair Device.';
      throw err;
    }
    return chosen;
  }

  /**
   * Queues the message against a specific phone and then waits for that phone to confirm it went
   * out. Returns the final delivery state; throws only when the message was never accepted.
   */
  async function sendViaBridge(phone, message) {
    const { server, apikey } = bridgeCreds();
    if (!server || !apikey) {
      throw new Error('SOS Messenger not configured. Click ⚙️ in the SMS panel to set the server URL and API key.');
    }

    showProgress('Connecting to SOS Messenger…', 20);
    await sleep(250);

    // Encrypt here, not on the server. Look up the target phone's public key and seal the message
    // before it leaves the browser, so the server relays ciphertext it cannot read in either
    // direction. If the phone's key can't be resolved we do NOT fall back to sending plaintext —
    // every silent failure in this system traced back to a fallback that hid a broken state.
    const deviceId = getTargetDevice();
    const target   = await resolveTargetKey(deviceId);
    const body     = { phone, device_id: target.device_id, encrypted_message: await encryptEnvelope(message, target.public_key) };

    const { status, data } = await bridgeCall(server, apikey, '/api/tools/sms-bridge/send', 'POST', body);

    if (status === 401 || status === 403) {
      throw new Error('Authentication failed — check your API key in ⚙️ Settings.');
    }
    if (!data) throw new Error(`Server returned invalid JSON (HTTP ${status})`);

    // The server refuses to queue a message it cannot encrypt or cannot route. Each of these is
    // fixable by the person reading it, so say what to do rather than just echoing the status.
    if (status === 409 || status === 404) {
      const code = data.code || '';
      const hint =
        code === 'NO_DEVICE_KEY'      ? 'The phone is registered but has no encryption key. On the phone: Computer Bridge → Unlink & re-pair, then generate a fresh code from 🔗 Pair Device here.' :
        code === 'DEVICE_NOT_FOUND'   ? 'The phone selected in ⚙️ Bridge Settings is no longer paired. Pick another one, or pair the phone again.' :
        code === 'NO_DEVICES'         ? 'No phone is paired with the server yet. Use 🔗 Pair Device to link one.' :
        code === 'NO_DEFAULT_DEVICE'  ? 'Several phones are paired. Choose which one this PC sends through in ⚙️ Bridge Settings.' :
                                        'Check the paired phones in ⚙️ Bridge Settings.';
      const err = new Error(data.error || 'The server would not queue this message.');
      err.hint = hint;
      throw err;
    }
    if (!data.ok) throw new Error(data.error || `Server error (HTTP ${status})`);

    const targetName = (data.target && (data.target.label || data.target.device_id))
      || target.label || 'the phone';
    showProgress(`Queued for ${targetName} — waiting for it to send…`, 55);

    return await confirmDelivery(data.id, targetName);
  }

  /**
   * Polls the message's own row until the phone reports it sent. "Queued" only means a row was
   * inserted; a phone that is asleep, unpaired or out of signal leaves it sitting there, and that
   * silence used to be reported to the user as success.
   */
  async function confirmDelivery(id, target) {
    const { server, apikey } = bridgeCreds();
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let last = 'pending';

    while (Date.now() < deadline) {
      await sleep(CONFIRM_INTERVAL_MS);
      let row = null;
      try {
        const data = await apiRequest(server, apikey, '/api/tools/sms-bridge/history?id=' + encodeURIComponent(id), 'GET');
        row = (data.messages || [])[0];
      } catch (_) {
        continue;   // a blip while polling is not a delivery failure — keep waiting
      }
      if (!row) continue;
      last = row.status;

      if (row.status === 'sent') {
        showProgress('', 100, null, { doneText: '✅ Delivered by ' + target });
        return { status: 'sent', id };
      }
      if (row.status === 'failed') {
        const err = new Error('The phone could not send this message.');
        err.hint = 'Check the phone has signal and SMS permission, then try again.';
        throw err;
      }

      const elapsed = CONFIRM_TIMEOUT_MS - (deadline - Date.now());
      const pct = 55 + Math.min(40, Math.round((elapsed / CONFIRM_TIMEOUT_MS) * 40));
      showProgress(row.status === 'claimed' ? `${target} is sending…` : `Waiting for ${target} to pick it up…`, pct);
    }

    // Not a failure and not a success. Say exactly that instead of picking the flattering one.
    showProgress('', 100, null, {
      doneIcon:  '⏳',
      doneColor: '#fbbf24',
      doneText:  last === 'claimed'
        ? `${target} has the message but hasn't confirmed sending yet.`
        : `Still queued — ${target} hasn't picked it up yet.`,
      sticky: true,
    });
    return { status: last, id };
  }

  // ── FAB + panel ─────────────────────────────────────────────────────────────

  function initSOSPOS() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { addFAB(); setInterval(addFAB, 2000); });
    } else {
      addFAB(); setInterval(addFAB, 2000);
    }
    // Confirm the stored key still works and pick up a role change (an approval, or admin granted
    // since last time), so the admin button appears or disappears without needing a re-login.
    refreshSession().catch(() => {});
    // Publish this PC's public key early: until a phone knows it, replies have nowhere to go and
    // sit queued on the handset.
    registerClientKey().catch(() => {});
  }

  initSOSPOS();

  let panel = null;
  let _prefill = null;   // { name, phone, ticket, device, message } consumed once by buildPanel (Resend)
  let _lockBody = false;  // when set, syncPreview leaves the message box untouched (Resend keeps exact text)

  function addFAB() {
    if (!document.body) return;
    if (document.getElementById('sos-sms-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'sos-sms-fab'; fab.title = 'Send SMS'; fab.textContent = '💬';
    fab.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:99997;width:42px;height:42px;border-radius:50%;background:#1769aa;color:#fff;border:none;font-size:18px;cursor:pointer;box-shadow:0 3px 14px rgba(23,105,170,.55);display:flex;align-items:center;justify-content:center;transition:background .15s;';
    fab.onmouseenter = () => { fab.style.background = '#0d47a1'; };
    fab.onmouseleave = () => { fab.style.background = '#1769aa'; };
    fab.onclick = () => { if (panel) { panel.remove(); panel = null; } else buildPanel(); };
    document.body.appendChild(fab);
  }

  // ── Ticket lookup ───────────────────────────────────────────────────────────

  let _ticketDebounce = null;

  function lookupTicketInDOM(ticketNum) {
    const upper = ticketNum.toUpperCase();
    const result = { ticket: upper, name:'', phone:'', device:'' };
    const fullText = (document.body && document.body.innerText) || '';
    const SKIP = /^(—|-|\$|paid|open|closed|pending|collect|repair|sale|refund|walk in|\d{4,}$)/i;

    const lines = fullText.split(/[\r\n]+/);
    for (const line of lines) {
      const parts = line.split(/\t/).map(p => p.trim());
      const ti = parts.findIndex(p => p.toUpperCase() === upper);
      if (ti === -1) continue;
      const useful = parts.slice(ti + 1).filter(p => p && !SKIP.test(p) && p.length > 1 && p.length < 60);
      if (useful[0]) result.name   = useful[0].split(' ')[0];
      if (useful[1]) result.device = useful[1].substring(0, 60);
      const ph = line.match(/(?:Phone|Mobile|Ph|Mob)\s*:?\s*((?:\+?61|0)[4-9]\d{8})/i);
      if (ph) result.phone = ph[1];
      if (result.name || result.device) return result;
    }

    const allParts = fullText.split(/\t/).map(p => p.trim());
    const ti2 = allParts.findIndex(p => p.toUpperCase() === upper);
    if (ti2 !== -1) {
      const useful = allParts.slice(ti2 + 1, ti2 + 8).filter(p => p && !SKIP.test(p) && p.length > 1 && p.length < 60);
      if (useful[0]) result.name   = useful[0].split(' ')[0];
      if (useful[1]) result.device = useful[1].substring(0, 60);
      if (result.name || result.device) return result;
    }

    return null;
  }

  function lookupTicketViaNetwork(ticketNum) {
    return new Promise(resolve => {
      const candidates = [
        'https://app.sospos.com.au/tickets/' + ticketNum,
        'https://app.sospos.com.au/repair/'  + ticketNum,
        'https://app.sospos.com.au/repairs/' + ticketNum,
        'https://app.sospos.com.au/job/'     + ticketNum,
        'https://app.sospos.com.au/jobs/'    + ticketNum,
        'https://app.sospos.com.au/search?q='+ encodeURIComponent(ticketNum),
      ];
      let idx = 0;
      function tryNext() {
        if (idx >= candidates.length) { resolve(null); return; }
        const url = candidates[idx++];
        try {
          GM_xmlhttpRequest({
            method:'GET', url, timeout:7000,
            onload(resp) {
              if (resp.status < 200 || resp.status >= 400) { tryNext(); return; }
              const parsed = parseTicketHTML(resp.responseText, ticketNum);
              if (parsed && (parsed.name || parsed.phone || parsed.device)) resolve(parsed);
              else tryNext();
            },
            onerror()   { tryNext(); },
            ontimeout() { tryNext(); },
          });
        } catch(_) { tryNext(); }
      }
      tryNext();
    });
  }

  function parseTicketHTML(html, ticketNum) {
    const txt = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#39;/g,"'").replace(/&quot;/g,'"')
      .replace(/\s{2,}/g,' ');

    const result = { ticket: ticketNum.toUpperCase(), name:'', phone:'', device:'' };
    const phM = txt.match(/(?:\+?61|0)[4-9]\d{8}/);
    if (phM) result.phone = phM[0];
    for (const pat of [/Customer\s*:?\s*([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)/,/Client\s*:?\s*([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)/,/Name\s*:?\s*([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)/]) {
      const m = txt.match(pat); if (m && m[1] && m[1].length > 1) { result.name = m[1].split(' ')[0]; break; }
    }
    for (const pat of [/(?:Device|Model|Item|Product)\s*:?\s*([^\n,|]{4,50})/i,/(?:iPhone|iPad|Samsung|Google Pixel|Huawei|OnePlus|Oppo|Realme|Nokia|Motorola|Sony|LG|Xiaomi)[^\n,|]{0,30}/i]) {
      const m = txt.match(pat); if (m) { result.device = m[0].replace(/^(?:Device|Model|Item|Product)\s*:?\s*/i,'').trim().substring(0,50); break; }
    }
    return result;
  }

  async function lookupTicket(ticketNum) {
    if (!ticketNum || !/^[Aa]\d{3,6}$/.test(ticketNum)) return null;
    const domResult = lookupTicketInDOM(ticketNum);
    if (domResult && (domResult.name || domResult.device)) return domResult;
    return await lookupTicketViaNetwork(ticketNum);
  }

  function onTicketInput(value) {
    clearTimeout(_ticketDebounce);
    const ticketNum = value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    const statusEl  = document.getElementById('sms-ticket-status');

    if (!/^[A][0-9]{3,6}$/.test(ticketNum)) {
      if (statusEl) statusEl.textContent = '';
      return;
    }

    if (statusEl) { statusEl.textContent = '🔍 Looking up…'; statusEl.style.color = '#60a5fa'; }

    _ticketDebounce = setTimeout(async () => {
      const found = await lookupTicket(ticketNum);
      const st = document.getElementById('sms-ticket-status');
      if (!found) {
        if (st) { st.textContent = '⚠️ Not found — fill in manually'; st.style.color = '#fbbf24'; }
        return;
      }
      if (found.name   && !document.getElementById('sms-name').value.trim())   setF('sms-name',   found.name);
      if (found.phone  && !document.getElementById('sms-phone').value.trim())  setF('sms-phone',  found.phone);
      if (found.device && !document.getElementById('sms-device').value.trim()) setF('sms-device', found.device);
      if (st) { st.textContent = '✅ Details loaded — edit if needed'; st.style.color = '#34d399'; }
      syncPreview();
      setTimeout(() => { const s = document.getElementById('sms-ticket-status'); if (s) s.textContent = ''; }, 4000);
    }, 600);
  }

  // ── Templates ───────────────────────────────────────────────────────────────

  const DEFAULT_TEMPLATES = [
    { id:'t1', name:'✅ Ready for Pickup',  body:'Hi {name}, great news!\nYour {device} (#{ticket}) is ready for collection. See you soon!\n— SOS Phone Repairs' },
    { id:'t2', name:'🔧 Parts Ordered',     body:"Hi {name}, parts for your {device} repair (#{ticket}) have been ordered. We'll be in touch when ready. — SOS Phone Repairs" },
    { id:'t3', name:'💬 Quote Ready',       body:'Hi {name}, we\'ve assessed your {device} (#{ticket}) and have a quote ready.\nPlease call us to discuss. — SOS Phone Repairs' },
    { id:'t4', name:'⏳ Repair Delayed',    body:'Hi {name}, sorry — your {device} repair (#{ticket}) is taking a bit longer than expected.\nWe\'ll be in touch shortly. — SOS Phone Repairs' },
    { id:'t5', name:'📝 Custom Message',    body:'Hi {name}, ' },
  ];
  const getTemplates  = () => get('templates', DEFAULT_TEMPLATES);
  const saveTemplates = t  => set('templates', t);

  // ── Sent history ─────────────────────────────────────────────────────────────

  const HISTORY_CAP    = 300;                         // keep the most recent N sends
  const getHistory     = () => get('sms_history', []);
  const saveHistory    = h  => set('sms_history', h);

  // Records a successful send. Newest first, capped at HISTORY_CAP.
  function recordSent(entry) {
    try {
      const h = getHistory();
      h.unshift({
        ts:       Date.now(),
        phone:    entry.phone   || '',
        name:     entry.name    || '',
        ticket:   entry.ticket  || '',
        device:   entry.device  || '',
        message:  entry.message || '',
        delivery: entry.delivery || 'sent',   // 'sent' | 'claimed' | 'pending'
        msgId:    entry.msgId || null,
      });
      if (h.length > HISTORY_CAP) h.length = HISTORY_CAP;
      saveHistory(h);
    } catch (_) {}
  }

  function relTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60)     return 'just now';
    if (s < 3600)   return Math.floor(s / 60)   + 'm ago';
    if (s < 86400)  return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }
  function absTime(ts) {
    try { return new Date(ts).toLocaleString(); } catch (_) { return ''; }
  }

  // ── Panel builder ───────────────────────────────────────────────────────────

  function buildPanel() {
    if (panel) panel.remove();
    const templates   = getTemplates();
    const savedTplId  = get('lastTplId', templates[0] && templates[0].id || 't1');
    const tpl         = templates.find(t => t.id === savedTplId) || templates[0];
    const pf          = _prefill || {}; _prefill = null;
    const d           = Object.assign(readFromPage(), pf);
    _lockBody = false;
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">💬 Send SMS</span>'
        // The admin button only exists for an admin. A normal user never sees that it could.
        + '<div style="display:flex;gap:3px">'
          + (isAdmin() ? '<button id="sms-admin-btn" title="Administration" style="' + IB + '">👤</button>' : '')
          + '<button id="sms-inbox-btn" title="Replies" style="' + IB + '">📥</button>'
          + '<button id="sms-hist-btn" title="Sent history" style="' + IB + '">📜</button>'
          + '<button id="sms-pair-btn" title="Pair device" style="' + IB + '">🔗</button>'
          + '<button id="sms-cfg-btn" title="Bridge settings" style="' + IB + '">⚙️</button>'
          + '<button id="sms-tpl-btn" title="Edit templates" style="' + IB + '">✏️</button>'
          + '<button id="sms-close" style="' + IB + '">✕</button>'
        + '</div>'
      + '</div>'
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<label style="' + L + '">Ticket #</label>'
        + '<div style="display:flex;gap:6px;align-items:center;margin-top:3px">'
          + '<input id="sms-ticket" value="' + esc(d.ticket) + '" placeholder="A1234" maxlength="8" style="' + I + ';font-weight:700;letter-spacing:.06em;text-transform:uppercase;flex:1">'
          + '<button id="sms-read" title="Read current page" style="padding:7px 9px;background:#1f2937;color:#9ca3af;border:1px solid #374151;border-radius:7px;font-size:11.5px;cursor:pointer;white-space:nowrap;flex-shrink:0">📄</button>'
        + '</div>'
        + '<div id="sms-ticket-status" style="font-size:10.5px;margin-top:5px;min-height:14px;color:#60a5fa;transition:color .2s"></div>'
      + '</div>'
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<div style="font-size:10px;font-weight:800;color:#4b5563;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Customer</div>'
        + '<div style="display:flex;flex-direction:column;gap:7px">'
          + '<div><label style="' + L + '">First Name</label><input id="sms-name" value="' + esc(d.name) + '" placeholder="John" style="' + I + '"></div>'
          + '<div><label style="' + L + '">Phone Number</label><input id="sms-phone" value="' + esc(d.phone) + '" placeholder="04XX XXX XXX" style="' + I + '"></div>'
          + '<div><label style="' + L + '">Device / Model</label><input id="sms-device" value="' + esc(d.device) + '" placeholder="iPhone 14 Pro" style="' + I + '"></div>'
        + '</div>'
      + '</div>'
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<label style="' + L + '">Template</label>'
        + '<div id="sms-tpls" style="display:flex;flex-direction:column;gap:3px;margin-top:5px">' + templates.map(t => tplRadio(t, t.id === savedTplId)).join('') + '</div>'
      + '</div>'
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">'
          + '<label style="' + L + '">Message</label>'
          + '<span id="sms-chars" style="font-size:10.5px;color:#6b7280">0 / 160</span>'
        + '</div>'
        + '<textarea id="sms-body" rows="4" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #374151;background:#1f2937;color:#e5e7eb;font-size:12.5px;font-family:inherit;outline:none;resize:vertical;line-height:1.5;box-sizing:border-box">' + esc(applyVars(tpl && tpl.body || '', d)) + '</textarea>'
        + '<div style="font-size:10.5px;color:#4b5563;margin-top:4px"><code style="background:#1f2937;padding:1px 4px;border-radius:3px;color:#60a5fa">{name}</code> <code style="background:#1f2937;padding:1px 4px;border-radius:3px;color:#60a5fa">{device}</code> <code style="background:#1f2937;padding:1px 4px;border-radius:3px;color:#60a5fa">{ticket}</code></div>'
      + '</div>'
      + '<div style="padding:12px 14px">'
        + '<button id="sms-send" style="width:100%;padding:12px;background:#1769aa;color:#fff;border:none;border-radius:9px;font-size:13.5px;font-weight:800;cursor:pointer;letter-spacing:.02em;transition:background .15s">📤 Send via SOS Messenger</button>'
      + '</div>';

    document.body.appendChild(panel);
    wirePanelEvents();
    if (d.ticket) onTicketInput(d.ticket);
    // Resend: pin the exact original text so template/lookup auto-fill can't clobber it.
    if (pf.message != null) {
      const b = document.getElementById('sms-body');
      if (b) { b.value = pf.message; _lockBody = true; countChars(); }
    }
  }

  function wirePanelEvents() {
    document.getElementById('sms-close').onclick    = () => { panel.remove(); panel = null; };
    document.getElementById('sms-tpl-btn').onclick  = buildEditPanel;
    document.getElementById('sms-cfg-btn').onclick  = buildSettingsPanel;
    document.getElementById('sms-pair-btn').onclick = buildPairPanel;
    document.getElementById('sms-hist-btn').onclick  = buildHistoryPanel;
    document.getElementById('sms-inbox-btn').onclick = buildInboxPanel;
    const adminBtn = document.getElementById('sms-admin-btn');
    if (adminBtn) adminBtn.onclick = buildAdminPanel;

    document.getElementById('sms-read').onclick = () => {
      const f = readFromPage();
      if (f.ticket) {
        setF('sms-ticket', f.ticket);
        onTicketInput(f.ticket);
      } else {
        const st = document.getElementById('sms-ticket-status');
        if (st) { st.textContent = '⚠️ No ticket found in URL'; st.style.color = '#fbbf24'; }
      }
      syncPreview();
    };

    document.getElementById('sms-ticket').oninput = e => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
      syncPreview();
      onTicketInput(e.target.value);
    };

    ['sms-name','sms-phone','sms-device'].forEach(id => document.getElementById(id).oninput = syncPreview);
    document.getElementById('sms-body').oninput = countChars;

    panel.querySelectorAll('input[name="sms-tpl"]').forEach(r => {
      r.onchange = () => {
        _lockBody = false;   // explicit template choice overrides a pinned Resend message
        set('lastTplId', r.value);
        const t = getTemplates().find(t => t.id === r.value);
        if (t) document.getElementById('sms-body').value = applyVars(t.body, curVals());
        countChars();
        panel.querySelectorAll('#sms-tpls label').forEach(lbl => {
          const cb = lbl.querySelector('input');
          lbl.style.borderColor = cb.checked ? '#1769aa' : '#1f2937';
          lbl.style.background  = cb.checked ? '#1769aa1a' : 'transparent';
          lbl.querySelector('span').style.fontWeight = cb.checked ? '600' : '400';
        });
      };
    });

    document.getElementById('sms-send').onclick = async () => {
      const v = curVals();
      const message = document.getElementById('sms-body').value.trim();
      if (!v.phone)  { flash('⚠️ Phone number is required'); return; }
      if (!message)  { flash('⚠️ Message cannot be empty');  return; }
      panel.remove(); panel = null;
      showProgress('Connecting to SOS Messenger…', 10);
      const normPhone = normalizePhone(v.phone);
      try {
        const result = await sendViaBridge(normPhone, message);
        // Recorded with the outcome the phone actually reported, so an unconfirmed message is not
        // filed away in history as if it had been delivered.
        recordSent({ phone: normPhone, name: v.name, ticket: v.ticket, device: v.device, message,
                     delivery: result.status, msgId: result.id });
      } catch (e) {
        console.error('[SOS SMS]', e);
        showProgress('', 0, e.message || 'Unknown error', { hint: e.hint });
      }
    };

    syncPreview();
  }

  // ── Settings panel ──────────────────────────────────────────────────────────

  function buildSettingsPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    const curServer = get('bridge_server', DEFAULT_SERVER);
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">⚙️ Bridge Settings</span>'
        + '<button id="cfg-back" style="background:none;border:none;color:#60a5fa;font-size:12px;font-weight:700;cursor:pointer">← Back</button>'
      + '</div>'
      + '<div style="padding:14px">'
        + '<div style="font-size:10.5px;color:#6b7280;margin-bottom:14px;line-height:1.5">Point this PC at your SOS Messenger server and sign in. Changes apply immediately.</div>'
        + '<div style="margin-bottom:12px">'
          + '<label style="' + L + '">Server URL</label>'
          + '<input id="cfg-server" value="' + esc(curServer) + '" placeholder="https://..." style="' + I + ';margin-top:3px">'
        + '</div>'
        + '<div id="cfg-auth" style="margin-bottom:16px"></div>'
        + '<div style="margin-bottom:16px">'
          + '<div style="display:flex;justify-content:space-between;align-items:center">'
            + '<label style="' + L + '">Send through</label>'
            + '<button id="cfg-dev-refresh" style="background:none;border:none;color:#60a5fa;font-size:10.5px;font-weight:700;cursor:pointer;padding:0">↻ Reload</button>'
          + '</div>'
          + '<select id="cfg-device" style="' + I + ';margin-top:3px"><option value="">Loading phones…</option></select>'
          + '<div id="cfg-device-note" style="font-size:10px;color:#6b7280;margin-top:4px;line-height:1.45"></div>'
        + '</div>'
        + '<div style="display:flex;gap:8px;margin-bottom:12px">'
          + '<button id="cfg-save" style="flex:1;padding:10px;background:#1769aa;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">💾 Save</button>'
          + '<button id="cfg-test" style="flex:1;padding:10px;background:#1f2937;color:#60a5fa;border:1px solid #374151;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">🔍 Test</button>'
        + '</div>'
        + '<div id="cfg-status" style="font-size:11.5px;min-height:16px;text-align:center"></div>'
        + '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #1f2937">'
          + '<div style="font-size:10px;font-weight:800;color:#4b5563;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Note</div>'
          + '<div style="font-size:10.5px;color:#6b7280;line-height:1.5;margin-bottom:12px">Picture messages (MMS) are not carried over the bridge. An MMS still arrives on the phone, but it will not appear here — that is a limitation, not a fault.</div>'
          + '<div style="font-size:10px;font-weight:800;color:#4b5563;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Reset to defaults</div>'
          + '<button id="cfg-reset" style="width:100%;padding:8px;background:#1f2937;color:#9ca3af;border:1px dashed #374151;border-radius:8px;font-size:12px;cursor:pointer">Reset to built-in defaults</button>'
        + '</div>'
      + '</div>';

    document.body.appendChild(panel);

    document.getElementById('cfg-back').onclick = buildPanel;
    document.getElementById('cfg-dev-refresh').onclick = loadDeviceChoices;
    renderAuthSection();
    loadDeviceChoices();

    document.getElementById('cfg-save').onclick = () => {
      const s = document.getElementById('cfg-server').value.trim().replace(/\/$/, '');
      if (!s) { cfgStatus('⚠️ Server URL is required', '#fbbf24'); return; }
      set('bridge_server', s);
      setTargetDevice(document.getElementById('cfg-device').value);
      cfgStatus('✅ Saved!', '#34d399');
      setTimeout(buildPanel, 700);
    };

    document.getElementById('cfg-test').onclick = async () => {
      cfgStatus('Testing…', '#60a5fa');
      const s = document.getElementById('cfg-server').value.trim().replace(/\/$/, '');
      const k = document.getElementById('cfg-apikey').value.trim();
      try {
        const result = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: `${s}/health`,
            headers: { 'ngrok-skip-browser-warning': '1' },
            timeout: 8000,
            onload: resolve,
            onerror: () => reject(new Error('Could not reach server')),
            ontimeout: () => reject(new Error('Timed out')),
          });
        });
        if (result.status === 200) {
          cfgStatus('✅ Server reachable!', '#34d399');
        } else {
          cfgStatus('⚠️ Server returned ' + result.status, '#fbbf24');
        }
      } catch(e) {
        cfgStatus('❌ ' + (e.message || 'Connection failed'), '#fca5a5');
      }
    };

    document.getElementById('cfg-reset').onclick = () => {
      document.getElementById('cfg-server').value = DEFAULT_SERVER;
      cfgStatus('Reset — click Save to apply', '#9ca3af');
    };
  }

  /**
   * The sign-in half of Bridge Settings: signed-out shows log in / create account, signed-in shows
   * who you are and a way out. An API key can still be pasted, but it lives behind Advanced — it is
   * the fallback for a server without accounts, not the normal way in.
   */
  function renderAuthSection(mode) {
    const wrap = document.getElementById('cfg-auth');
    if (!wrap) return;
    const session = getSession();
    const { apikey } = bridgeCreds();

    if (session && apikey) {
      wrap.innerHTML =
        '<label style="' + L + '">Signed in</label>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;background:#1f2937;border:1px solid #374151;border-radius:7px;padding:8px 10px;margin-top:3px">'
          + '<div><div style="color:#d1d5db;font-weight:700;font-size:12.5px">' + esc(session.username)
            + (session.role === 'admin' ? '<span style="font-size:9.5px;color:#60a5fa;border:1px solid #1e3a5f;border-radius:4px;padding:0 4px;margin-left:6px">admin</span>' : '')
          + '</div>'
          + '<div style="color:#6b7280;font-size:10.5px">account ' + esc(session.account_id) + '</div></div>'
          + '<button id="cfg-logout" style="background:none;border:1px solid #374151;color:#9ca3af;border-radius:6px;font-size:11px;cursor:pointer;padding:4px 8px">Sign out</button>'
        + '</div>';
      document.getElementById('cfg-logout').onclick = () => {
        clearSession();
        cfgStatus('Signed out', '#9ca3af');
        renderAuthSection();
        loadDeviceChoices();
      };
      return;
    }

    if (mode === 'apikey') {
      wrap.innerHTML =
        '<label style="' + L + '">API key</label>'
        + '<input id="cfg-apikey" value="' + esc(apikey) + '" type="password" placeholder="paste an API key" style="' + I + ';margin-top:3px">'
        + '<div style="display:flex;gap:6px;margin-top:8px">'
          + '<button id="cfg-key-save" style="flex:1;padding:8px;background:#1769aa;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">Use this key</button>'
          + '<button id="cfg-key-cancel" style="padding:8px 10px;background:#1f2937;color:#9ca3af;border:1px solid #374151;border-radius:7px;font-size:12px;cursor:pointer">Back</button>'
        + '</div>';
      document.getElementById('cfg-key-save').onclick = () => {
        const k = document.getElementById('cfg-apikey').value.trim();
        if (!k) { cfgStatus('⚠️ Enter a key or sign in instead', '#fbbf24'); return; }
        set('bridge_apikey', k);
        setSession(null);
        cfgStatus('✅ Key saved', '#34d399');
        refreshSession().then(() => { renderAuthSection(); loadDeviceChoices(); });
      };
      document.getElementById('cfg-key-cancel').onclick = () => renderAuthSection();
      return;
    }

    const registering = mode === 'register';
    wrap.innerHTML =
      '<label style="' + L + '">' + (registering ? 'Create an account' : 'Sign in') + '</label>'
      + '<input id="cfg-user" placeholder="username" autocomplete="username" style="' + I + ';margin-top:3px">'
      + '<input id="cfg-pass" type="password" placeholder="password" autocomplete="current-password" style="' + I + ';margin-top:6px">'
      + (registering ? '<div style="font-size:10px;color:#6b7280;margin-top:4px;line-height:1.45">At least 10 characters. New accounts need approving by the server administrator before they can sign in.</div>' : '')
      + '<button id="cfg-auth-go" style="width:100%;margin-top:8px;padding:9px;background:#1769aa;color:#fff;border:none;border-radius:7px;font-size:12.5px;font-weight:700;cursor:pointer">'
        + (registering ? 'Request an account' : 'Sign in') + '</button>'
      + '<div style="display:flex;justify-content:space-between;margin-top:7px">'
        + '<button id="cfg-auth-swap" style="background:none;border:none;color:#60a5fa;font-size:11px;cursor:pointer;padding:0">'
          + (registering ? '← Sign in instead' : 'Create an account →') + '</button>'
        + '<button id="cfg-auth-key" style="background:none;border:none;color:#6b7280;font-size:11px;cursor:pointer;padding:0">Use an API key</button>'
      + '</div>';

    document.getElementById('cfg-auth-swap').onclick = () => renderAuthSection(registering ? null : 'register');
    document.getElementById('cfg-auth-key').onclick  = () => renderAuthSection('apikey');

    document.getElementById('cfg-auth-go').onclick = async () => {
      const btn  = document.getElementById('cfg-auth-go');
      const user = document.getElementById('cfg-user').value.trim();
      const pass = document.getElementById('cfg-pass').value;
      if (!user || !pass) { cfgStatus('⚠️ Enter a username and password', '#fbbf24'); return; }

      // Save the URL first — signing in needs somewhere to sign in to.
      const s = document.getElementById('cfg-server').value.trim().replace(/\/$/, '');
      if (!s) { cfgStatus('⚠️ Enter the server URL first', '#fbbf24'); return; }
      set('bridge_server', s);

      btn.disabled = true; btn.textContent = registering ? 'Requesting…' : 'Signing in…';
      try {
        if (registering) {
          const res = await doRegister(user, pass);
          cfgStatus(res.pending ? '✅ Requested — waiting for approval' : '✅ Account created, sign in now', '#34d399');
          renderAuthSection();
        } else {
          await doLogin(user, pass);
          cfgStatus('✅ Signed in', '#34d399');
          renderAuthSection();
          loadDeviceChoices();
        }
      } catch (e) {
        // PENDING is the expected state for a new account, not a failure — say so in those words.
        cfgStatus((e.code === 'PENDING' ? '⏳ ' : '❌ ') + (e.message || 'Could not sign in'),
                  e.code === 'PENDING' ? '#fbbf24' : '#fca5a5');
        btn.disabled = false; btn.textContent = registering ? 'Request an account' : 'Sign in';
      }
    };
  }

  function cfgStatus(msg, color) {
    const el = document.getElementById('cfg-status');
    if (el) { el.textContent = msg; el.style.color = color; }
  }

  /**
   * Fills the "Send through" picker from the server's paired devices. With one phone the choice is
   * made automatically — the picker only earns its keep once there are two, which is exactly when
   * guessing would start sending customers' messages from the wrong handset.
   */
  async function loadDeviceChoices() {
    const sel  = document.getElementById('cfg-device');
    const note = document.getElementById('cfg-device-note');
    if (!sel) return;

    const opt = (value, label, selected) =>
      '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';

    try {
      const { devices, defaultId } = await fetchPairedDevices();
      const current = getTargetDevice();

      if (!devices.length) {
        sel.innerHTML = opt('', 'No phones paired');
        note.textContent = 'Pair a phone with 🔗 Pair Device before sending.';
        note.style.color = '#fbbf24';
        return;
      }

      // Exactly one phone: bind to it rather than leaving the choice to the server, so adding a
      // second phone later cannot silently redirect this PC's messages.
      const chosen = current || (devices.length === 1 ? devices[0].device_id : defaultId);

      sel.innerHTML = devices.map(d => {
        const short = (d.device_id || '').slice(0, 8);
        const flags = [!d.public_key && 'no key', d.device_id === defaultId && 'server default'].filter(Boolean);
        return opt(d.device_id, (d.label || 'Phone') + ' · ' + short + (flags.length ? ' (' + flags.join(', ') + ')' : ''),
                   d.device_id === chosen);
      }).join('');

      if (chosen && chosen !== current) setTargetDevice(chosen);

      const picked = devices.find(d => d.device_id === chosen);
      if (picked && !picked.public_key) {
        note.textContent = 'This phone has no encryption key — re-pair it before sending.';
        note.style.color = '#fbbf24';
      } else {
        note.textContent = devices.length === 1
          ? 'One phone paired. Messages from this PC go to it.'
          : devices.length + ' phones paired — this PC sends through the one selected above.';
        note.style.color = '#6b7280';
      }
    } catch (e) {
      sel.innerHTML = opt(getTargetDevice(), getTargetDevice() ? 'Saved phone (offline)' : 'Could not load phones');
      note.textContent = '❌ ' + (e.message || 'Could not reach the server');
      note.style.color = '#fca5a5';
    }
  }

  // ── Admin panel ─────────────────────────────────────────────────────────────
  //
  // Only reachable when the signed-in user is an admin — the button isn't rendered otherwise, and
  // the server returns 404 on these routes to anyone else, so hiding the button is convenience
  // rather than the control.

  function buildAdminPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">👤 Administration</span>'
        + '<div style="display:flex;gap:8px;align-items:center">'
          + '<button id="adm-refresh" style="background:none;border:none;color:#60a5fa;font-size:11px;cursor:pointer">↻</button>'
          + '<button id="adm-back" style="background:none;border:none;color:#60a5fa;font-size:12px;font-weight:700;cursor:pointer">← Back</button>'
        + '</div>'
      + '</div>'
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<div style="font-size:10px;font-weight:800;color:#4b5563;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Waiting for approval</div>'
        + '<div id="adm-pending" style="font-size:11.5px;color:#9ca3af">Loading…</div>'
      + '</div>'
      + '<div style="padding:11px 14px">'
        + '<div style="font-size:10px;font-weight:800;color:#4b5563;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Everyone</div>'
        + '<div id="adm-users" style="font-size:11.5px;color:#9ca3af">Loading…</div>'
        + '<div id="adm-status" style="font-size:11.5px;min-height:16px;text-align:center;margin-top:8px"></div>'
      + '</div>';
    document.body.appendChild(panel);

    document.getElementById('adm-back').onclick    = buildPanel;
    document.getElementById('adm-refresh').onclick = loadAdmin;
    loadAdmin();
  }

  function admStatus(msg, color) {
    const el = document.getElementById('adm-status');
    if (el) { el.textContent = msg; el.style.color = color; }
  }

  async function setUserStatus(id, status) {
    const { server, apikey } = bridgeCreds();
    const data = await apiRequest(server, apikey,
      '/api/tools/sms-bridge/admin/users/' + encodeURIComponent(id) + '/status', 'POST', { status });
    if (!data.ok) throw new Error(data.error || 'Could not update that account');
    return data;
  }

  async function loadAdmin() {
    const pendWrap = document.getElementById('adm-pending');
    const allWrap  = document.getElementById('adm-users');
    if (!pendWrap) return;

    const { server, apikey } = bridgeCreds();
    let users;
    try {
      const data = await apiRequest(server, apikey, '/api/tools/sms-bridge/admin/users', 'GET');
      users = data.users || [];
    } catch (e) {
      pendWrap.innerHTML = '<span style="color:#fca5a5">❌ ' + esc(e.message || 'Could not load') + '</span>';
      allWrap.textContent = '';
      return;
    }

    const pending = users.filter(u => u.status === 'pending');
    const me      = getSession();

    pendWrap.innerHTML = pending.length ? pending.map(u =>
      '<div style="background:#1f2937;border:1px solid #374151;border-radius:8px;padding:8px 10px;margin-bottom:7px">'
        + '<div style="color:#d1d5db;font-weight:700">' + esc(u.username) + '</div>'
        + '<div style="color:#6b7280;font-size:10.5px;margin-bottom:6px">requested ' + esc(u.created_at || '') + '</div>'
        + '<div style="display:flex;gap:6px">'
          + '<button class="adm-act" data-id="' + u.id + '" data-status="active" style="flex:1;padding:5px;background:#064e3b;color:#6ee7b7;border:1px solid #065f46;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">✓ Approve</button>'
          + '<button class="adm-act" data-id="' + u.id + '" data-status="denied" style="flex:1;padding:5px;background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">✕ Deny</button>'
        + '</div>'
      + '</div>').join('')
      : '<div style="color:#4b5563;padding:6px 0">Nothing waiting.</div>';

    allWrap.innerHTML = users.map(u => {
      const isMe  = me && u.username === me.username;
      const tint  = { active: '#6ee7b7', pending: '#fbbf24', denied: '#9ca3af', suspended: '#fca5a5' }[u.status] || '#9ca3af';
      // Never offer an action that would lock yourself out; the server refuses it anyway.
      const action = isMe ? ''
        : u.status === 'active'
          ? '<button class="adm-act" data-id="' + u.id + '" data-status="suspended" style="background:none;border:1px solid #374151;color:#9ca3af;border-radius:6px;font-size:10.5px;cursor:pointer;padding:3px 7px">Suspend</button>'
          : '<button class="adm-act" data-id="' + u.id + '" data-status="active" style="background:none;border:1px solid #374151;color:#6ee7b7;border-radius:6px;font-size:10.5px;cursor:pointer;padding:3px 7px">Activate</button>';
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #1f2937">'
        + '<div style="min-width:0"><div style="color:#d1d5db;font-weight:600">' + esc(u.username)
          + (u.role === 'admin' ? '<span style="font-size:9px;color:#60a5fa;margin-left:5px">admin</span>' : '')
          + (isMe ? '<span style="font-size:9px;color:#6b7280;margin-left:5px">you</span>' : '')
        + '</div>'
        + '<div style="font-size:10.5px;color:' + tint + '">' + esc(u.status) + ' · account ' + esc(u.account_id) + '</div></div>'
        + action
      + '</div>';
    }).join('');

    panel.querySelectorAll('.adm-act').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        const res = await setUserStatus(b.dataset.id, b.dataset.status);
        admStatus('✅ ' + res.user.username + ' is now ' + res.user.status, '#34d399');
        loadAdmin();
      } catch (e) {
        admStatus('❌ ' + (e.message || 'Could not update'), '#fca5a5');
        b.disabled = false;
      }
    });
  }

  // ── Pair device panel ───────────────────────────────────────────────────────

  function buildPairPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    const { server } = bridgeCreds();
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">🔗 Pair Device</span>'
        + '<button id="pair-back" style="background:none;border:none;color:#60a5fa;font-size:12px;font-weight:700;cursor:pointer">← Back</button>'
      + '</div>'
      + '<div style="padding:14px">'
        + '<div style="font-size:10.5px;color:#6b7280;margin-bottom:10px;line-height:1.5">Generate a pairing code to link a new Android device. Each code expires in 15 minutes.</div>'
        + '<div style="font-size:10.5px;color:#888;background:#1f2937;padding:6px 10px;border-radius:6px;margin-bottom:12px;word-break:break-all">🌐 Server: ' + esc(server || 'not set') + '</div>'
        + '<button id="pair-gen" style="width:100%;padding:10px;background:#1769aa;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Generate Pairing Code</button>'
        + '<div id="pair-code-wrap" style="display:none">'
          + '<div id="pair-code" style="font-family:monospace;font-size:22px;font-weight:800;text-align:center;letter-spacing:4px;color:#60a5fa;padding:10px;background:#0d1a2b;border-radius:8px;margin:12px 0">--------</div>'
          + '<p style="font-size:11px;color:#9ca3af;margin:4px 0;text-align:center">1. Open SOS Messenger on Android</p>'
          + '<p style="font-size:11px;color:#9ca3af;margin:4px 0;text-align:center">2. Computer Bridge → Unlink &amp; re-pair</p>'
          + '<p style="font-size:11px;color:#9ca3af;margin:4px 0;text-align:center">3. Enter the server URL, API key and the code above</p>'
          + '<p style="font-size:10.5px;color:#fbbf24;margin:8px 0 0;text-align:center">The phone must show “Linked.” — if it reports a pairing failure, generate a new code and try again.</p>'
        + '</div>'
        + '<div id="pair-status" style="font-size:11.5px;min-height:16px;text-align:center;margin-top:8px"></div>'
        + '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #1f2937">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
            + '<span style="font-size:10px;font-weight:800;color:#4b5563;text-transform:uppercase;letter-spacing:.08em">Linked devices</span>'
            + '<button id="pair-refresh" style="background:none;border:none;color:#60a5fa;font-size:11px;cursor:pointer">↻ Refresh</button>'
          + '</div>'
          + '<div id="pair-devices" style="font-size:11.5px;color:#9ca3af">Loading…</div>'
        + '</div>'
      + '</div>';

    document.body.appendChild(panel);
    document.getElementById('pair-back').onclick = buildPanel;

    document.getElementById('pair-gen').onclick = async () => {
      const btn = document.getElementById('pair-gen');
      const st  = document.getElementById('pair-status');
      btn.disabled = true; btn.textContent = 'Generating…';
      st.textContent = ''; st.style.color = '';
      try {
        const code = await generatePairingCode();
        document.getElementById('pair-code').textContent = code;
        document.getElementById('pair-code-wrap').style.display = 'block';
      } catch (e) {
        st.textContent = '❌ ' + (e.message || 'Could not generate code');
        st.style.color = '#fca5a5';
      } finally {
        btn.disabled = false; btn.textContent = 'Generate Pairing Code';
      }
    };

    const refreshDevices = async () => {
      const list = document.getElementById('pair-devices');
      list.textContent = 'Loading…';
      try {
        const { devices, defaultId } = await fetchPairedDevices();
        if (!devices.length) { list.textContent = 'No devices linked yet'; return; }
        list.innerHTML = devices.map(d => {
          // A device with no public key is the stale-pairing symptom: the server can't encrypt to
          // it, so every send to it is refused until the phone pairs again.
          const warn = d.public_key ? '' :
            '<div style="color:#fbbf24;font-size:10px;margin-top:2px">⚠ no encryption key — re-pair this phone</div>';
          const tag = d.device_id === defaultId
            ? '<span style="font-size:9.5px;color:#60a5fa;border:1px solid #1e3a5f;border-radius:4px;padding:0 4px;margin-left:5px">default</span>' : '';
          return '<div style="padding:7px 0;border-bottom:1px solid #1f2937;display:flex;gap:8px;align-items:flex-start">'
            + '<div style="flex:1;min-width:0">'
              + '<div style="color:#d1d5db;font-weight:600">' + esc(d.label || 'Phone') + tag + '</div>'
              + '<div style="color:#6b7280;font-size:10.5px">' + esc((d.device_id || '').substring(0, 8)) + '… · last seen ' + esc(d.last_seen || '—') + '</div>'
              + warn
            + '</div>'
            + '<button class="pair-del" data-id="' + esc(d.device_id) + '" title="Remove this phone" '
              + 'style="background:none;border:none;color:#6b7280;font-size:14px;cursor:pointer;padding:2px 4px;flex-shrink:0">🗑</button>'
          + '</div>';
        }).join('');

        list.querySelectorAll('.pair-del').forEach(b => b.onclick = async () => {
          const id = b.dataset.id;
          if (!confirm('Remove this phone?\n\nAnything still queued for it will be marked failed.')) return;
          b.disabled = true;
          try {
            const res = await deletePairedDevice(id);
            const st = document.getElementById('pair-status');
            st.style.color = '#34d399';
            st.textContent = '✅ Removed' + (res.failed_messages ? ` · ${res.failed_messages} queued message(s) failed` : '');
            refreshDevices();
          } catch (e) {
            const st = document.getElementById('pair-status');
            st.style.color = '#fca5a5'; st.textContent = '❌ ' + (e.message || 'Could not remove device');
            b.disabled = false;
          }
        });
      } catch (e) {
        list.textContent = '❌ ' + (e.message || 'Could not load devices');
      }
    };

    document.getElementById('pair-refresh').onclick = refreshDevices;
    refreshDevices();
  }

  // ── Inbox panel (customer replies) ──────────────────────────────────────────

  function buildInboxPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">📥 Replies</span>'
        + '<div style="display:flex;gap:8px;align-items:center">'
          + '<button id="inbox-refresh" style="background:none;border:none;color:#60a5fa;font-size:11px;cursor:pointer">↻</button>'
          + '<button id="inbox-back" style="background:none;border:none;color:#60a5fa;font-size:12px;font-weight:700;cursor:pointer">← Back</button>'
        + '</div>'
      + '</div>'
      + '<div id="inbox-list" style="padding:10px 14px 14px;color:#9ca3af;font-size:12px">Loading…</div>';
    document.body.appendChild(panel);

    document.getElementById('inbox-back').onclick    = buildPanel;
    document.getElementById('inbox-refresh').onclick = loadInbox;
    loadInbox();
  }

  async function loadInbox() {
    const wrap = document.getElementById('inbox-list');
    if (!wrap) return;
    wrap.textContent = 'Loading…';

    const { server, apikey } = bridgeCreds();
    if (!server || !apikey) { wrap.textContent = 'Set the server URL and API key in ⚙️ Bridge Settings first.'; return; }

    let keys, myKeyId, rows;
    try {
      keys    = await registerClientKey();
      myKeyId = await clientKeyId(keys.publicB64);
      const data = await apiRequest(server, apikey, '/api/tools/sms-bridge/incoming', 'GET');
      rows = data.messages || [];
    } catch (e) {
      wrap.innerHTML = '<div style="color:#fca5a5">❌ ' + esc(e.message || 'Could not load replies') + '</div>';
      return;
    }

    if (!rows.length) {
      wrap.innerHTML = '<div style="text-align:center;color:#4b5563;padding:26px 0;line-height:1.6">No replies yet.<br>'
        + '<span style="font-size:11px">Incoming texts to the bridge phone appear here.</span></div>';
      return;
    }

    const cards = [];
    for (const row of rows) {
      let text, note = '';
      if (row.e2e) {
        const envelope = row.envelopes && row.envelopes[myKeyId];
        if (!envelope) {
          // Encrypted for other desktops only — this PC registered its key after the reply arrived.
          text = '🔒 Encrypted for another PC';
          note = 'This reply arrived before this PC registered its key. It can only be read on a PC that was registered at the time.';
        } else {
          try { text = await decryptEnvelope(envelope, keys.privateJwk); }
          catch (_) { text = '🔒 Could not decrypt'; note = 'The stored key no longer matches. Replies sent before this PC\'s key changed cannot be recovered.'; }
        }
      } else {
        // Legacy row: the server decrypted this one, so it was readable in transit on the server.
        text = row.message || '';
        note = 'Sent by an older phone app — the server could read this one. Update the phone to close that gap.';
      }

      cards.push(
        '<div style="background:#1f2937;border:1px solid #374151;border-radius:9px;padding:9px 11px;margin-bottom:8px">'
          + '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:4px">'
            + '<span style="font-weight:700;color:#93c5fd;font-size:12.5px">' + esc(row.sender || 'Unknown') + '</span>'
            + '<span style="font-size:10px;color:#6b7280;white-space:nowrap">' + esc(row.received_at || '') + '</span>'
          + '</div>'
          + '<div style="font-size:12px;color:#d1d5db;white-space:pre-wrap;line-height:1.45;background:#111827;border-radius:6px;padding:7px 9px">' + esc(text) + '</div>'
          + (note ? '<div style="font-size:10px;color:#fbbf24;margin-top:5px;line-height:1.4">⚠ ' + esc(note) + '</div>' : '')
          + '<button class="inbox-reply" data-phone="' + esc(row.sender || '') + '" style="width:100%;margin-top:7px;padding:5px;background:#111827;color:#60a5fa;border:1px solid #374151;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">↩ Reply</button>'
        + '</div>');
    }

    wrap.innerHTML = cards.join('');
    wrap.querySelectorAll('.inbox-reply').forEach(b => b.onclick = () => {
      _prefill = { phone: b.dataset.phone, message: '' };
      buildPanel();
    });
  }

  // ── Sent history panel ──────────────────────────────────────────────────────

  function buildHistoryPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">📜 Sent History</span>'
        + '<button id="hist-back" style="background:none;border:none;color:#60a5fa;font-size:12px;font-weight:700;cursor:pointer">← Back</button>'
      + '</div>'
      + '<div style="padding:9px 14px;border-bottom:1px solid #1f2937;display:flex;gap:6px;align-items:center">'
        + '<input id="hist-search" placeholder="🔍 Search name, phone, ticket, text…" style="' + I + ';flex:1">'
      + '</div>'
      + '<div id="hist-list" style="padding:8px 14px 4px"></div>'
      + '<div style="padding:2px 14px 14px">'
        + '<button id="hist-export" style="width:100%;padding:8px;background:#1f2937;color:#60a5fa;border:1px solid #374151;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">⬇ Export</button>'
      + '</div>';
    document.body.appendChild(panel);

    document.getElementById('hist-back').onclick = buildPanel;
    document.getElementById('hist-search').oninput = e => renderHistoryList(e.target.value.trim().toLowerCase());

    document.getElementById('hist-export').onclick = () => {
      const h = getHistory();
      if (!h.length) { flash('⚠️ Nothing to export'); return; }
      const lines = h.map(e =>
        [absTime(e.ts), e.ticket, e.name, e.phone, JSON.stringify(e.message || '')].join('\t')
      );
      const blob = 'Sent At\tTicket\tName\tPhone\tMessage\n' + lines.join('\n');
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([blob], { type: 'text/tab-separated-values' }));
        a.download = 'sos-sms-history-' + new Date().toISOString().slice(0, 10) + '.tsv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } catch (_) {}
    };

    renderHistoryList('');
  }

  function renderHistoryList(query) {
    const wrap = document.getElementById('hist-list');
    if (!wrap) return;
    const all = getHistory();

    if (!all.length) {
      wrap.innerHTML = '<div style="text-align:center;color:#4b5563;font-size:12px;padding:26px 0;line-height:1.6">No messages sent yet.<br><span style="font-size:11px">Sends will appear here automatically.</span></div>';
      return;
    }

    const items = query
      ? all.filter(e => (e.name + ' ' + e.phone + ' ' + e.ticket + ' ' + e.device + ' ' + e.message).toLowerCase().includes(query))
      : all;

    if (!items.length) {
      wrap.innerHTML = '<div style="text-align:center;color:#4b5563;font-size:12px;padding:26px 0">No matches for that search.</div>';
      return;
    }

    wrap.innerHTML = items.map((e, i) => {
      const who   = esc(e.name || e.phone || 'Unknown');
      const meta  = [e.ticket && ('#' + e.ticket), e.phone, e.device].filter(Boolean).map(esc).join(' · ');
      const idx   = all.indexOf(e);   // stable index into the full list for actions
      // Older entries predate delivery tracking; absent means "we never knew", not "confirmed".
      const badge = !e.delivery || e.delivery === 'sent' ? ''
        : '<span title="The phone never confirmed sending this" style="font-size:9.5px;font-weight:700;color:#fbbf24;border:1px solid #78350f;background:#451a03;border-radius:4px;padding:1px 5px;white-space:nowrap">⏳ unconfirmed</span>';
      return '<div class="hist-card" style="background:#1f2937;border:1px solid #374151;border-radius:9px;padding:9px 11px;margin-bottom:8px">'
        + '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:3px">'
          + '<span style="font-weight:700;color:#93c5fd;font-size:12.5px">' + who + '</span>'
          + '<span style="display:flex;gap:6px;align-items:baseline;flex-shrink:0">' + badge
            + '<span title="' + esc(absTime(e.ts)) + '" style="font-size:10px;color:#6b7280;white-space:nowrap">' + esc(relTime(e.ts)) + '</span>'
          + '</span>'
        + '</div>'
        + (meta ? '<div style="font-size:10.5px;color:#6b7280;margin-bottom:5px">' + meta + '</div>' : '')
        + '<div style="font-size:12px;color:#d1d5db;white-space:pre-wrap;line-height:1.45;background:#111827;border-radius:6px;padding:7px 9px;max-height:110px;overflow-y:auto">' + esc(e.message || '') + '</div>'
        + '<div style="display:flex;gap:6px;margin-top:7px">'
          + '<button class="hist-resend" data-idx="' + idx + '" style="flex:1;padding:5px;background:#111827;color:#60a5fa;border:1px solid #374151;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">↻ Resend</button>'
          + '<button class="hist-copy"   data-idx="' + idx + '" style="flex:1;padding:5px;background:#111827;color:#9ca3af;border:1px solid #374151;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">⧉ Copy</button>'
        + '</div>'
      + '</div>';
    }).join('');

    wrap.querySelectorAll('.hist-resend').forEach(b => b.onclick = () => {
      const e = getHistory()[+b.dataset.idx]; if (!e) return;
      _prefill = { name: e.name, phone: e.phone, ticket: e.ticket, device: e.device, message: e.message || '' };
      buildPanel();
    });

    wrap.querySelectorAll('.hist-copy').forEach(b => b.onclick = () => {
      const e = getHistory()[+b.dataset.idx]; if (!e) return;
      try { GM_setClipboard(e.message || ''); } catch (_) {
        try { navigator.clipboard.writeText(e.message || ''); } catch (__) {}
      }
      b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = '⧉ Copy'; }, 1200);
    });
  }

  // ── Template editor ─────────────────────────────────────────────────────────

  function buildEditPanel() {
    if (panel) panel.remove();
    panel = null;
    const templates = getTemplates();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">✏️ Edit Templates</span>'
        + '<button id="tpl-back" style="background:none;border:none;color:#60a5fa;font-size:12px;font-weight:700;cursor:pointer">← Back</button>'
      + '</div>'
      + '<div id="tpl-editor" style="padding:10px 14px 4px">' + templates.map(tplBlock).join('') + '</div>'
      + '<div style="padding:0 14px 14px;display:flex;gap:6px"><button id="tpl-add" style="flex:1;padding:8px;background:#1f2937;color:#60a5fa;border:1px dashed #374151;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">+ Add</button><button id="tpl-save" style="flex:1;padding:8px;background:#1769aa;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">💾 Save All</button></div>'
      + '<div id="tpl-msg" style="padding:0 14px 10px;font-size:11.5px;color:#34d399;text-align:center;min-height:16px"></div>';
    document.body.appendChild(panel);
    document.getElementById('tpl-back').onclick = buildPanel;
    document.getElementById('tpl-add').onclick = () => {
      const ed = document.getElementById('tpl-editor');
      const d = document.createElement('div');
      d.innerHTML = tplBlock({id:'tpl_'+Date.now(), name:'New Template', body:''});
      ed.appendChild(d.firstElementChild); wireDelBtns();
    };
    document.getElementById('tpl-save').onclick = () => {
      const upd = [];
      panel.querySelectorAll('.tpl-block').forEach(b => {
        const name = b.querySelector('.tpl-name').value.trim();
        const body = b.querySelector('.tpl-body').value.trim();
        if (name) upd.push({id:b.dataset.id, name, body});
      });
      saveTemplates(upd); document.getElementById('tpl-msg').textContent = '✅ Saved!'; setTimeout(buildPanel, 700);
    };
    wireDelBtns();
  }

  function tplRadio(t, checked) {
    return '<label style="display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:7px;cursor:pointer;transition:all .15s;border:1px solid ' + (checked?'#1769aa':'#1f2937') + ';background:' + (checked?'#1769aa1a':'transparent') + '"><input type="radio" name="sms-tpl" value="' + esc(t.id) + '" ' + (checked?'checked':'') + ' style="accent-color:#60a5fa;cursor:pointer;flex-shrink:0"><span style="font-size:12px;color:#d1d5db;font-weight:' + (checked?'600':'400') + '">' + esc(t.name) + '</span></label>';
  }

  function tplBlock(t) {
    return '<div class="tpl-block" data-id="' + esc(t.id) + '" style="margin-bottom:10px;background:#1f2937;border-radius:9px;border:1px solid #374151;padding:10px 12px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><input class="tpl-name" value="' + esc(t.name) + '" placeholder="Template name" style="background:transparent;border:none;color:#93c5fd;font-size:12px;font-weight:700;outline:none;flex:1;font-family:inherit"><button class="tpl-del" style="background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:0 2px">🗑</button></div><textarea class="tpl-body" rows="3" placeholder="Use {name} {device} {ticket}" style="width:100%;background:#111827;border:1px solid #374151;border-radius:6px;color:#d1d5db;font-size:12px;font-family:inherit;padding:7px 9px;outline:none;resize:vertical;line-height:1.5;box-sizing:border-box">' + esc(t.body) + '</textarea><div style="font-size:10px;color:#4b5563;margin-top:3px">{name} · {device} · {ticket}</div></div>';
  }

  function wireDelBtns() {
    panel.querySelectorAll('.tpl-del').forEach(btn => {
      btn.onclick = () => { if (panel.querySelectorAll('.tpl-block').length <= 1) return; if (confirm('Delete?')) btn.closest('.tpl-block').remove(); };
    });
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  function curVals() {
    return {
      ticket: (document.getElementById('sms-ticket') && document.getElementById('sms-ticket').value || '').toUpperCase().trim(),
      name:   ((document.getElementById('sms-name') && document.getElementById('sms-name').value || '').trim().split(' ')[0]),
      phone:  (document.getElementById('sms-phone') && document.getElementById('sms-phone').value || '').trim(),
      device: (document.getElementById('sms-device') && document.getElementById('sms-device').value || '').trim(),
    };
  }
  function syncPreview() {
    if (_lockBody) { countChars(); return; }   // Resend has pinned the message box
    const tpl = getTemplates().find(t => t.id === get('lastTplId',''));
    if (tpl) { const b = document.getElementById('sms-body'); if (b) b.value = applyVars(tpl.body, curVals()); }
    countChars();
  }
  function countChars() {
    const b = document.getElementById('sms-body'); const c = document.getElementById('sms-chars'); if (!b||!c) return;
    const n = b.value.length; c.textContent = n > 160 ? n + ' (' + Math.ceil(n/153) + ' SMS)' : n + ' / 160';
    c.style.color = n > 160 ? '#fbbf24' : '#6b7280';
  }
  function setF(id, v) { const e = document.getElementById(id); if (e && v) e.value = v; }

  function readFromPage() {
    const data = {ticket:'', name:'', phone:'', device:''};
    const urlStr = location.pathname + location.search + location.hash;
    const urlM = urlStr.match(/[Aa](\d{3,6})/);
    if (urlM) data.ticket = 'A' + urlM[1];
    return data;
  }
  function applyVars(t, v) {
    return (t||'').replace(/\{ticket\}/gi, v.ticket||'').replace(/\{name\}/gi, v.name||'').replace(/\{device\}/gi, v.device||'');
  }
  function normalizePhone(p) {
    const d = p.replace(/\D/g,'');
    if (d.startsWith('61')) return '+' + d;
    if (d.startsWith('0'))  return '+61' + d.slice(1);
    return '+61' + d;
  }
  function flash(msg) {
    const old = document.getElementById('sos-flash'); if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'sos-flash';
    el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999999;background:#450a0a;border:1px solid #7f1d1d;border-radius:8px;padding:10px 18px;color:#fca5a5;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4);';
    el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 2500);
  }
  function esc(s) { return String(s||'').replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c])); }

  const L  = 'display:block;font-size:10.5px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px';
  const I  = 'width:100%;padding:7px 10px;border-radius:7px;border:1px solid #374151;background:#1f2937;color:#e5e7eb;font-size:12.5px;font-family:inherit;outline:none;box-sizing:border-box';
  const IB = 'background:none;border:none;color:#6b7280;font-size:17px;cursor:pointer;padding:2px 4px;line-height:1;border-radius:4px';

})();
