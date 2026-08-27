/**
 * Outcome contract for the shipping client.
 *
 * The probe (test/probe.mjs) catches reads of keys a collection does not carry.
 * It structurally CANNOT catch the other half of this project's defect history:
 * reads that find a real key holding a real value that is nonetheless the wrong
 * value to display. D1 read `*_remaining`, which is legitimately 0 on a filled
 * order, and rendered all 44 sales as "0 offered / 0 traded for". D2 formatted
 * correct numbers through a bare toLocaleString() and truncated them to "0".
 * Neither is a missing key. Both are visible in the OUTPUT.
 *
 * So this suite asserts what the user actually sees, over the real snapshots:
 * every settled sale shows what it sold for, every dispenser shows a price, no
 * rendered surface contains a zero or a dash where the chain has a number.
 *
 * Usage:  node test/contract.test.mjs
 */
import { loadWithData, check, eq, ok, summary } from "./harness.mjs";

const { api, data } = loadWithData();
const M = data.market;
const arts = data.artworks.artworks.filter((a) => !a.excluded);
const artMap = new Map(arts.map((a) => [a.asset, a]));

/** Visible quantity strings from a rendered listing, in document order. */
const shown = (html) => [...html.matchAll(/<(?:span|b)>([^<>]*?)<\/(?:span|b)>/g)].map((m) => m[1].trim());
const GARBAGE = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/;

console.log("Outcome contract\n");

/* ---------------------------------------------------------------- listings */

check("every open order is discoverable via listingsFor for its own asset", () => {
  const missed = [];
  for (const o of M.orders) {
    const name = o.asset ?? o.giveAsset ?? o.give_asset;
    const r = artMap.get(name);
    const l = api.listingsFor(name, r?.assetLongname ?? null);
    if (!l.orders.length) missed.push(name);
  }
  return eq(missed, [], "orders invisible to the artwork page");
});

check("every dispenser is discoverable via listingsFor for its own asset", () => {
  const missed = M.dispensers
    .filter((d) => !api.listingsFor(d.asset, d.assetLongname ?? null).dispensers.length)
    .map((d) => d.asset);
  return eq(missed, [], "dispensers invisible to the artwork page");
});

check("isForSale agrees with the union of dispensers and open orders", () => {
  const expect = new Set();
  for (const d of M.dispensers) expect.add(d.asset);
  for (const o of M.orders) {
    const r = api.orderArtwork(o, artMap);
    if (r) expect.add(r.asset);
  }
  const actual = new Set(arts.filter((r) => api.isForSale(r)).map((r) => r.asset));
  return eq([...actual].sort(), [...expect].sort(), "for-sale set");
});

/* ------------------------------------------------------------------ orders */

const settled = M.orderHistory.filter((o) => o.status !== "open");
const filled = M.orderHistory.filter((o) => o.status === "filled");

check("settled orders report the original quantity, never the zeroed remainder", () => {
  const bad = [];
  for (const o of settled) {
    const od = api.readOrder(o);
    const gq = Number(o.give_quantity), rq = Number(o.get_quantity);
    if (gq > 0 && !(od.giveShown > 0)) bad.push(`${o.give_asset}: giveShown=${od.giveShown} but give_quantity=${gq}`);
    if (rq > 0 && !(od.getShown > 0)) bad.push(`${o.give_asset}: getShown=${od.getShown} but get_quantity=${rq}`);
  }
  return eq(bad.slice(0, 5), [], `${bad.length} settled orders with a zeroed side`);
});

check("open orders report what remains, not the original", () => {
  const bad = [];
  for (const o of M.orders) {
    const od = api.readOrder(o);
    const rem = Number(o.giveRemaining ?? o.give_remaining);
    if (Number.isFinite(rem) && od.giveShown !== rem) bad.push(`${o.asset}: giveShown=${od.giveShown} remaining=${rem}`);
  }
  return eq(bad, [], "open orders not showing remaining");
});

check("no filled sale renders a zero quantity", () => {
  const bad = [];
  for (const o of filled) {
    const r = api.orderArtwork(o, artMap);
    if (!r) continue;
    const html = api.orderCard(o, r, true, artMap);
    if (shown(html).some((s) => /^0(\s|$)/.test(s))) bad.push(`${o.give_asset}->${o.get_asset}: ${shown(html).join(" | ")}`);
  }
  return eq(bad.slice(0, 5), [], `${bad.length} filled sales rendering zero`);
});

check("settled-order labels never claim a sale that did not happen", () => {
  const bad = [];
  for (const o of settled) {
    if (o.status === "filled") continue;
    const r = api.orderArtwork(o, artMap);
    if (!r) continue;
    const html = api.orderCard(o, r, true, artMap);
    if (/\bsold\b|\bbought\b|traded for/.test(html)) bad.push(`${o.status}: ${o.give_asset}`);
  }
  return eq(bad.slice(0, 5), [], `${bad.length} unsold orders labelled as sold/traded`);
});

