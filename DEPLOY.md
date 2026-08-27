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

## Cloudflare Pages

An alternative (or addition) to Vercel. `wrangler.toml` and `public/_headers` are committed;
`vercel.json` is left in place and the two hosts ignore each other.

**Phase A — static, no code changes needed.**

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Output directory | `public` |
| Install command | *(leave empty — there are no dependencies)* |
| Node version | pinned to 22 by `.node-version` — see below |

That is the whole configuration. It works because the client falls back from `/api/*` to the
committed snapshots in `public/data/`, so every view renders without a single function
deployed. Hash routing (`#/collected`) means no SPA rewrite rule is needed either.

**Do not delete `.node-version`.** Every script uses `import.meta.dirname`, which arrived in
Node 20.11. Cloudflare Pages has historically defaulted to Node 18, where it is `undefined`, so
`path.resolve(import.meta.dirname, "..")` throws and the build fails with a message that points
nowhere near the cause. `package.json` declares `engines: >=20`, but that is a declaration — it
does not tell the host which Node to use.

Do **not** set the build command to `npm run ship`. That additionally bundles
`dist/gallery.html`, which is gitignored and is not what Pages serves.

**Phase B — the API routes, optional.**

`api/*.js` are Vercel Node handlers (`export default (req, res)`). Pages Functions use
`export function onRequest(context)` returning a `Response`, and live in `functions/`.

| Route | Porting effort |
|---|---|
| `api/stats.js` | Mechanical — `fetch` only |
| `api/market.js` | Mechanical — `fetch` only |
| `api/mega.js` | Mechanical — `fetch` only |
| `api/holders.js` | **Needs thought** — reads the snapshot off disk with `fs.readFileSync`, and Workers have no filesystem. Must read through the assets binding instead |

The `*/15` cron in `vercel.json` has no Pages equivalent. It only warms the `/api/mega` cache;
`refresh.yml` already handles the real daily data refresh.

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
