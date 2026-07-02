# SOS SMS Sender

**Version:** 17.0 · **Site:** app.sospos.com.au

Send SMS messages to customers directly from SOS POS, routed through your own [SMS Bridge](https://github.com/THVjQ/SMS-Brigde) server and the **SOS Messenger** Android app on a real phone. No third-party SMS gateway, no browser automation of Google Messages — just a direct API call to your bridge server.

> **Note:** This is a rewrite of the original script, which sent SMS by automating Google Messages Web (`messages.google.com`). That approach is deprecated — it required Google Messages to stay open in a tab at all times and broke whenever Google changed their UI. This version talks straight to the SMS Bridge server instead.

---

## How It Works

- Adds a **💬 Send SMS** floating button to `app.sospos.com.au`.
- Type a ticket number (e.g. `A1234`) and it looks up the customer's name, phone, and device from the page — or falls back to a network lookup.
- Pick a message template (or write your own), then **Send** — the script POSTs the message straight to your SMS Bridge server, which forwards it to the SOS Messenger Android app to send as a real SMS.
- No Google Messages tab, no phone-pairing browser session required — just the server and the Android app running.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Click **Raw** on `sos-sms-sender.user.js` in this repo — Tampermonkey will prompt to install.
3. Open `app.sospos.com.au`, click the 💬 button, then **⚙️ Bridge Settings**.
4. The server URL is pre-filled. Enter your **API key** (matching `API_KEY` in the server's `.env`/compose file), then **Save** and **Test**.

> The server URL is public knowledge (it's gated by the API key, not by secrecy), so it ships pre-filled. The API key does **not** — you must set your own via the ⚙️ Settings panel. Never commit a real key into this repo; it's public.

---

## Requirements

- A running [SMS Bridge](https://github.com/THVjQ/SMS-Brigde) server, reachable from your browser
- The **SOS Messenger** Android app installed, paired, and set as the default SMS app on a phone with a SIM
- Chrome or Chromium with Tampermonkey

---

## Message Templates

Built-in templates (Ready for Pickup, Parts Ordered, Quote Ready, Repair Delayed, Custom) support `{name}`, `{device}`, and `{ticket}` placeholders. Edit them anytime via the ✏️ button in the SMS panel — changes are saved locally per-browser via Tampermonkey storage.

---

## Using Multiple Scripts

If you are using several of the THVjQ Tampermonkey scripts, check the **Issues** tab — a multi-script addon with live updates across all scripts is in progress.