check("status breakdown accounts for every order", () => {
  const html = api.statusBreakdown(M.orderHistory);
  const nums = [...html.matchAll(/(\d+)\s+[a-z]/g)].map((m) => Number(m[1]));
  const total = nums.reduce((a, b) => a + b, 0);
  return eq(total, M.orderHistory.length, `breakdown "${html}" sums`);
});

/* -------------------------------------------------------------- dispensers */

check("every dispenser renders a non-zero BTC price", () => {
  const bad = M.dispensers
    .filter((d) => !(api.readDispenser(d).priceSats > 0))
    .map((d) => `${d.asset} priceSats=${api.readDispenser(d).priceSats}`);
  return eq(bad.slice(0, 5), [], `${bad.length} dispensers priced at zero`);
});

check("every dispenser row shows both quantities, no em-dashes", () => {
  const bad = [];
  for (const d of M.dispensers) {
    const r = artMap.get(d.asset);
    if (!r) continue;
    const html = api.dispenserRow(d, r);
    if (html.includes("—")) bad.push(`${d.asset}: ${html.replace(/\s+/g, " ").slice(0, 120)}`);
    if (/>0 BTC/.test(html)) bad.push(`${d.asset}: renders 0 BTC`);
  }
  return eq(bad.slice(0, 5), [], `${bad.length} dispenser rows with missing quantities`);
});

/* -------------------------------------------------------------- formatting */

check("small quantities survive formatting", () => {
  const vals = [0.0001111, 0.000042, 0.000003, 1e-8, 0.009, 4.2];
  const bad = [];
  for (const v of vals) {
    const s = api.qty(v, true);
    const back = Number(String(s).replace(/,/g, ""));
    if (!(back > 0)) bad.push(`qty(${v}) => "${s}"`);
    if (Math.abs(back - v) > v * 1e-6) bad.push(`qty(${v}) => "${s}" (lost precision)`);
  }
  return eq(bad, [], "formatter truncating small values");
});

check("fmt keeps small values non-zero", () => {
  const bad = [0.000042, 0.0001111, 0.000003].filter((v) => Number(String(api.fmt(v)).replace(/,/g, "")) === 0);
  return eq(bad, [], "fmt truncating to zero");
});

check("large values keep thousands separators and stay exact", () => {
  eq(api.qty(69000000, false), "69,000,000", "supply");
  return eq(Number(String(api.qty(100000, false)).replace(/,/g, "")), 100000);
});

/* ----------------------------------------------------------------- signals */

check("no price signal renders as zero", () => {
  const bad = [];
  for (const [asset, sigs] of Object.entries(M.signalsByAsset || {})) {
    for (const sig of sigs) {
      if (!(Number(sig.amount) > 0)) continue;
      const s = api.priceAmount(sig);
      if (/(^|\s)0(\s|$)/.test(s.replace(/<[^>]*>/g, ""))) bad.push(`${asset} ${sig.kind}: "${s}" from ${sig.amount}`);
    }
  }
  return eq(bad.slice(0, 5), [], `${bad.length} signals rendering zero`);
});

/* --------------------------------------------------------------- freshness */

check("freshness reports Live only when the data really is live", () => {
  const indexed = api.dispenserFreshness({ ...M, dispensersLive: undefined });
  const live = api.dispenserFreshness({ ...M, dispensersLive: true, dispensersFetchedAt: M.dispensersFetchedAt });
  ok(/Indexed/.test(indexed), `indexed data should read Indexed, got "${indexed}"`);
  ok(/Live/.test(live), `live data should read Live, got "${live}"`);
  return ok(!/Indexed/.test(live), "live badge must not also say Indexed");
});

check("indexed freshness carries the indexer's own timestamp", () => {
  ok(M.dispensersFetchedAt, "market.json must record when dispensers were scanned");
  const html = api.dispenserFreshness({ ...M, dispensersLive: undefined });
  const hhmm = new Date(M.dispensersFetchedAt).toISOString().slice(11, 16);
  return ok(html.includes(hhmm), `expected ${hhmm} in "${html}"`);
});

/* ------------------------------------------------------ rendered-output hygiene */

check("no rendered surface leaks undefined, NaN or null", () => {
  const bad = [];
  const test = (label, html) => { if (html && GARBAGE.test(html.replace(/<[^>]*>/g, " "))) bad.push(label); };
  for (const r of arts.slice(0, 200)) { test(`card:${r.asset}`, api.card(r)); test(`signals:${r.asset}`, api.signalBlock(r.asset)); }
  for (const d of M.dispensers) {
    const r = artMap.get(d.asset);
    test(`dispCard:${d.asset}`, api.dispenserCard(d, r, M));
    if (r) test(`dispRow:${d.asset}`, api.dispenserRow(d, r));
  }
  for (const o of [...M.orders, ...M.orderHistory]) {
    const r = api.orderArtwork(o, artMap);
    if (!r) continue;
    test(`orderCard:${o.give_asset ?? o.asset}`, api.orderCard(o, r, o.status !== "open", artMap));
    test(`orderRow:${o.give_asset ?? o.asset}`, api.orderRow(o, r));
  }
  return eq(bad.slice(0, 8), [], `${bad.length} surfaces leaking placeholder values`);
});

summary("Outcome contract");
