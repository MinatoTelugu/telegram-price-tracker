# Telegram Price Tracking & Affiliate Link Conversion Bot

A Telegram bot that converts Amazon/Flipkart product links (including `amzn.to` /
`fkrt.it` short links) into clean affiliate links, tracks each product's price
for 30 days, and sends an alert when the price drops.

Everything runs on **Vercel serverless functions** — no long-running server.

## How it works

1. You send the bot an Amazon or Flipkart link.
2. It resolves short links, extracts the product ID (ASIN / Flipkart pid), and
   rebuilds a clean affiliate URL — stripping all the tracking junk.
3. The product is saved to Firestore and you are subscribed to it.
4. A **Vercel Cron** job runs every 6 hours, fetches the current price of a
   batch of products, appends a price-history point, and messages subscribers
   when the price falls past a threshold.
5. The inline **📈 Price Track** button opens a web page with a 30-day Chart.js
   graph of the price history.

## Project structure

```
.
├── api/
│   ├── telegram.js   # Telegram webhook: convert links, save users/products
│   ├── cron.js       # Scheduled price checks + drop alerts
│   └── track.js      # JSON API: price history for one product
├── lib/
│   ├── firebase.js   # Firebase Admin + Firestore connection (singleton)
│   ├── affiliate.js  # URL cleaning + affiliate link generation
│   └── scraper.js    # Product-page price extraction
├── public/
│   └── index.html    # 30-day price-history graph (Chart.js)
├── package.json
├── vercel.json       # Cron schedule + function config
└── .env.example      # Every environment variable you need
```

## Firestore data model

| Path | Purpose |
| --- | --- |
| `users/{telegramId}` | One doc per user (`firstName`, `username`, `createdAt`, `lastSeenAt`). |
| `products/{marketplace}_{productId}` | One doc per **unique** product, e.g. `amazon_B08N5WRWNW`. Holds `title`, `imageUrl`, `lastPrice`, `currency`, `cleanUrl`, `affiliateUrl`, and a `subscribers` array of Telegram user ids. |
| `products/{id}/price_history/{auto}` | `{ price, currency, checkedAt }` — one point per check, pruned to 30 days. |

Because products are shared, if ten users track the same item the cron job
checks it **once**, not ten times.

## Setup

### 1. Create the Telegram bot
- Message [@BotFather](https://t.me/BotFather), run `/newbot`, copy the token.
- That token goes in `BOT_TOKEN`.

### 2. Create the Firebase project
- Create a project at <https://console.firebase.google.com>, enable **Firestore**.
- Project settings → **Service accounts** → *Generate new private key*.
- Paste the downloaded JSON as a single line into `FIREBASE_SERVICE_ACCOUNT_KEY`
  (raw JSON or base64 both work).

### 3. Get affiliate ids
- Amazon Associates → your tracking id, e.g. `yourtag-21` → `AMAZON_AFFILIATE_TAG`.
- Flipkart Affiliate → your `affid` → `FLIPKART_AFFILIATE_ID`.

### 4. Environment variables
Copy `.env.example` to `.env.local` for local development, and add every key in
**Vercel → Project → Settings → Environment Variables** for production. See the
table below.

### 5. Deploy
```bash
npm install
npx vercel --prod
```
Note the deployment URL and set `WEB_APP_URL` to it, then redeploy so the
"Price Track" button points at the right host.

### 6. Register the webhook
Replace the placeholders and run:
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-app>.vercel.app/api/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "drop_pending_updates=true"
```
Verify with `.../getWebhookInfo`. You can also open `GET /api/telegram` in a
browser — it returns a JSON status report showing which environment variables
are present and whether Firebase initialised, plus a `problems` list. Add
`?key=<CRON_SECRET>` to also see the live `getWebhookInfo` result (this is how
you confirm the webhook URL and spot any `last_error_message`).

### 7. Cron
`vercel.json` schedules `GET /api/cron` **once a day at 03:00 UTC (08:30 IST)**
and Vercel sends `Authorization: Bearer $CRON_SECRET`.

Why only daily: the Vercel **Hobby** plan allows at most **one cron run per
day** and only 2 cron jobs — anything more frequent (e.g. `0 */6 * * *`) is
rejected at deploy time. To check prices more often you have two options:

- **Upgrade to Pro** and set the schedule to `0 */6 * * *` (every 6 hours).
- **Stay free:** add an external scheduler. The included GitHub Actions workflow
  (`.github/workflows/cron.yml`) hits `/api/cron` every 6 hours using the
  `CRON_SECRET` and `APP_URL` repository secrets — no Pro plan needed. It simply
  runs alongside the daily Vercel cron.

You can trigger a run manually any time:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron
```

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `BOT_TOKEN` | yes | From @BotFather. |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | one of A/B | Service-account JSON, raw or base64. If set but unparseable, the three vars below are used instead. |
| `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` | one of A/B | Alternative to the combined key — three plain values, easier to paste correctly. |
| `AMAZON_AFFILIATE_TAG` | recommended | Default Amazon tag. |
| `AMAZON_AFFILIATE_TAG_<TLD>` | no | Per-domain override, e.g. `_IN`, `_CO_UK`. |
| `FLIPKART_AFFILIATE_ID` | recommended | Flipkart `affid`. |
| `WEB_APP_URL` | recommended | Enables the "Price Track" button. |
| `TELEGRAM_WEBHOOK_SECRET` | recommended | Must match the `secret_token` you set. |
| `CRON_SECRET` | recommended | Must match Vercel's cron secret. |
| `CRON_BATCH_SIZE` | no | Products per run (default `20`). |
| `PRICE_DROP_THRESHOLD_PERCENT` | no | Alert threshold, default `1` (1%). |

## Bot commands

| Command | Action |
| --- | --- |
| *(send a link)* | Convert it and start tracking. |
| `/start` | Register and show the welcome message. |
| `/help` | How it works. |
| `/mytracks` | List your tracked products. |
| `/untrack <id>` | Stop tracking one (or use the inline button). |

## Known limitations (worth knowing)

- **Amazon blocks datacenter IPs.** `lib/scraper.js` detects the "Robot Check"
  page and skips the product rather than recording a wrong price. Flipkart is
  more permissive. For reliable Amazon prices, plug the Product Advertising API
  or a data provider (e.g. ExtraPe) into `fetchProduct()` — the return shape
  stays the same.
- **Affiliate links are generated, not verified.** The URL-cleaning method
  produces a correct affiliate link but does not confirm the product exists.
- **Scraping selectors can change.** Amazon/Flipkart occasionally rename their
  CSS classes; the scraper lists several fallbacks per field, but a redesign may
  still need selector updates.
- **Cron frequency is plan-limited** (see step 7).
