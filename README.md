# Digital art on Bitcoin — gallery site

A gallery for art issued on Bitcoin via **Counterparty** and **Bitcoin Stamps**. It resolves each
asset to its actual artwork, shows who collects it, and surfaces anything currently for sale.

The site hosts no artwork. Everything is read from the Counterparty and Bitcoin Stamps indexers,
plus Arweave where the original files live.

---

## Why there's an indexer

An asset's `description` field is free text, and this wallet uses **five different conventions** in
it. Resolving a single piece can cost 3–5 network calls across hosts that are slow, rate limited, or
dead. Doing that per pageview would be unusable, so resolution happens ahead of time and the site
reads a cached index.

| Description format | What it means | How the artwork resolves |
|---|---|---|
| `stamp:` + base64 PNG/GIF | Bitcoin Stamp with image data on-chain | Decoded locally into a data URI — no network call |
| `stamp:` + zlib base64 | **An SRC-20 token operation, not art** | Excluded from the gallery |
| `stamp:` (empty payload) | Stamp with data elsewhere | Looked up on stampchain by CPID |
| A URL to a JSON file | Enhanced asset info | Fetched, then `image` / `animation_url` / HTML mined for media |
| Plain prose | No media pointer at all | Falls back to the xcp.io mirror, or a manual override |

### Gotchas this codebase already handles

- **Arweave URLs in descriptions are broken as stored.** They appear as
  `https://<base32>.arweave.net/<txid>/<NAME>.json`, which 404s. Only the bare
  `https://arweave.net/<txid>` form resolves. The same rewrite is needed for image URLs *inside*
  the metadata. See `normalizeArweave()`.
- **21 assets are SRC-20 mints wearing a stamp costume.** Their descriptions inflate to msgpack
  token operations. Without filtering they flood the gallery.
- **`easyasset.art` is dead** — it returns HTTP 200 with an empty body, which naive code reads as
  success. The original images survive on Arweave and are wired in via `config/overrides.json`.
- **xcp.io serves the Counterparty logo** for assets it has no art for. That placeholder is
  fingerprinted and rejected, so it can never masquerade as a hit.
- **Counterparty runs on port 4000**, which many networks block. All calls are server-side.
- **Quantities are raw integers.** Divisible assets need dividing by 1e8.

### Scaling: nearest-neighbour vs smooth

Decided **per artwork from measured pixel dimensions**, not from the asset type. Anything whose
longest edge is ≤ 256px is treated as pixel art and scaled nearest-neighbour; larger work is scaled
smoothly. Crucially the decision uses the *original* dimensions, so a 96px thumbnail of a 4000px
painting still renders smooth, while a 28×37 stamp stays crisp.

---

## Layout

```
config/
  wallets.json        addresses to index, leaderboard exclusions
  overrides.json      manual media, wins over everything
lib/
  resolve.mjs         description classification, media sniffing, Arweave rewrite
  media.mjs           media probing, rendition choice, placeholder rejection
  xcpfetch.mjs        Counterparty client with pagination + proxy fallback
scripts/
  index-assets.mjs    build the artwork index
  index-market.mjs    build dispensers, orders, holders
  build.mjs           copy snapshots into public/data
  bundle.mjs          single self-contained HTML
  serve.mjs           local preview server
public/               the site (no build step, no dependencies)
api/                  Vercel serverless functions for live data
```

## Commands

```bash
npm run index          # resolve all artwork  (slow, network-bound)
npm run index:market   # dispensers, orders, holders
npm run build          # stage data into public/data
npm run dev            # preview at http://localhost:4173
npm run check          # tests + field-mismatch probe
npm run ship           # build → check → bundle   (use this to release)
```

Useful flags: `--only ASSET` to resolve one piece, `--limit N` to cap, `--skip-probe` to skip
network probing.

**Release through `npm run ship`, not `bundle` alone.** It stages data, runs every check, then
writes `dist/gallery.html`. The bundler refuses to run when the snapshots the tests validated
differ from the ones it is about to inline — otherwise the checks can pass against one snapshot
while a different, unvalidated one ships.

## Checks

Every defect this project has had was one of two shapes: the view read a field the data did not
carry **in the collection being queried**, or it read a real field holding the wrong value for
that record's state. None of them crashed. All produced confidently wrong numbers, which is
far harder to notice.

So the checks run the **shipping code** under Node against the **real snapshots** — never a
reimplementation, which would only prove the reimplementation agrees with itself.

```bash
npm run test    # 68 assertions across five suites
npm run probe   # field-mismatch detector; exits non-zero on an unexplained read
```

