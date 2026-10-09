# Telegram Price Tracking & Affiliate Link Conversion Bot

A Telegram bot that converts Amazon/Flipkart product links (including `amzn.to` /
`fkrt.it` short links) into clean affiliate links, tracks each product's price
for 30 days, and sends an alert when the price drops.

Everything runs on **Vercel serverless functions** — no long-running server.

### Repairing a price history polluted by the old price bug

An earlier version of the scraper took the first rupee figure on a product page,
which could be an exchange-offer amount rather than the price — a ₹19,999 phone
was recorded at ₹10,490. The scraper is fixed, so no new bad readings appear, but
the old ones are still in Firestore, and the price-history page derives its chart
and its lowest/average stats from them.

`lib/cleanHistory.js` removes those readings. It is a **dry run by default** —
nothing is deleted until you explicitly apply it.

Run it any of three ways:

```
# 1. from Telegram, as the admin (dry run first)
/cleanhistory_<CRON_SECRET>          # reports what would be removed
/cleanhistory_apply_<CRON_SECRET>    # removes it

# 2. from the deployed app
https://<your-app>/api/clean-history?secret=<CRON_SECRET>
https://<your-app>/api/clean-history?secret=<CRON_SECRET>&apply=1
...&id=<docId>                       # just one product

# 3. from a terminal, with the app's Firebase credentials in the environment
node scripts/clean-history.js        # dry run
node scripts/clean-history.js --apply
```

What it treats as bad, and what it deliberately leaves alone:

* A reading is removed only when it is **far below the product's high readings**
  (under 60% of them by default) **and the price then snaps back** — the readings
  either side are at least 1.5x higher. That snap-back is the signature of a bad
  scrape: a deal that *ends* rises a little (₹13,999 → ₹19,999 is 1.43x), while a
  misread snaps back enormously (₹10,490 → ₹19,999 is 1.91x).
* A **genuine price drop is kept.** A real drop stays down, so it is not an
  outlier relative to the product's own readings; and a low price that holds for
  more than 12 consecutive readings (6 hours) is treated as real regardless.
  The dry run **lists the low readings it kept and why**, so a kept run is never
  silent.
* If the automatic check still keeps something you know is wrong, name the figure
  yourself and no heuristics are involved:
  `...&id=<docId>&max=12000` (endpoint) or `--id=<docId> --max=12000` (CLI)
  removes every reading at or below ₹12,000 for that product.
* A product with fewer than five readings is left alone — there is no baseline
  worth trusting.
* If a product would lose more than half its readings, it is **refused** and
  reported rather than gutted.

After a cleanup the page corrects itself on the next load: the chart and the
stats are computed from the readings that remain, and the product's `lastPrice`
is re-pointed at the newest surviving reading.

## How it works

1. You send the bot an Amazon or Flipkart link.
2. It resolves short links, extracts the product ID (ASIN / Flipkart pid), and
   rebuilds a clean affiliate URL — stripping all the tracking junk.
3. The product is saved to Firestore and you are subscribed to it.
4. A **Vercel Cron** job runs every 6 hours, fetches the current price of a
   batch of products, appends a price-history point, and messages subscribers
   when the price falls past a threshold.
5. The inline **📊 Price History** button opens a web page with a 30-day Chart.js
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

## Why Amazon scraping fails from a server (and what to do)

Amazon answers requests from **datacenter IPs** (Koyeb, Vercel, AWS, …) with
**HTTP 503**. This is not a User-Agent problem. The scraper already sends a full
set of browser headers, retries with both a desktop and a mobile agent, and also
tries Amazon's light mobile product page (`/gp/aw/d/ASIN`). Amazon fingerprints
the **IP address**, so a server request is refused whatever the headers say.

What this means in practice:

- **Flipkart works fully** — title, price and history.
- **Amazon**: a link that carries the product-name slug still yields the name,
  because the name is read from the URL itself (no page fetch needed). That
  covers most links you paste, and every `amzn.to` / `amzn.in` short link once it
  is resolved. A **bare** `/dp/ASIN` link with no slug has no name to read and
  no page to fetch, so it shows the ASIN.

The correct fix for Amazon is Amazon's own **Product Advertising API (PA-API)**.
It is the official, permitted way to read titles and prices, and it is not
blocked. It needs an approved Associates account with API access (Amazon grants
it after a few qualifying sales). If you have those keys, the scraper can be
switched to PA-API for Amazon.

Please do **not** try to defeat the block with proxies or fingerprint spoofing:
it breaks Amazon's terms and is unreliable.

## Price-drop / back-in-stock alerts (the price-check loop)

The worker is `api/cron.js`. It scans active products, re-fetches each one, stores
a price point, and alerts every subscriber on:

- a **price drop** of `PRICE_DROP_THRESHOLD_PERCENT` or more (default 1%)
- a **price rise** of `PRICE_INCREASE_THRESHOLD_PERCENT` or more (default 5%)
- an **out-of-stock → in-stock** transition (sent once, on the change)

**It needs a trigger that keeps running.** On Koyeb the app also schedules the job
internally (`PRICE_CRON`, default every 30 minutes) — but an in-process timer only
fires while the instance is awake. If the service scales to zero, the job simply
never runs and no alerts are sent.

So on Koyeb, add an **external** trigger as well:

    cron-job.org  ->  GET https://<your-app>.koyeb.app/api/cron
                      every 15–30 minutes
                      header: Authorization: Bearer <CRON_SECRET>

That both runs the checks and keeps the instance awake. It is the only reliable
way to get alerts on a host that sleeps.

`GET /api/cron` returns a JSON summary (`checked`, `alertsSent`, per-product
results), and each run logs `cron: …` lines so you can see it working.

## Running on Koyeb (long polling — no webhook)

On Koyeb the app runs as a normal long-running process, so the bot uses
**Telegram long polling** instead of a webhook. That means there is **no webhook
URL to register or repair**, no serverless time limit, and no cron frequency cap
— which removes the failure mode that kept taking the bot offline on Vercel.

1. Push this repo to GitHub.
2. In Koyeb: **Create Service → GitHub** and pick this repository.
3. Builder: **Dockerfile** (already included). Port: **8080**.
4. Add the same environment variables as for Vercel — `BOT_TOKEN`,
   the Firebase credentials, `AMAZON_AFFILIATE_TAG`, `BITLY_ACCESS_TOKEN`, etc.
   `WEB_APP_URL` is still worth setting (so the "Price History" button points at
   your site). `CRON_SECRET` and `TELEGRAM_WEBHOOK_SECRET` are **not** needed.
5. Deploy. The logs should show `Bot started in long-polling mode.`

The scheduled jobs run inside the process (`server.js`):

| Job | Env var | Default |
| --- | --- | --- |
| Price checks | `PRICE_CRON` | `0 */6 * * *` (every 6 hours) |
| Deals posting | `DEALS_CRON` | `30 */6 * * *` (every 6 hours, offset) |

> **Run the bot on either Vercel or Koyeb — not both at once.** Two consumers of
> the same bot token fight over the updates, and the Koyeb process clears the
> webhook on startup, which would break the Vercel deployment.

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
"Price History" button points at the right host.

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

**Webhook broken / bot not replying?** Open
`GET /api/telegram?fixWebhook=1` — it re-registers the webhook to this
deployment's own `/api/telegram` URL and drops pending updates, so you never
have to paste the URL by hand (which is easy to mangle with a stray query
string or line break).

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
| `WEB_APP_URL` | recommended | Enables the "Price History" button. |
| `TELEGRAM_CHANNEL_URL` | no | Where "Today's Deals" points (default `https://t.me/Ai_PriceAlert`). |
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
