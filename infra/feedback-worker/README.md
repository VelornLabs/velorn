# Velorn Feedback Relay

A tiny Cloudflare Worker that receives feedback from the in-app **Settings >
Send Feedback** form and forwards it to a private Discord channel. The Discord
webhook URL stays a Cloudflare secret - it never ships in the (public) app.

## One-time setup (~10 minutes)

### 1. Create the Discord webhook

In your Discord server: pick (or create) a private channel like `#feedback`,
then channel settings > **Integrations** > **Webhooks** > **New Webhook**,
and copy the webhook URL. Keep it secret.

### 2. Deploy the worker

Dashboard route (no CLI needed):

1. [dash.cloudflare.com](https://dash.cloudflare.com) > **Workers & Pages** > **Create Worker**.
2. Name it `velorn-feedback`, deploy the hello-world, then **Edit code** and
   paste in `worker.js` from this folder. Deploy.
3. Worker > **Settings** > **Variables and Secrets** > add a **Secret** named
   `DISCORD_WEBHOOK_URL` with the webhook URL from step 1.

CLI route, if you prefer wrangler:

```bash
cd infra/feedback-worker
npx wrangler deploy worker.js --name velorn-feedback --compatibility-date 2026-07-01
npx wrangler secret put DISCORD_WEBHOOK_URL --name velorn-feedback
```

### 3. Point the app at it

The worker gets a URL like `https://velorn-feedback.<account>.workers.dev`.
Either:

- add a custom domain in the worker's settings (e.g. `feedback.velorn.ai`)
  so it matches `DEFAULT_FEEDBACK_ENDPOINT` in `src/services/feedback.js`, or
- change `DEFAULT_FEEDBACK_ENDPOINT` to the workers.dev URL and rebuild.

The path does not matter - the worker accepts POSTs on any path.

### 4. Test without touching code

In the running app's DevTools console:

```js
localStorage.setItem('velorn-feedback-endpoint', 'https://velorn-feedback.<account>.workers.dev')
```

Open Settings > Send Feedback, send a test message, and check the Discord
channel. Remove the override with
`localStorage.removeItem('velorn-feedback-endpoint')`.

## What it protects against

- **Webhook theft**: the URL exists only as a Cloudflare secret.
- **Spam floods**: 5 sends per IP per hour (in-memory, per isolate - a
  trickle-limiter, not a fortress; tighten with Turnstile if it ever matters).
- **Bots**: hidden `website` honeypot field; filled = silently dropped.
- **Discord pings**: `allowed_mentions` is empty, so `@everyone` in a message
  does nothing.
- **Oversize/garbage payloads**: category whitelist, 4000-char message cap,
  diagnostics filtered to a known-key whitelist.

Free tier covers 100k requests/day - orders of magnitude above anything the
feedback form will see.
