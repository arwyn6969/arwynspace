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

## Cloudflare Workers (static assets)

`wrangler.toml` and `public/_headers` are committed. `vercel.json` is left in place; the two
hosts ignore each other.

**Workers, not Pages** — that is Cloudflare's own recommendation: *"Workers Static Assets is
the recommended way to deploy static sites... If you are starting a new project, use Workers
instead of Pages. Pages continues to work, but new features and optimizations are focused on
Workers."*

### Workers Builds settings

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Node version | pinned to 22 by `.node-version` — see below |

There is no separate "install command" field; Workers Builds runs `npm install` automatically.
This project has no runtime dependencies, so that install is a no-op — there is no need to set
`SKIP_DEPENDENCY_INSTALL`.

**Keep the build command.** `npm run build` stages `data/` into `public/data/` and injects the
artist name and tagline from `config/wallets.json`. Without it the deploy would ship whatever
`public/data/` happened to be committed, which breaks the daily-refresh design. Do **not** use
`npm run ship` — that also writes `dist/gallery.html`, which is gitignored and is not served.

### Why the whole config is four lines

```toml
name = "arwynspace"
compatibility_date = "2026-08-27"

[assets]
directory = "./public"
```

No `main` entry point, because this is a purely static site and no code needs to run per
request. It works because the client falls back from `/api/*` to the committed snapshots in
`public/data/`, so every view renders with no functions deployed at all. Hash routing
(`#/collected`) means no single-page-application fallback rule is needed either.

`public/_headers` is honoured — `_headers` and `_redirects` are supported natively by Workers
static assets as long as they sit inside the assets directory.

**Do not delete `.node-version`.** Every script uses `import.meta.dirname`, which arrived in
Node 20.11. Build environments have historically defaulted to Node 18, where it is `undefined`,
so `path.resolve(import.meta.dirname, "..")` throws and the build fails with a message that
points nowhere near the cause. `package.json` declares `engines: >=20`, but that is a
declaration to consumers — it does not tell the build host which Node to use.

### Serving under a path: arwyn.party/bitcoinart

The same build is served twice:

| URL | How |
|---|---|
| `https://arwynspace.mrarwyn.workers.dev/` | asset router, at the root |
| `https://arwyn.party/bitcoinart/` | Worker route, prefix stripped |

`arwyn.party/*` is already routed to another Worker (`emblem-homepage-home`), so this one
claims only `arwyn.party/bitcoinart*` and `www.arwyn.party/bitcoinart*`. Cloudflare resolves
overlapping routes by specificity, so the longer pattern wins for that path and the rest of the
domain is untouched.

`src/worker.js` strips the prefix and hands the request to the `ASSETS` binding. Two details
that are easy to get wrong:

- **The trailing slash matters.** Every asset reference in the site is relative (`./app.css`,
  `./data/holders.json`) — which is exactly what lets one build serve from two base paths. But
  from `/bitcoinart` the browser resolves `./app.css` to `/app.css`, which on arwyn.party is
  another Worker's territory. So `/bitcoinart` returns a 308 to `/bitcoinart/` rather than
  serving anything.
- **`run_worker_first` is deliberately NOT set.** Cloudflare does not apply `_headers` to
  responses generated by Worker code, and names that flag as a case where you must reapply
  headers yourself. Leaving the asset router in front keeps `public/_headers` authoritative for
  unprefixed requests instead of creating a second copy of the cache config that can drift.

### Adding the API routes later (optional)

`api/*.js` are Vercel Node handlers (`export default (req, res)`). To serve them from Workers
you would add a `main` entry point plus an `ASSETS` binding, and rewrite each handler to accept
a `Request` and return a `Response`.

| Route | Porting effort |
|---|---|
| `api/stats.js` | Mechanical — `fetch` only |
| `api/market.js` | Mechanical — `fetch` only |
| `api/mega.js` | Mechanical — `fetch` only |
| `api/holders.js` | **Needs thought** — reads the snapshot with `fs.readFileSync`, and Workers have no filesystem. It would read through the assets binding instead |

Do not port `api/holders.js` by pattern-matching the other three.

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
