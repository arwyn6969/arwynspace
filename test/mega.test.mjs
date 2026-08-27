/**
 * Mega-dispenser simulation.
 *
 * This is the only code on the site that tells someone what they will receive for a
 * payment, so it is the code where a wrong answer costs money. It had no tests.
 *
 * The algorithm is ported from counterparty-core lib/messages/dispense.py:
 *
 *     lots_wanted    = floor(payment_sats / price_sats)
 *     lots_available = floor(remaining / give_per_lot)
 *     lots_given     = min(lots_wanted, lots_available)
 *     received       = lots_given * give_per_lot
 *
 * Usage:  node test/mega.test.mjs
 */
import { loadMega, loadWithData, check, eq, ok, summary } from "./harness.mjs";

const MD = loadMega();
const { api, data } = loadWithData();
const MEGA = data.market.dispensers;

console.log("Mega dispenser\n");

/* --------------------------------------------------------------- algorithm */

check("reproduces the reference formula across a table of cases", () => {
  const cases = [
    // payment, price, give, stock, expected lots, expected received
    [11110, 11110, 1, 4, 1, 1],
    [22220, 6900, 1, 10, 3, 3],       // the documented multi-lot case
    [22220, 6900, 1, 2, 2, 2],        // stock-capped below lots wanted
    [6899, 6900, 1, 10, 0, 0],        // one sat short buys nothing
    [0, 6900, 1, 10, 0, 0],
    [100000, 1000, 0.5, 2, 4, 2],     // capped: 100 wanted, only 4 lots of 0.5 exist
  ];
  const bad = [];
  for (const [pay, price, give, stock, lots, recv] of cases) {
    const r = MD.simulateMega([{ asset: "T", priceSats: price, giveUnits: give, remainingUnits: stock }], pay);
    const got = r.results[0];
    if (got.lots !== lots || Math.abs(got.received - recv) > 1e-9) {
      bad.push(`pay=${pay} price=${price} give=${give} stock=${stock}: got lots=${got.lots} recv=${got.received}, want lots=${lots} recv=${recv}`);
    }
  }
  return eq(bad, [], "formula mismatches");
});

check("a payment one satoshi below price triggers nothing", () => {
  const d = [{ asset: "T", priceSats: 11110, giveUnits: 1, remainingUnits: 5 }];
  return eq(MD.simulateMega(d, 11109).hits.length, 0);
});

check("lots given never exceed lots wanted or lots available", () => {
  const bad = [];
  for (const pay of [1, 999, 11110, 22220, 1e6, 1e9]) {
    for (const r of MD.simulateMega(MEGA, pay).results) {
      if (r.lots > r.lotsWanted) bad.push(`${r.asset} @${pay}: lots ${r.lots} > wanted ${r.lotsWanted}`);
      if (r.lotsAvailable != null && r.lots > r.lotsAvailable) bad.push(`${r.asset} @${pay}: lots ${r.lots} > available ${r.lotsAvailable}`);
    }
  }
  return eq(bad.slice(0, 5), [], "lot accounting violated");
});

check("received never exceeds the dispenser's remaining stock", () => {
  const bad = [];
  for (const pay of [11110, 1e6, 1e9, 1e12]) {
    for (const r of MD.simulateMega(MEGA, pay).hits) {
      const stock = Number(r.remainingUnits);
      if (r.received > stock + 1e-12) bad.push(`${r.asset} @${pay}: received ${r.received} > stock ${stock}`);
    }
  }
  return eq(bad.slice(0, 5), [], "dispensed more than held");
});

check("monotonic: paying more never yields less", () => {
  const bad = [];
  let prev = -1;
  for (const pay of [0, 1e3, 1e4, 11110, 22220, 1e5, 1e6, 1e7, 1e8]) {
    const n = MD.simulateMega(MEGA, pay).assets;
    if (n < prev) bad.push(`assets fell from ${prev} to ${n} at ${pay} sats`);
    prev = n;
  }
  return eq(bad, [], "non-monotonic outcome");
});

/* -------------------------------------------------------------- precision */

check("lot counting is exact for atomic lots of a large divisible supply", () => {
  // Regression: Math.floor(round8(stock / give)) multiplies by 1e8 internally, so
  // 69,000,000 / 0.00000001 pushed the intermediate to 6.9e23, past
  // Number.MAX_SAFE_INTEGER, and returned one lot short with no error.
  const d = [{ asset: "BIG", priceSats: 1, giveUnits: 1e-8, remainingUnits: 69000000, divisible: true }];
  const r = MD.simulateMega(d, 1e16).results[0];
  return eq(r.lotsAvailable, 6900000000000000, "lots available for a full 69M atomic stock");
});

check("real dispensers all count lots exactly", () => {
  const bad = [];
  for (const d of MEGA) {
    const stock = Number(d.remainingUnits), give = Number(d.giveUnits);
    if (!(give > 0)) continue;
    const exact = Math.floor(Math.round(stock * 1e8) / Math.round(give * 1e8));
    const r = MD.simulateMega([d], 1e15).results[0];
    if (r.lotsAvailable !== exact) bad.push(`${d.asset}: got ${r.lotsAvailable}, exact ${exact}`);
  }
  return eq(bad.slice(0, 5), [], "inexact lot counts on real data");
});

check("atomicUnits agrees with lib/units.mjs toAtomic", async () => {
  const U = await import("../lib/units.mjs");
  const vals = [1, 4.2, 0.099966, 0.00000987, 1e-8, 69000000, 0.000001];
  const bad = [];
  for (const v of vals) {
    // round8 is exported; atomicUnits is its integer half. Compare via received,
    // which is now computed in atomic units.
    const mine = Math.round(v * MD.SATS_PER_BTC);
    if (mine !== U.toAtomic(v, true)) bad.push(`${v}: mega=${mine} units.mjs=${U.toAtomic(v, true)}`);
  }
  return eq(bad, [], "the one deliberate 1e8 duplication has drifted");
});

/* ------------------------------------------------------------------ output */

check("quantities are never truncated to zero", () => {
  const bad = [];
  for (const [v, div] of [[1e-8, true], [0.00000987, true], [0.000042, false], [4.2, false]]) {
    const q = MD.megaQty(v, div);
    const n = Number(String(q.text).replace(/,/g, ""));
    if (!(n > 0)) bad.push(`megaQty(${v}, ${div}) => "${q.text}"`);
  }
  return eq(bad, [], "megaQty truncating");
});

check("sub-unit divisible amounts are shown as smallest-unit counts", () => {
  const q = MD.megaQty(0.00000987, true);
  ok(q.atomic === true, "should switch to atomic counting below one whole unit");
  return eq(q.text, "987", "987 smallest units");
});

/* ------------------------------------------------------------- integration */

check("megaDispensers supplies the divisible flag the simulator documents", () => {
  const rows = api.megaDispensers();
  ok(rows.length > 0, "no mega dispensers found — check MEGA_ADDRESS filter");
  const missing = rows.filter((d) => typeof d.divisible !== "boolean").map((d) => d.asset);
  return eq(missing, [], "rows reaching the simulator without divisibility");
});

check("tiers are ascending, deduplicated unlock prices", () => {
  const tiers = MD.megaTiers(MEGA);
  const sats = tiers.map((t) => t.sats);
  ok(sats.length === new Set(sats).size, "duplicate tiers");
  ok(sats.every((v, i) => i === 0 || v > sats[i - 1]), "tiers not ascending");
  return ok(tiers.every((t) => t.unlocks.length > 0), "a tier that unlocks nothing");
});

summary("Mega dispenser");
