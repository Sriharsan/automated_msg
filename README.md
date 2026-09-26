# Relay

A single-owner workspace for keyword-triggered delivery. A comment or inbound message can match a whole word or phrase inside a sentence, then send a message and a seven-day file link through an available channel.

## What works

- Instagram comment webhook → one private reply to the commenter.
- Inbound WhatsApp message webhook → WhatsApp reply inside the customer conversation window.
- Email delivery through an SMTP account when the event includes an email address.
- Custom event endpoint for forms, websites, or other approved integrations.
- File library for PDF, PNG, JPG, ZIP, TXT, and MP4 files up to 20 MB.
- Preview mode, activity log, pause/edit flows, and connection status.
- SQLite event and delivery records with unique constraints. A repeated source event ID is ignored; one event can create at most one delivery per destination. Ambiguous sends are marked `uncertain` and never retried automatically.

LinkedIn direct messaging is shown as restricted because ordinary LinkedIn developer access does not include a general automated DM permission. It is deliberately not presented as a connected channel.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`. The local API runs at `http://localhost:8787`. Without `ADMIN_TOKEN`, development mode binds the API to localhost only. Add credentials to `.env` when ready to connect live channels. Never commit `.env`.

Build and run a single production server:

On PowerShell:

```powershell
npm run build
$env:NODE_ENV = 'production'
npm start
```

On macOS or Linux, use `NODE_ENV=production npm start` after building.

Production requires `ADMIN_TOKEN`, `DOWNLOAD_SECRET`, and a public HTTPS `PUBLIC_BASE_URL`. Use persistent storage for `data/` and `uploads/` and run one server instance for this SQLite version. Keep these directories private and back them up. The dashboard prompts for `ADMIN_TOKEN` when protected; `INGEST_TOKEN` separately protects custom event ingestion.

## Connect channels

### Instagram

1. Create a Meta app with Instagram API access for a professional account. Obtain the permissions needed to receive comments and send private replies, and complete Meta App Review if your use requires it.
2. Set `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID`, `META_APP_SECRET`, and `META_VERIFY_TOKEN`.
3. Register `https://YOUR_DOMAIN/webhooks/meta` for comment webhooks. Meta verifies it with `META_VERIFY_TOKEN`; POST payloads are checked with the SHA-256 app signature.
4. Create an Instagram comments automation. Relay replies using the comment ID, which is the required private-reply context. Meta permits one private reply per comment and imposes a time limit; failed provider responses appear in Activity.

### WhatsApp

1. Configure a WhatsApp Business Platform Cloud API number and subscribe its message webhooks to the same Meta URL.
2. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `META_APP_SECRET`, and `META_VERIFY_TOKEN`.
3. Create a WhatsApp messages automation. This version sends freeform replies only after an inbound WhatsApp message; outbound template campaigns are outside this version.

### Email

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. An event needs `recipient.email` before an email can be sent. A public Instagram comment does not provide the commenter's email address, so a separate consent-based collection step or your own contact integration is needed for cross-channel email delivery.

### LinkedIn

LinkedIn's public self-service permissions cover sign-in and social posting, not arbitrary direct messages. Relay does not scrape or automate a personal LinkedIn session. Partner access and a permitted messaging use case would be needed before adding LinkedIn delivery.

## Custom event example

Set `INGEST_TOKEN`, then send a unique `external_id` for every real incoming event:

```bash
curl -X POST https://YOUR_DOMAIN/api/events \
  -H 'Content-Type: application/json' \
  -H 'x-ingest-token: YOUR_INGEST_TOKEN' \
  -d '{"source":"custom","external_id":"form-submission-123","text":"Please send the guide","recipient":{"email":"person@example.com"}}'
```

The same `source` and `external_id` returns `duplicate: true` with no new deliveries. Use `/api/simulate` from the dashboard to preview without contacting a provider.

## Delivery safety

Relay claims the event and each delivery in SQLite before calling a provider. Repeated webhooks cannot create another delivery for the same event. If a network request times out or the process stops while sending, the delivery becomes `uncertain`. Check the provider account and Activity before any manual follow-up. This favors preventing duplicates over automatic retries. Provider acceptance is recorded as `sent`; actual end-user delivery may be reported separately by the provider.

File links use a server-side HMAC signature and expire after seven days. Uploaded files and SQLite data are ignored by Git. Treat the download URL as sensitive while it is valid.

## References

- [Meta Instagram API collection](https://www.postman.com/meta/instagram/overview)
- [Meta WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/overview)
- [LinkedIn API access and permissions](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)

## Checks

```bash
npm test
npm run build
```
