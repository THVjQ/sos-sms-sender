// ==UserScript==
// @name         SOS SMS Sender v31
// @namespace    https://sosphonerepairs.com.au
// @version      16.4
// @description  Send SMS to customers via Google Messages Web
// @author       SOS Phone Repairs
// @match        https://app.sospos.com.au/*
// @match        https://messages.google.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      app.sospos.com.au
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const get   = (k, d) => { try { const v = GM_getValue(k, null); return v !== null ? v : d; } catch { return d; } };
  const set   = (k, v) => { try { GM_setValue(k, v); } catch {} };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const isSOSPOS   = location.hostname.includes('sospos.com.au');
  const isMessages = location.hostname.includes('messages.google.com');

  if      (isSOSPOS)   initSOSPOS();
  else if (isMessages) initMessages();

  // ── Shadow DOM helpers ──────────────────────────────────────────────────────

  function deepQuery(root, selector) {
    try { const el = root.querySelector(selector); if (el) return el; } catch {}
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const f = deepQuery(el.shadowRoot, selector); if (f) return f; }
    }
    return null;
  }

  function deepQueryByText(root, text) {
    const lower = text.toLowerCase();
    for (const el of root.querySelectorAll('button,a,[role="button"]')) {
      if (el.textContent.trim().toLowerCase().includes(lower)) return el;
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const f = deepQueryByText(el.shadowRoot, text); if (f) return f; }
    }
    return null;
  }

  async function waitForDeep(selectors, timeout, textFallbacks) {
    timeout = timeout || 12000;
    textFallbacks = textFallbacks || [];
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        try { const el = deepQuery(document, sel); if (el) return el; } catch {}
      }
      for (const txt of textFallbacks) {
        const el = deepQueryByText(document, txt); if (el) return el;
      }
      await sleep(250);
    }
    return null;
  }

  async function waitForEnabledSend(timeout) {
    timeout = timeout || 8000;
    const selectors = [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send"]',
      'mws-message-compose button[type="submit"]',
      'mws-message-compose button',
      '.send-button',
    ];
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        try {
          const el = deepQuery(document, sel);
          if (el && !el.disabled && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') return el;
        } catch {}
      }
      await sleep(200);
    }
    return null;
  }

  // ── Progress (GM storage polling — postMessage blocked cross-origin) ────────

  let _poll = null;
  function startProgressPolling(sendTime) {
    if (_poll) clearInterval(_poll);
    _poll = setInterval(() => {
      const u = get('sms_progress', null);
      if (u && u.ts > sendTime) {
        showProgress(u.step, u.pct, u.error || null);
        if (u.pct >= 100 || u.error) {
          clearInterval(_poll); _poll = null;
          set('sms_progress', null);
        }
      }
    }, 350);
    setTimeout(() => { if (_poll) { clearInterval(_poll); _poll = null; } }, 90000);
  }

  function progress(step, pct, error) {
    set('sms_progress', { step, pct, error: error || null, ts: Date.now() });
  }

  // ── Input helpers ───────────────────────────────────────────────────────────

  function forceType(el, text) {
    el.focus();
    const proto  = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, text); else el.value = text;
    ['input','change','keydown','keyup'].forEach(t => el.dispatchEvent(new Event(t, {bubbles:true})));
  }

  function typeContentEditable(el, text) {
    el.focus();
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch(_) {}
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, text);
    } catch(_) {}
    if ((el.textContent || el.innerText || '').trim()) {
      el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
      return;
    }
    try {
      el.innerHTML = '';
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', {clipboardData:dt, bubbles:true, cancelable:true}));
    } catch(_) {}
    if ((el.textContent || '').trim()) {
      el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
      return;
    }
    try {
      el.innerHTML = '';
      const tn = document.createTextNode(text);
      el.appendChild(tn);
      const r2 = document.createRange();
      r2.setStartAfter(tn); r2.collapse(true);
      const sel2 = window.getSelection();
      sel2.removeAllRanges(); sel2.addRange(r2);
    } catch(_) {}
    ['keydown','keyup','input','change'].forEach(t => {
      try { el.dispatchEvent(new Event(t, {bubbles:true})); } catch(_) {}
    });
    try { el.dispatchEvent(new InputEvent('input', {bubbles:true, cancelable:true, inputType:'insertText', data:text})); } catch(_) {}
  }

  // ── Google Messages send automation ────────────────────────────────────────

  function initMessages() {
    setTimeout(checkForPendingSMS, 2500);
    setTimeout(checkForPendingSMS, 5000);
  }

  async function checkForPendingSMS() {
    const job = get('pending_sms', null);
    if (!job || !job.phone || !job.message) return;
    if (Date.now() - (job.ts || 0) > 120000) { set('pending_sms', null); return; }
    set('pending_sms', null);
    await sendViaMessages(job.phone, job.message);
  }

  async function sendViaMessages(phone, message) {
    try {
      progress('Starting…', 10);
      await sleep(1000);

      progress('Starting new conversation…', 20);
      const fab = await waitForDeep([
        'mws-fab button',
        'mws-new-conversation-button button',
        '[aria-label="Start new conversation"]',
        '[aria-label="Start chat"]',
      ], 12000, ['Start chat', 'New conversation', 'Compose']);
      if (!fab) { progress('', 0, '"Start chat" button not found. Is Google Messages paired with your phone?'); return; }
      fab.click();
      await sleep(1500);

      progress('Entering phone number…', 40);
      const recipientInput = await waitForDeep([
        'input[aria-label="To"]',
        'input[aria-label*="recipient" i]',
        'input[placeholder*="name, phone" i]',
        'mws-recipient-input input',
        'mws-contact-flow-start input',
        'input[type="tel"]',
        'input[type="text"]',
      ], 8000);
      if (!recipientInput) { progress('', 0, 'Could not find the "To" field'); return; }
      forceType(recipientInput, phone);
      await sleep(600);
      recipientInput.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', keyCode:13, bubbles:true}));
      await sleep(400);
      recipientInput.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter', keyCode:13, bubbles:true}));
      await sleep(700);
      // Only click a suggestion if it contains our exact phone digits.
      // Clicking the first suggestion blindly sends to the wrong person —
      // Google Messages shows recent contacts that start with the same digits.
      const rawDigits = phone.replace(/\D/g, '').slice(-9);
      const allSuggestions = document.querySelectorAll('mws-contact-row,[role="option"],mws-contact-flow-list-item,mws-suggest-list-item');
      let pickedSuggestion = false;
      for (const opt of allSuggestions) {
        const optDigits = (opt.textContent || '').replace(/\D/g, '');
        if (optDigits.includes(rawDigits)) {
          opt.click(); pickedSuggestion = true; await sleep(600); break;
        }
      }
      if (!pickedSuggestion && allSuggestions.length > 0) {
        // Dismiss dropdown then confirm the typed number with Enter
        recipientInput.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true}));
        await sleep(200);
        recipientInput.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', keyCode:13, bubbles:true}));
        await sleep(400);
      }

      progress('Loading conversation…', 52);
      await sleep(1800);

      progress('Composing message…', 65);
      await sleep(300);
      const compose = await waitForDeep([
        '[aria-label="RCS message"]',
        '[aria-label="SMS message"]',
        '[aria-label="Message"]',
        'mws-message-compose .input-box [contenteditable]',
        'mws-message-compose [contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'mws-compose-bar [contenteditable]',
        '#message-input',
        'mws-message-compose textarea',
      ], 10000);
      if (!compose) { progress('', 0, 'Could not find the message compose area'); return; }

      compose.focus();
      await sleep(500);
      await sleep(200);
      compose.focus();
      await sleep(200);

      if (compose.tagName === 'TEXTAREA' || compose.tagName === 'INPUT') {
        forceType(compose, message);
      } else {
        typeContentEditable(compose, message);
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(400);
        const cur = (compose.value || compose.textContent || compose.innerText || '').trim();
        if (cur) break;
        await sleep(200);
        compose.focus();
        await sleep(300);
        if (compose.tagName === 'TEXTAREA' || compose.tagName === 'INPUT') forceType(compose, message);
        else typeContentEditable(compose, message);
      }

      await sleep(400);
      await sleep(200);
      progress('Sending…', 83);

      try { window.focus(); } catch(_) {}
      await sleep(300);
      const sendBtn = await waitForEnabledSend(8000);
      let messageSent = false;

      if (sendBtn) {
        sendBtn.focus();
        await sleep(100);
        sendBtn.click();
        await sleep(600);

        const afterA = (compose.value || compose.textContent || compose.innerText || '').replace(/[\s​ ]/g, '');
        if (!afterA) { messageSent = true; }

        if (!messageSent) {
          try {
            const rect = sendBtn.getBoundingClientRect();
            const cx = Math.round(rect.left + rect.width / 2);
            const cy = Math.round(rect.top  + rect.height / 2);
            sendBtn.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, composed:true, clientX:cx, clientY:cy, pointerId:1, isPrimary:true, button:0, buttons:1}));
            sendBtn.dispatchEvent(new MouseEvent('mousedown',     {bubbles:true, cancelable:true, composed:true, clientX:cx, clientY:cy, button:0, buttons:1}));
            sendBtn.dispatchEvent(new PointerEvent('pointerup',   {bubbles:true, cancelable:true, composed:true, clientX:cx, clientY:cy, pointerId:1, isPrimary:true, button:0, buttons:0}));
            sendBtn.dispatchEvent(new MouseEvent('mouseup',       {bubbles:true, cancelable:true, composed:true, clientX:cx, clientY:cy, button:0, buttons:0}));
            sendBtn.dispatchEvent(new MouseEvent('click',         {bubbles:true, cancelable:true, composed:true, clientX:cx, clientY:cy, button:0, buttons:0}));
          } catch(_) {}
          await sleep(600);
          const afterB = (compose.value || compose.textContent || compose.innerText || '').replace(/[\s​ ]/g, '');
          if (!afterB) { messageSent = true; }
        }
      }

      if (!messageSent) {
        compose.focus();
        await sleep(150);
        compose.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', keyCode:13, bubbles:true, cancelable:true, composed:true}));
        await sleep(100);
        compose.dispatchEvent(new KeyboardEvent('keyup',   {key:'Enter', code:'Enter', keyCode:13, bubbles:true, composed:true}));
        await sleep(600);
        const afterC = (compose.value || compose.textContent || compose.innerText || '').replace(/[\s​ ]/g, '');
        if (!afterC) { messageSent = true; }
      }

      progress('Message sent!', 100);
      setTimeout(() => { try { window.close(); } catch {} }, 1800);
    } catch (e) {
      console.error('[SOS SMS]', e);
      progress('', 0, e.message || 'Unknown error');
    }
  }

  // ── SOS POS — FAB + panel ──────────────────────────────────────────────────

  const DEFAULT_TEMPLATES = [
    { id:'t1', name:'✅ Ready for Pickup',  body:'Hi {name}, great news!\nYour {device} (#{ticket}) is ready for collection. See you soon!\n— SOS Phone Repairs' },
    { id:'t2', name:'🔧 Parts Ordered',     body:"Hi {name}, parts for your {device} repair (#{ticket}) have been ordered. We'll be in touch when ready. — SOS Phone Repairs" },
    { id:'t3', name:'💬 Quote Ready',       body:'Hi {name}, we\'ve assessed your {device} (#{ticket}) and have a quote ready.\nPlease call us to discuss. — SOS Phone Repairs' },
    { id:'t4', name:'⏳ Repair Delayed',    body:'Hi {name}, sorry — your {device} repair (#{ticket}) is taking a bit longer than expected.\nWe\'ll be in touch shortly. — SOS Phone Repairs' },
    { id:'t5', name:'📝 Custom Message',    body:'Hi {name}, ' },
  ];
  const getTemplates  = () => get('templates', DEFAULT_TEMPLATES);
  const saveTemplates = t  => set('templates', t);
  const STEPS     = ['Opening…','Connecting…','Starting…','Entering number…','Composing…','Sending…','Sent!'];
  const STEP_PCTS = [5, 20, 35, 55, 70, 85, 100];
  let progressEl = null;

  function showProgress(step, pct, error) {
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.65);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
      progressEl.innerHTML = '<div style="background:#111827;border:1.5px solid #1769aa;border-radius:16px;padding:28px 30px;width:340px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.7);color:#e5e7eb;text-align:center"><div style="font-size:26px;margin-bottom:10px" id="pg-icon">💬</div><div style="font-weight:800;font-size:15px;color:#60a5fa;margin-bottom:5px">Sending via Google Messages</div><div id="pg-step" style="font-size:12.5px;color:#9ca3af;margin-bottom:16px;min-height:18px"></div><div style="background:#1f2937;border-radius:99px;height:8px;overflow:hidden;margin-bottom:12px"><div id="pg-bar" style="height:100%;border-radius:99px;background:linear-gradient(90deg,#1769aa,#60a5fa);width:0%;transition:width .45s cubic-bezier(.4,0,.2,1)"></div></div><div id="pg-error" style="display:none;background:#450a0a;border:1px solid #7f1d1d;border-radius:8px;padding:10px 12px;font-size:12px;color:#fca5a5;margin-bottom:12px;text-align:left;line-height:1.5"></div><button id="pg-close" style="display:none;padding:8px 22px;background:#1f2937;color:#e5e7eb;border:none;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600">Close</button></div>';
      document.body.appendChild(progressEl);
      document.getElementById('pg-close').onclick = () => { progressEl && progressEl.remove(); progressEl = null; };
    }
    const bar = document.getElementById('pg-bar');
    const stepEl = document.getElementById('pg-step');
    const icon   = document.getElementById('pg-icon');
    const errEl  = document.getElementById('pg-error');
    const closeBtn = document.getElementById('pg-close');
    if (error) {
      icon.textContent = '❌';
      stepEl.textContent = 'Could not send message';
      bar.style.background = 'linear-gradient(90deg,#7f1d1d,#ef4444)'; bar.style.width = '100%';
      errEl.style.display = 'block';
      errEl.innerHTML = '<b>Error:</b> ' + esc(error) + '<br><br><span style="color:#9ca3af">Make sure messages.google.com is paired with your phone.</span>';
      closeBtn.style.display = 'inline-block';
      return;
    }
    bar.style.width = pct + '%'; stepEl.textContent = step;
    if (pct >= 100) {
      icon.textContent = '✅'; stepEl.style.color = '#34d399';
      stepEl.textContent = '✅ Message sent!';
      setTimeout(() => { progressEl && progressEl.remove(); progressEl = null; }, 1600);
    }
  }

  function initSOSPOS() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        addFAB();
        setInterval(addFAB, 2000);
      });
    } else {
      addFAB();
      setInterval(addFAB, 2000);
    }
  }

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

  // Debounce timer for ticket input
  let _ticketDebounce = null;

  // STEP 1: Search the live DOM using innerText tab/line parsing.
  // SOS POS table rows render as tab-separated text in innerText, e.g.:
  //   "A2635\tPaid & Collect...\tWalk In\tHydrogel\t—\t$40.00"
  // Much more reliable than TreeWalker for React SPAs.
  function lookupTicketInDOM(ticketNum) {
    const upper = ticketNum.toUpperCase();
    const result = { ticket: upper, name:'', phone:'', device:'' };
    const fullText = (document.body && document.body.innerText) || '';
    const SKIP = /^(\u2014|-|\$|paid|open|closed|pending|collect|repair|sale|refund|walk in|\d{4,}$)/i;

    // Try line-by-line (each table row is usually one line, columns tab-separated)
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

    // Fallback: whole-page tab split (no newlines between rows)
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

  // STEP 2: Network fallback — open the ticket's own detail page via GM_xmlhttpRequest.
  // Tries several URL patterns SOS POS might use.
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

  // Parse raw HTML text from a fetched ticket page
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

  // Master lookup: DOM first (instant), then network fallback
  async function lookupTicket(ticketNum) {
    if (!ticketNum || !/^[Aa]\d{3,6}$/.test(ticketNum)) return null;
    const domResult = lookupTicketInDOM(ticketNum);
    if (domResult && (domResult.name || domResult.device)) return domResult;
    return await lookupTicketViaNetwork(ticketNum);
  }

  // Called whenever the ticket field changes (debounced 600 ms)
  function onTicketInput(value) {
    clearTimeout(_ticketDebounce);
    const ticketNum = value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    const statusEl  = document.getElementById('sms-ticket-status');

    // Only search once the ticket looks complete: A + 3-6 digits
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
      // Populate fields (only if still empty — don't overwrite user edits)
      if (found.name   && !document.getElementById('sms-name').value.trim())   setF('sms-name',   found.name);
      if (found.phone  && !document.getElementById('sms-phone').value.trim())  setF('sms-phone',  found.phone);
      if (found.device && !document.getElementById('sms-device').value.trim()) setF('sms-device', found.device);

      // Always update name/phone/device if they were empty — show a banner
      if (st) { st.textContent = '✅ Details loaded — edit if needed'; st.style.color = '#34d399'; }
      syncPreview();

      // Clear banner after 4 s
      setTimeout(() => { const s = document.getElementById('sms-ticket-status'); if (s) s.textContent = ''; }, 4000);
    }, 600);
  }

  // ── Panel builder ───────────────────────────────────────────────────────────

  function buildPanel() {
    if (panel) panel.remove();
    const templates = getTemplates();
    const savedTplId = get('lastTplId', templates[0] && templates[0].id || 't1');
    const tpl        = templates.find(t => t.id === savedTplId) || templates[0];
    const d          = readFromPage();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    panel.innerHTML =
      // ── Header
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2">'
        + '<span style="font-weight:800;font-size:14px;color:#60a5fa">💬 Send SMS</span>'
        + '<div style="display:flex;gap:3px"><button id="sms-tpl-btn" title="Edit templates" style="' + IB + '">✏️</button><button id="sms-close" style="' + IB + '">✕</button></div>'
      + '</div>'
      // ── Ticket section
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<label style="' + L + '">Ticket #</label>'
        + '<div style="display:flex;gap:6px;align-items:center;margin-top:3px">'
          + '<input id="sms-ticket" value="' + esc(d.ticket) + '" placeholder="A1234" maxlength="8" style="' + I + ';font-weight:700;letter-spacing:.06em;text-transform:uppercase;flex:1">'
          + '<button id="sms-read" title="Read current page" style="padding:7px 9px;background:#1f2937;color:#9ca3af;border:1px solid #374151;border-radius:7px;font-size:11.5px;cursor:pointer;white-space:nowrap;flex-shrink:0">📄</button>'
        + '</div>'
        + '<div id="sms-ticket-status" style="font-size:10.5px;margin-top:5px;min-height:14px;color:#60a5fa;transition:color .2s"></div>'
      + '</div>'
      // ── Customer section
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<div style="font-size:10px;font-weight:800;color:#4b5563;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Customer</div>'
        + '<div style="display:flex;flex-direction:column;gap:7px">'
          + '<div><label style="' + L + '">First Name</label><input id="sms-name" value="' + esc(d.name) + '" placeholder="John" style="' + I + '"></div>'
          + '<div><label style="' + L + '">Phone Number</label><input id="sms-phone" value="' + esc(d.phone) + '" placeholder="04XX XXX XXX" style="' + I + '"></div>'
          + '<div><label style="' + L + '">Device / Model</label><input id="sms-device" value="' + esc(d.device) + '" placeholder="iPhone 14 Pro" style="' + I + '"></div>'
        + '</div>'
      + '</div>'
      // ── Template section
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<label style="' + L + '">Template</label>'
        + '<div id="sms-tpls" style="display:flex;flex-direction:column;gap:3px;margin-top:5px">' + templates.map(t => tplRadio(t, t.id === savedTplId)).join('') + '</div>'
      + '</div>'
      // ── Message section
      + '<div style="padding:11px 14px;border-bottom:1px solid #1f2937">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">'
          + '<label style="' + L + '">Message</label>'
          + '<span id="sms-chars" style="font-size:10.5px;color:#6b7280">0 / 160</span>'
        + '</div>'
        + '<textarea id="sms-body" rows="4" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #374151;background:#1f2937;color:#e5e7eb;font-size:12.5px;font-family:inherit;outline:none;resize:vertical;line-height:1.5;box-sizing:border-box">' + esc(applyVars(tpl && tpl.body || '', d)) + '</textarea>'
        + '<div style="font-size:10.5px;color:#4b5563;margin-top:4px"><code style="background:#1f2937;padding:1px 4px;border-radius:3px;color:#60a5fa">{name}</code> <code style="background:#1f2937;padding:1px 4px;border-radius:3px;color:#60a5fa">{device}</code> <code style="background:#1f2937;padding:1px 4px;border-radius:3px;color:#60a5fa">{ticket}</code></div>'
      + '</div>'
      // ── Send button
      + '<div style="padding:12px 14px">'
        + '<button id="sms-send" style="width:100%;padding:12px;background:#1769aa;color:#fff;border:none;border-radius:9px;font-size:13.5px;font-weight:800;cursor:pointer;letter-spacing:.02em;transition:background .15s">📤 Send via Google Messages</button>'
      + '</div>';

    document.body.appendChild(panel);
    wirePanelEvents();

    // If a ticket was read from the page, trigger a lookup immediately
    if (d.ticket) onTicketInput(d.ticket);
  }

  function wirePanelEvents() {
    document.getElementById('sms-close').onclick = () => { panel.remove(); panel = null; };
    document.getElementById('sms-tpl-btn').onclick = buildEditPanel;

    // 📄 Read page button — gets ticket from URL, then triggers full lookup
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

    // Ticket field — sanitise + trigger lookup
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

    document.getElementById('sms-send').onclick = () => {
      const v = curVals();
      const message = document.getElementById('sms-body').value.trim();
      if (!v.phone)  { flash('⚠️ Phone number is required'); return; }
      if (!message)  { flash('⚠️ Message cannot be empty');  return; }
      panel.remove(); panel = null;
      set('pending_sms', { phone: normalizePhone(v.phone), message, ts: Date.now() });
      const sendTime = Date.now();
      set('sms_progress', null);
      showProgress('Opening Google Messages…', 5);
      startProgressPolling(sendTime);
      const screenW = window.screen.availWidth  || 1920;
      const screenH = window.screen.availHeight || 1080;
      const popup = window.open(
        'https://messages.google.com/web/conversations',
        'sos_sms_popup',
        'width=1000,height=750,left=' + Math.max(0, screenW - 1020) + ',top=' + Math.max(0, screenH - 770) + ',menubar=no,toolbar=no,location=no,status=no,scrollbars=no'
      );
      if (popup) {
        setTimeout(() => { try { window.focus(); } catch(_) {} }, 300);
      }
    };
    syncPreview();
  }

  function tplRadio(t, checked) {
    return '<label style="display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:7px;cursor:pointer;transition:all .15s;border:1px solid ' + (checked?'#1769aa':'#1f2937') + ';background:' + (checked?'#1769aa1a':'transparent') + '"><input type="radio" name="sms-tpl" value="' + esc(t.id) + '" ' + (checked?'checked':'') + ' style="accent-color:#60a5fa;cursor:pointer;flex-shrink:0"><span style="font-size:12px;color:#d1d5db;font-weight:' + (checked?'600':'400') + '">' + esc(t.name) + '</span></label>';
  }

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

  function buildEditPanel() {
    if (panel) panel.remove();
    panel = null;
    const templates = getTemplates();
    panel = document.createElement('div');
    panel.id = 'sos-sms-panel';
    panel.style.cssText = 'position:fixed;bottom:70px;left:16px;z-index:99996;width:318px;background:#111827;border:1.5px solid #1769aa;border-radius:14px;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.6);max-height:88vh;overflow-y:auto;';
    panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#111827;z-index:2"><span style="font-weight:800;font-size:14px;color:#60a5fa">✏️ Edit Templates</span><button id="tpl-back" style="background:none;border:none;color:#60a5fa;font-size:12px;font-weight:700;cursor:pointer">← Back</button></div><div id="tpl-editor" style="padding:10px 14px 4px">' + templates.map(tplBlock).join('') + '</div><div style="padding:0 14px 14px;display:flex;gap:6px"><button id="tpl-add" style="flex:1;padding:8px;background:#1f2937;color:#60a5fa;border:1px dashed #374151;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">+ Add</button><button id="tpl-save" style="flex:1;padding:8px;background:#1769aa;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">💾 Save All</button></div><div id="tpl-msg" style="padding:0 14px 10px;font-size:11.5px;color:#34d399;text-align:center;min-height:16px"></div>';
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
  function tplBlock(t) {
    return '<div class="tpl-block" data-id="' + esc(t.id) + '" style="margin-bottom:10px;background:#1f2937;border-radius:9px;border:1px solid #374151;padding:10px 12px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><input class="tpl-name" value="' + esc(t.name) + '" placeholder="Template name" style="background:transparent;border:none;color:#93c5fd;font-size:12px;font-weight:700;outline:none;flex:1;font-family:inherit"><button class="tpl-del" style="background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:0 2px">🗑</button></div><textarea class="tpl-body" rows="3" placeholder="Use {name} {device} {ticket}" style="width:100%;background:#111827;border:1px solid #374151;border-radius:6px;color:#d1d5db;font-size:12px;font-family:inherit;padding:7px 9px;outline:none;resize:vertical;line-height:1.5;box-sizing:border-box">' + esc(t.body) + '</textarea><div style="font-size:10px;color:#4b5563;margin-top:3px">{name} · {device} · {ticket}</div></div>';
  }
  function wireDelBtns() {
    panel.querySelectorAll('.tpl-del').forEach(btn => {
      btn.onclick = () => { if (panel.querySelectorAll('.tpl-block').length <= 1) return; if (confirm('Delete?')) btn.closest('.tpl-block').remove(); };
    });
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  function readFromPage() {
    // Only extract the ticket number from the URL — everything else (name, phone,
    // device) must come from lookupTicketInDOM/network to avoid grabbing wrong
    // text from SOS POS's own UI labels and search placeholders.
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