| Suite | Covers |
|---|---|
| `test/contract.test.mjs` | zero-rendering, listing discoverability, freshness, output hygiene |
| `test/units.test.mjs` | the three upstream unit conventions, effective supply, rarity, formatter drift |
| `test/mega.test.mjs` | the dispense algorithm against its reference formula, precision, monotonicity |
| `test/collectors.test.mjs` | totals reconcile with their own parts, ranking by pieces not units |
| `test/schema.test.mjs` | indexed and API shapes render identically; raw values stay detectable |

### The probe, and why it can be trusted

`test/probe.mjs` wraps every record in every collection in a `Proxy` that knows the union of
keys **its own** collection carries, runs the render functions over the real data, and reports
any read of an absent key against the exact source line that made it. Deliberate cross-schema
tolerance — `readOrder`, `readDispenser`, `orderAssetNames` — is classified by source position,
so those intentional double-reads cannot mask a genuine fault.

It can be trusted because it has been **made to fail on purpose**. Point it at a client with a
known defect restored and it must exit non-zero:

```bash
APP_JS=/tmp/broken-app.js npm run probe   # must report an unexplained read
```

That step is not ceremony. The first version of this probe reported a clean bill of health
against a client with a real defect reintroduced, because it passed proxies in as arguments
while the faulty function read `state.market.orders` directly and never saw one. A checker that
cannot fail on a known bug does not give you confidence, it manufactures it. If you change the
probe, re-prove it the same way.

## Adding wallets

Edit `config/wallets.json`, then re-run `npm run index && npm run index:market && npm run build`.
The index **merges** — a failed or partial run never shrinks the collection.

```json
{
  "addresses": [
    { "address": "1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j", "label": "Primary" },
    { "address": "bc1q...", "label": "Second wallet" }
  ]
}
```

## Filling in missing artwork

Drop an entry into `config/overrides.json`. Overrides beat everything, and the image is probed at
index time so dimensions and scaling stay honest.

```json
"ASSETNAME": {
  "image": "https://arweave.net/<txid>",
  "thumb": "https://arweave.net/<txid>",
  "artist": "Name",
  "note": "Anything worth surfacing on the piece's page"
}
```

## Deploying to Vercel

The site is static plus two serverless functions, with **no dependencies to install**.

```bash
npx vercel        # preview
npx vercel --prod # production
```

Optional environment variables:

- `WALLETS` — comma-separated addresses for the live API routes
- `XCP_API` — your own Counterparty node, if you'd rather not use the public one

To keep the collection fresh, run the indexers on a schedule (GitHub Action or Vercel cron) and
commit the regenerated `data/` snapshots.

## Buying

Where a piece has an open dispenser or DEX order, the site links out to a marketplace and the
purchase happens in the visitor's own wallet. The site never asks for keys and never holds funds.


---

## What is live and what is indexed

This is a living collection, so the site is deliberately split into two layers with
different freshness. Every figure on the page is labelled with which layer it came
from — a green **Live** badge or a grey **Indexed** badge — so nothing stale is ever
presented as current.

### Live — fetched on every visit

| Data | Route | Why it must be live |
|---|---|---|
| Mega dispenser state | `/api/mega`, or stampchain direct | Stock changes with every purchase; a stale figure would promise tokens already sold |
| Open dispensers (all wallets) | stampchain direct in the browser | The fastest-moving data on the site |
| Asset counts, BTC price, chain height | `/api/stats` | One call per wallet — no reason to freeze it |

Both stampchain and tokenscan send `Access-Control-Allow-Origin: *`, so the browser
can read chain state **with no backend at all**. The serverless routes are preferred
because they normalise units server-side, but the client falls back to reading
stampchain directly, and only then to the indexed snapshot.

### Indexed — refreshed on a schedule

| Data | Cost | Why not live |
|---|---|---|
| Artwork resolution (500+ assets) | 3–5 calls each, several thousand total | A live page load would take ~20 minutes |
| Collector leaderboard (400+ assets) | one call per asset | Same, plus upstream rate limits |
| DEX orders | one call per asset | Same |

These are rebuilt by `.github/workflows/refresh.yml` (daily, or on demand) which
commits the regenerated snapshots. Both indexers have guards that stop a partial or
rate-limited run from replacing good data:

- `index-assets.mjs` **merges** with the previous snapshot, so a run can only add.
- `index-market.mjs` **refuses to write** if holder coverage drops more than 10%
  against the existing file, unless `--force` is passed.

That second guard exists because it was learned the hard way: a rate-limited run
once wrote a leaderboard covering 175 of 452 assets over a good one, because a
429 response was being treated as "this asset has no holders".

## Deploying

```bash
npx vercel --prod
```

Optional environment variables:

- `WALLETS` — comma-separated addresses for the live routes (defaults to all seven)
- `MEGA_ADDRESS` — the mega dispenser address
- `XCP_API` — your own Counterparty node instead of the public one
