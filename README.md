# SOS SMS Sender

A Tampermonkey userscript for **app.sospos.com.au** that sends SMS to customers straight from a ticket — pulling the customer's name, phone, and device off the page, filling a template, and delivering it through your own [SMS Bridge](https://github.com/THVjQ/SMS-Brigde) server and the **SOS Messenger** Android app on a real phone.

- **Version:** 21.0
- **Runs on:** `https://app.sospos.com.au/*`
- **Requires:** [Tampermonkey](https://www.tampermonkey.net/) with `GM_setValue` / `GM_getValue` / `GM_xmlhttpRequest` permissions, plus a running [SMS Bridge](https://github.com/THVjQ/SMS-Brigde) server and the SOS Messenger Android app

> **No Chrome extension needed.** This script includes its own device pairing (🔗), so the separate `sms-extension` browser extension is optional — everything (send, configure, pair) works from this one userscript.

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

You sign in with a username and password. There is no API key to copy — logging in issues this
browser a credential behind the scenes.

1. Click 💬 → **⚙️ Bridge Settings**.
2. Confirm the **Server URL** (defaults to `https://sosmessenger.thvjq.com.au`).
3. **Sign in**, or **Create an account →** if you don't have one.
4. Click **💾 Save**.

New accounts start as *pending* and can't do anything until the server's administrator approves
them — you'll see "waiting to be approved" if you try to sign in first. The very first account
registered on a fresh server becomes the administrator automatically.

> Adding another PC is just: install the script, enter the URL, sign in with the same username and
> password. Same account, same phones, same history.

An API key can still be pasted in via **Use an API key**, for a server that predates sign-in. It is
a fallback, not the normal route.

### Pairing a phone

Click 💬 → **🔗 Pair Device** → **Generate Pairing Code**, then on the phone: NexLink → Computer
Bridge → enter the server URL and the code. The phone needs no API key; pairing issues it one.

Codes expire after 15 minutes and carry the account that generated them — so a phone joins whoever
made the code. If you're setting someone else up, they generate the code on their own PC.

---

## The interface

### 💬 Send SMS (main panel)
- **Ticket #** — type a ticket number (e.g. `A1234`); the script looks it up automatically after a short pause.
- **📄 button** — re-reads the ticket number from the current page's URL.
- **Customer fields** — name, phone, device — auto-filled from the lookup, editable if wrong.
- **Template** — pick a built-in message template; switching templates re-fills the message body.
- **Message** — free-form text with a live character counter (SMS segment count shown once over 160 characters).
- **📤 Send via SOS Messenger** — sends the message through the bridge.

### 🔗 Pair Device
Generate a 15-minute pairing code to link a new Android phone to the server, and view/refresh the list of already-linked devices. Same pairing flow the Chrome extension offers, built into the script.

Each phone is listed with its last-seen time, flagged if it has no encryption key, and can be
retired with 🗑 — which also fails anything still queued for it.

> **Several phones on one server is now supported.** Messages are routed to a named device and
> claimed atomically, so two phones never deliver the same text. Choose which phone this PC sends
> through under **Send through** in ⚙️ Bridge Settings; with one phone paired it binds automatically.

### 📥 Replies
Customer replies, decrypted in your browser. Each PC has its own key pair and the phone encrypts a
copy for every registered PC, so replies reach all of them and the server can read none of them.
**↩ Reply** opens the send panel with the number filled in.

A reply that arrived before this PC registered its key will show as encrypted for another PC — it
can only be read where it was addressed.

### 👤 Administration *(admins only)*
Approve or deny pending sign-ups, and suspend or reactivate people. The button only appears for an
administrator, and the server refuses these routes to anyone else.

### ⚙️ Bridge Settings
Server URL, sign-in, and **Send through** (which phone this PC uses).

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
You haven't signed in — click ⚙️ Bridge Settings and sign in.

**"Authentication failed" / HTTP 401.**
Your session was revoked, or the account was suspended. Sign in again from ⚙️ Bridge Settings.

**"Your account is waiting to be approved."**
Working as intended — an administrator has to approve the account before it can sign in.

**"has no encryption key — re-pair it from the phone."**
The phone is registered but the server has nothing to encrypt to. On the phone: Computer Bridge →
Unlink & re-pair, with a fresh code. Nothing is sent in plaintext as a fallback.

**"Several phones are paired and none is set as default."**
Pick which phone this PC sends through in ⚙️ Bridge Settings.

**A message stays "unconfirmed".**
It was queued but no phone collected it within 30 seconds. Check the phone is on, has signal, and
isn't being killed by battery optimisation. The message may still go out later — the panel says
unconfirmed rather than claiming success.

**Replies aren't reaching this PC.**
The phone refreshes its list of PCs every 5 minutes; a newly added PC isn't known until then. Wait,
or re-pair the phone to pick it up immediately.

**"Network error" / "Could not reach server."**
The SMS Bridge server isn't reachable from your browser — confirm it's running, and that the server URL in Settings matches (test with 🔍 Test).

**Ticket lookup doesn't find the customer.**
The DOM/network parsers rely on the page's layout — if SOS POS changes how tickets are rendered, lookup may need updating. Fill in the fields manually in the meantime.

---

## Privacy & data

The script runs entirely in your browser. It stores your server URL, the API key issued when you
sign in, your message templates, sent history, and **this PC's private key** locally via
Tampermonkey's storage (`GM_setValue`). Nothing is sent anywhere except your own SMS Bridge server.

Messages are sealed in your browser before they are sent, and replies are decrypted in it — the
server relays ciphertext in both directions and holds no key that opens it. Metadata is not
encrypted: the server sees phone numbers, timing and message sizes, because it needs them to route.

The private key never leaves this browser profile. Clearing Tampermonkey's storage loses it, and
replies encrypted to it become unreadable. See the
[SMS Bridge privacy policy](https://github.com/THVjQ/SMS-Brigde/blob/main/PRIVACY_POLICY.md) for
what happens on the server side.

---

## Changelog

- **21.0** — Sign in with a username and password instead of pasting an API key; open signup gated
  by admin approval. Outbound messages are now encrypted in the browser rather than by the server.
  Added the 👤 admin panel for approvals, visible only to administrators.
- **20.0** — Added the 📥 Replies panel: this PC generates its own key pair, registers it, and
  decrypts replies locally. The server can no longer read inbound messages.
- **19.0** — Added the **Send through** phone picker and real delivery confirmation — a message is
  reported delivered, failed, or explicitly unconfirmed, never just "queued". Pair Device gained
  device removal and flags phones missing an encryption key.
- **18.0** — Added the 📜 Sent history panel with search, resend and export.
- **17.1** — Added 🔗 Pair Device panel (generate pairing codes, list linked devices) so the script no longer needs the companion Chrome extension for anything.
- **17.0** — Full rewrite: replaced Google Messages Web browser automation with a direct API call to the self-hosted SMS Bridge server. Added ⚙️ Bridge Settings panel (server URL + API key, with Test/Reset). Added `@updateURL`/`@downloadURL` for auto-updates.
- **16.4** — Last version of the Google Messages Web automation approach (deprecated).

---

## Using Multiple Scripts

If you are using several of the THVjQ Tampermonkey scripts, check the **Issues** tab — a multi-script addon with live updates across all scripts is in progress.
