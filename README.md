# SOS SMS Sender

A Tampermonkey userscript for **app.sospos.com.au** that sends SMS to customers straight from a ticket — pulling the customer's name, phone, and device off the page, filling a template, and delivering it through your own [SMS Bridge](https://github.com/THVjQ/SMS-Brigde) server and the **SOS Messenger** Android app on a real phone.

- **Version:** 17.0
- **Runs on:** `https://app.sospos.com.au/*`
- **Requires:** [Tampermonkey](https://www.tampermonkey.net/) with `GM_setValue` / `GM_getValue` / `GM_xmlhttpRequest` permissions, plus a running [SMS Bridge](https://github.com/THVjQ/SMS-Brigde) server and the SOS Messenger Android app

> **This is a rewrite.** The previous version sent SMS by automating Google Messages Web (`messages.google.com`) — clicking through its UI via Shadow DOM. That's gone. This version POSTs straight to your SMS Bridge server, which hands the message to the SOS Messenger app on a paired phone. No Google Messages tab required.

---

## What it does, in one breath

Click the floating 💬 button on any ticket, type the ticket number, and it looks up the customer's name/phone/device automatically. Pick a template (or write your own), hit send, and the message goes out through your own server + phone — no browser automation, no third-party SMS gateway.

---

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open `https://raw.githubusercontent.com/THVjQ/sos-sms-sender/main/sos-sms-sender.user.js` — Tampermonkey will prompt to install.
3. Open or hard-refresh **app.sospos.com.au** (Ctrl+Shift+R).

You should see a round blue **💬 button** in the bottom-left corner. Click it to open the panel.

> **Updating:** this script has `@updateURL`/`@downloadURL` set, so Tampermonkey checks for and offers new versions automatically. You can also force a check from Tampermonkey → Dashboard → Utilities → Check for userscript updates.

---

## First-time setup

The script ships with the server URL pre-filled but **no API key** — you must set your own.

1. Click 💬 → **⚙️ Bridge Settings**.
2. Confirm the **Server URL** (defaults to `https://sosmessenger.thvjq.com.au`).
3. Paste your **API key** — the same value configured in the SMS Bridge server's `.env`/compose file and the SOS Messenger Android app.
4. Click **🔍 Test** to confirm the server is reachable, then **💾 Save**.

> The server URL isn't secret — it's gated by the API key, not by obscurity — which is why it's safe to ship pre-filled. The API key is secret; never commit a real one into this repo.

---

## The interface

### 💬 Send SMS (main panel)
- **Ticket #** — type a ticket number (e.g. `A1234`); the script looks it up automatically after a short pause.
- **📄 button** — re-reads the ticket number from the current page's URL.
- **Customer fields** — name, phone, device — auto-filled from the lookup, editable if wrong.
- **Template** — pick a built-in message template; switching templates re-fills the message body.
- **Message** — free-form text with a live character counter (SMS segment count shown once over 160 characters).
- **📤 Send via SOS Messenger** — sends the message through the bridge.

### ⚙️ Bridge Settings
Server URL and API key, with **Test** (pings `/health`) and **Reset to built-in defaults**.

### ✏️ Edit Templates
Add, rename, edit, or delete message templates. Supports `{name}`, `{device}`, `{ticket}` placeholders.

---

## How ticket lookup works

1. **DOM scan (instant)** — reads the current page's rendered text, looking for the ticket number and the name/device/phone that appear near it in the ticket table.
2. **Network fallback** — if nothing is found on the page, it tries fetching the ticket's own detail page (`/tickets/`, `/repair/`, `/job/`, etc.) and parses the HTML for customer details.

If neither finds anything, the fields stay blank and you fill them in manually — the script never overwrites a field you've already typed into.

---

## Message Templates

| Template | Default use |
|---|---|
| ✅ Ready for Pickup | Repair complete, ready for collection |
| 🔧 Parts Ordered | Waiting on parts |
| 💬 Quote Ready | Assessment done, quote pending approval |
| ⏳ Repair Delayed | Running longer than expected |
| 📝 Custom Message | Blank starter for anything else |

Edit them anytime via ✏️ — changes are saved locally per-browser via Tampermonkey storage (`GM_setValue`), not synced anywhere.

---

## Troubleshooting

**The 💬 button doesn't appear.**
Confirm the script is enabled in Tampermonkey and you're on `app.sospos.com.au`. Hard-refresh the page.

**"SOS Messenger not configured" error.**
You haven't set an API key yet — click ⚙️ Bridge Settings and fill it in.

**"Authentication failed" / HTTP 401-403.**
The API key doesn't match what's set on the server. Re-check the key in ⚙️ Settings against the server's `.env`/compose `API_KEY`.

**"Network error" / "Could not reach server."**
The SMS Bridge server isn't reachable from your browser — confirm it's running, and that the server URL in Settings matches (test with 🔍 Test).

**Ticket lookup doesn't find the customer.**
The DOM/network parsers rely on the page's layout — if SOS POS changes how tickets are rendered, lookup may need updating. Fill in the fields manually in the meantime.

---

## Privacy & data

The script runs entirely in your browser. It stores only your bridge server URL, API key, and message templates locally via Tampermonkey's storage (`GM_setValue`) — nothing is sent anywhere except the message POST to your own SMS Bridge server when you click Send. See the [SMS Bridge privacy policy](https://github.com/THVjQ/SMS-Brigde/blob/main/PRIVACY_POLICY.md) for what happens to a message after it reaches the server.

---

## Changelog

- **17.0** — Full rewrite: replaced Google Messages Web browser automation with a direct API call to the self-hosted SMS Bridge server. Added ⚙️ Bridge Settings panel (server URL + API key, with Test/Reset). Added `@updateURL`/`@downloadURL` for auto-updates.
- **16.4** — Last version of the Google Messages Web automation approach (deprecated).

---

## Using Multiple Scripts

If you are using several of the THVjQ Tampermonkey scripts, check the **Issues** tab — a multi-script addon with live updates across all scripts is in progress.
