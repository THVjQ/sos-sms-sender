# SOS SMS Sender

**Version:** 16.4 · **Sites:** app.sospos.com.au · messages.google.com

> **Note:** This script sends SMS via **Google Messages Web** (browser automation). For the full encrypted SMS bridge that routes through an Android app without needing Google Messages open, see [SMS-Bridge](https://github.com/THVjQ/SMS-Brigde).

Send SMS messages to customers directly from SOS POS, routed through Google Messages Web. No third-party SMS gateway — it uses your existing Google Messages account.

---

## How It Works

- On **SOS POS**: Adds an SMS button to ticket/customer views. Pre-fills the customer's number and a message template, then passes the details to Google Messages Web via Tampermonkey shared storage.
- On **Google Messages** (`messages.google.com`): Reads the queued message, auto-fills the recipient and body, and sends after a short delay.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome
2. Click **Raw** on the `.user.js` file in this repo
3. Tampermonkey will prompt to install — click **Install**
4. Open **Google Messages Web** (`messages.google.com`) and pair it with your Android phone
5. Keep Google Messages Web open in a Chrome tab while using SOS POS

> Google Messages Web must be open and paired with your phone for messages to send.

---

## Limitations

- Google Messages Web must be open in a tab at all times — if the tab is closed, messages will not send
- The script automates Google Messages via Shadow DOM — it may need updates if Google changes the UI
- For a fully self-hosted alternative that does not require Google Messages Web, see the [SMS-Bridge](https://github.com/THVjQ/SMS-Brigde) project

---

## Using Multiple Scripts

If you are using several of the THVjQ Tampermonkey scripts, check the **Issues** tab — a multi-script addon with live updates across all scripts is in progress.
