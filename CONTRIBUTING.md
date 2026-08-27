# Contributing

Written for whoever works on this next — human or agent. It is short, and the second
section is the one that matters.

## Flow

Branch, commit, open a PR. `.github/workflows/check.yml` runs on every push and pull
request: `npm run build`, then the test suites, then the field-mismatch probe, then both
break-for-proof steps. A red check is a real finding here, not CI flakiness — read what it
says before retrying.

```bash
npm run check   # tests + probe. Run this before you push
npm run ship    # build → check → bundle. Use this to release
```

No dependencies to install. Node 20+.

## The one invariant: absent is not zero

Every defect this project has shipped was the same mistake wearing a different hat, and
none of them crashed. They produced confidently wrong numbers, which is far harder to
notice than a stack trace.

| | What happened |
|---|---|
| **D1** | A real `0` treated as absent. `give_remaining ?? give_quantity` — a nullish chain falls through on null/undefined, and **zero is neither**. 44 of 44 completed sales rendered "0 offered / 0 traded for" for weeks |
| **D3** | An absent key read as a value. The freshness badge read two keys that were never in the file, so it could never say anything but "Indexed" |
| **D4 / D9** | The right field name on the **wrong collection**. `give_asset` is real — on order *history*, never on open orders. A global "does this key exist anywhere" grep comes back clean, which is why three review passes each missed an instance |
| **D14** | Raw chain integers emitted under field names the client reads as human units. Every divisible dispenser would have rendered 100,000,000× too large on first deploy |
| **Collected** | 47 pieces have **no holder data**. Rendering them as "0 holders" would state as fact something never measured |

So the rule, and it is not negotiable:

> **"The value is zero" and "we could not find out" are different facts. Never let one
> render as the other.**

In practice that means: an unmeasured value renders as an em-dash, not `0`; a measured zero
renders as `0`, not a blank; failures are recorded explicitly (`holderDataOk: false`) rather
than by omitting a key; and a nullish chain is never the tool for a field whose legitimate
value is zero.

## Things that look like bugs and are not

Do not "fix" these. Each has a comment explaining itself; read it first.

- **`qty()` does not rescale by 1e8.** Quantities reaching the client are already in human
  units. An earlier version divided here, making every divisible asset read 100,000,000×
  too small.
- **`data/` and `public/data/` are committed.** They are the indexed layer, and
  `refresh.yml` commits them after each run. Ignoring them silently breaks the refresh
  design. Regenerating costs thousands of upstream requests and about twenty minutes.
- **`data/kaleidoscope-cache.json` (2.2 MB) is tracked** despite being a cache. Rate
  limiting is a documented failure mode; carrying it between CI runs is worth more than a
  slimmer repo.
- **`assetsCovered` counts measured assets, not entries.** Since failed fetches now get a
  recorded entry, `Object.keys(byAsset).length` is *not* a coverage figure — a fully
  rate-limited run would write 489 failure entries and pass the anti-clobber guard as if
  coverage had improved.
- **Reach is not the default ranking on Collected.** It was, and it was measurably wrong:
  a piece transferred once in full to a single holder scores 100%. See the header comment
  in `public/collected.js`.
- **`readOrder`, `readDispenser`, `readHolding`** deliberately read keys that may be
  absent, because they normalise across schema generations. The probe knows about them by
  source position. Adding a tolerant read outside those functions will fail the probe, and
  that is the point.

## The checkers can fail, and are proven to

`test/probe.mjs` wraps every record in every collection in a `Proxy` that knows the union of
keys **its own** collection carries, runs the shipping render functions over the real data,
and attributes any read of an absent key to an exact source line.

The first version of that probe reported a clean bill of health against a client with D9
deliberately restored — it passed proxies as arguments while the faulty function read
`state.market.orders` directly and never saw one. **A checker that cannot fail on a known
bug does not give you confidence, it manufactures it.** So CI reintroduces two real defects
on every run and requires failure:

```bash
node test/break-for-proof.cjs /tmp/app-broken.js
APP_JS=/tmp/app-broken.js npm run probe                             # must exit non-zero

node test/break-collected-for-proof.cjs /tmp/collected-broken.js
COLLECTED_JS=/tmp/collected-broken.js node test/collected.test.mjs  # must exit non-zero
```

If you change `listingsFor` or `readHolding` and a break-for-proof script can no longer find
its marker, it fails loudly and tells you to update the marker. **Update it. Do not delete
the step.**

## Adding a test

Load the shipping code under Node via `test/harness.mjs` — never reimplement the logic you
are testing. Every defect here has been a gap between what the view read and what the data
held, and a test that reimplements the view only proves the reimplementation agrees with
itself.

```js
import { loadWithData, check, eq, ok, summary } from "./harness.mjs";
const { api, ctx, data } = loadWithData();   // real snapshots, real client
```

Then add the file to the `test` script in `package.json` so CI picks it up.

## Verify against reality, not against your patch

The habit that has caught the most here: after changing anything that produces a number,
re-fetch the same figure from the chain and recompute it with a *separate* implementation.
Reading the diff and agreeing with yourself is not verification. Four pieces were checked
that way after the Collected work — including a divisible asset, where the unit traps
live — and all four matched unit-for-unit.
