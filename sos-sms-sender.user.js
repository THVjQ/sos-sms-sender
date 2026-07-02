// ==UserScript==
// @name         SOS SMS Sender
// @namespace    https://sosphonerepairs.com.au
// @version      17.0
// @description  Send SMS to customers via SOS Messenger (SMS Bridge)
// @author       SOS Phone Repairs
// @match        https://app.sospos.com.au/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
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

  // ── Progress overlay ────────────────────────────────────────────────────────

  let progressEl = null;

  function showProgress(step, pct, error) {
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
      errEl.innerHTML = '<b>Error:</b> ' + esc(error) + '<br><br><span style="color:#9ca3af">Make sure the SOS Messenger server is running and the bridge is configured correctly.</span>';
      closeBtn.style.display = 'inline-block';
      return;
    }
    bar.style.width = pct + '%'; stepEl.textContent = step;
    if (pct >= 100) {
      icon.textContent = '✅'; stepEl.style.color = '#34d399';
      stepEl.textContent = '✅ Message queued for delivery!';
      setTimeout(() => { progressEl && progressEl.remove(); progressEl = null; }, 1800);
    }
  }

  // ── SOS Messenger bridge send ───────────────────────────────────────────────

  async function sendViaBridge(phone, message) {
    const server = get('bridge_server', DEFAULT_SERVER).replace(/\/$/, '');
    const apikey = get('bridge_apikey', DEFAULT_APIKEY);
    if (!server || !apikey) {
      showProgress('', 0, 'SOS Messenger not configured. Click ⚙️ in the SMS panel to set the server URL and API key.');
      return;
    }

    showProgress('Connecting to SOS Messenger…', 25);
    await sleep(300);

    const result = await new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method:  'POST',
          url:     `${server}/api/tools/sms-bridge/send`,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key':    apikey,
            'ngrok-skip-browser-warning': '1',
          },
          data:    JSON.stringify({ phone, message }),
          timeout: 15000,
          onload:    resolve,
          onerror:   () => reject(new Error('Network error — is the SOS Messenger server running?')),
          ontimeout: () => reject(new Error('Request timed out — check the server URL and your internet connection.')),
        });
      } catch (e) { reject(e); }
    });

    showProgress('Processing response…', 65);
    await sleep(200);

    let data;
    try { data = JSON.parse(result.responseText); } catch (_) {
      throw new Error(`Server returned invalid JSON (HTTP ${result.status})`);
    }

    if (result.status === 401 || result.status === 403) {
      throw new Error('Authentication failed — check your API key in ⚙️ Settings.');
    }
    if (!data.ok) {
      throw new Error(data.error || `Server error (HTTP ${result.status})`);
    }

    showProgress('Message queued!', 100);
  }

  // ── FAB + panel ─────────────────────────────────────────────────────────────

  function initSOSPOS() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { addFAB(); setInterval(addFAB, 2000); });
    } else {
      addFAB(); setInterval(addFAB, 2000);
    }
  }

  initSOSPOS();

  let panel = null;

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

  // ── Panel builder ───────────────────────────────────────────────────────────

  function buildPanel() {
    if (panel) panel.remove();
    const templates   = getTemplates();
    const savedTplId  = get('lastTplId', templates[0] && templates[0].id || 't1');
    const tpl         = templates.find(t => t.id === savedTplId) || templates[0];
    const d           = readFromPage();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">💬 Send SMS</span>'
        + '<div style="display:flex;gap:3px"><button id="sms-cfg-btn" title="Bridge settings" style="' + IB + '">⚙️</button><button id="sms-tpl-btn" title="Edit templates" style="' + IB + '">✏️</button><button id="sms-close" style="' + IB + '">✕</button></div>'
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
  }

  function wirePanelEvents() {
    document.getElementById('sms-close').onclick    = () => { panel.remove(); panel = null; };
    document.getElementById('sms-tpl-btn').onclick  = buildEditPanel;
    document.getElementById('sms-cfg-btn').onclick  = buildSettingsPanel;

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
      try {
        await sendViaBridge(normalizePhone(v.phone), message);
      } catch (e) {
        console.error('[SOS SMS]', e);
        showProgress('', 0, e.message || 'Unknown error');
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
    const curKey    = get('bridge_apikey', DEFAULT_APIKEY);
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">⚙️ Bridge Settings</span>'
        + '<button id="cfg-back" style="background:none;border:none;color:#60a5fa;font-size:12px;font-weight:700;cursor:pointer">← Back</button>'
      + '</div>'
      + '<div style="padding:14px">'
        + '<div style="font-size:10.5px;color:#6b7280;margin-bottom:14px;line-height:1.5">Configure the SOS Messenger server URL and API key. Changes apply immediately.</div>'
        + '<div style="margin-bottom:12px">'
          + '<label style="' + L + '">Server URL</label>'
          + '<input id="cfg-server" value="' + esc(curServer) + '" placeholder="https://..." style="' + I + ';margin-top:3px">'
        + '</div>'
        + '<div style="margin-bottom:16px">'
          + '<label style="' + L + '">API Key</label>'
          + '<input id="cfg-apikey" value="' + esc(curKey) + '" type="password" placeholder="your api key" style="' + I + ';margin-top:3px">'
        + '</div>'
        + '<div style="display:flex;gap:8px;margin-bottom:12px">'
          + '<button id="cfg-save" style="flex:1;padding:10px;background:#1769aa;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">💾 Save</button>'
          + '<button id="cfg-test" style="flex:1;padding:10px;background:#1f2937;color:#60a5fa;border:1px solid #374151;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">🔍 Test</button>'
        + '</div>'
        + '<div id="cfg-status" style="font-size:11.5px;min-height:16px;text-align:center"></div>'
        + '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #1f2937">'
          + '<div style="font-size:10px;font-weight:800;color:#4b5563;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Reset to defaults</div>'
          + '<button id="cfg-reset" style="width:100%;padding:8px;background:#1f2937;color:#9ca3af;border:1px dashed #374151;border-radius:8px;font-size:12px;cursor:pointer">Reset to built-in defaults</button>'
        + '</div>'
      + '</div>';

    document.body.appendChild(panel);

    document.getElementById('cfg-back').onclick = buildPanel;

    document.getElementById('cfg-save').onclick = () => {
      const s = document.getElementById('cfg-server').value.trim().replace(/\/$/, '');
      const k = document.getElementById('cfg-apikey').value.trim();
      if (!s) { cfgStatus('⚠️ Server URL is required', '#fbbf24'); return; }
      if (!k) { cfgStatus('⚠️ API key is required', '#fbbf24'); return; }
      set('bridge_server', s);
      set('bridge_apikey', k);
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
      document.getElementById('cfg-apikey').value = DEFAULT_APIKEY;
      cfgStatus('Reset — click Save to apply', '#9ca3af');
    };
  }

  function cfgStatus(msg, color) {
    const el = document.getElementById('cfg-status');
    if (el) { el.textContent = msg; el.style.color = color; }
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
