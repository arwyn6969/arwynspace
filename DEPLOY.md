# Deploying

Everything is ready. There are **no dependencies to install** — the site is plain HTML, CSS and
dependency-free ES modules, and the four API routes use only built-in `fetch`.

## The short version

```bash
tar xzf xcpart-site.tar.gz
cd xcpart
npx vercel          # first run: links the project, gives you a preview URL
npx vercel --prod   # promotes it to production
```

The first `npx vercel` will ask you to log in and answer a few setup questions. Accept the defaults —
`vercel.json` already sets the output directory to `public` and enables clean URLs.

## What turns on when you deploy

Four serverless routes that have never run anywhere yet:

| Route | Cache | Purpose |
|---|---|---|
| `/api/mega` | 30s edge | Live mega dispenser state — prices and remaining stock |
| `/api/stats` | 60s edge | Live asset counts, BTC price, chain height |
| `/api/market` | 5m edge | Dispensers and DEX orders |
| `/api/holders` | 30m edge | Collector leaderboard from the indexed snapshot |

The site already works without them — the client falls back to reading stampchain directly in the
browser, then to the committed snapshots — but the routes normalise units server-side and spare
visitors the extra round trips.

## Optional environment variables

Set these in the Vercel dashboard under Settings → Environment Variables. All have working defaults.

| Variable | Default | Notes |
|---|---|---|
| `WALLETS` | all seven addresses | Comma-separated. Change this when you add a wallet |
| `MEGA_ADDRESS` | `1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j` | Which address the simulator reads |
| `XCP_API` | `https://api.counterparty.io:4000` | Point at your own node if you have one |

## A custom domain

Vercel dashboard → Settings → Domains → add your domain, then follow the DNS instructions. Nothing in
the code needs changing.

## Keeping the indexed layer fresh

`.github/workflows/refresh.yml` rebuilds the artwork index and collector leaderboard daily and commits
the result, which triggers a redeploy. It needs the repo pushed to GitHub with Actions enabled.

To run a refresh by hand at any time:

```bash
node scripts/index-assets.mjs     # artwork resolution (slow — several thousand API calls)
node scripts/index-market.mjs     # dispensers, orders, holders
node scripts/build.mjs            # stage the snapshots into public/data
```

Both indexers protect themselves: the asset index only ever adds, and the market indexer refuses to
write if holder coverage drops more than 10% against the existing file. If you ever genuinely need to
override that, pass `--force`.

## One thing I could not do

`npx` needs the npm registry, which is blocked in my sandbox, so I could not run the deploy myself or
verify the live routes in place. Every route was tested by invoking its handler directly with a stub
request and response, and both returned correct live data — but their behaviour behind Vercel's edge
cache is unverified until you deploy.
