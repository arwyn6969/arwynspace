/**
 * Field-mismatch probe.
 *
 * This project's recurring defect is not a typo, it is reading a field name that is
 * real but belongs to a DIFFERENT collection. `give_asset` exists — on order history,
 * never on open orders — so `listingsFor()` filtering open orders by `give_asset`
 * matched nothing and silently emptied every artwork page's DEX listing. A global
 * "does this key exist anywhere in the data" scan comes back clean on that, which is
 * why three careful review passes each missed one instance.
 *
 * So: wrap every record from every collection in a Proxy that knows the union of keys
 * its OWN collection actually carries, run the shipping render functions over the real
 * data, and report every read of a key the collection does not have — attributed to the
 * exact app.js line that read it.
 *
 * Not every hit is a bug. Deliberate cross-schema tolerance (`o.giveAsset ?? o.give_asset`)
 * reads a key it knows may be absent and has a fallback. Those live in KNOWN_TOLERANT.
 * A hit outside that list is a read with no fallback, which is the defect.
 *
 * Usage:  node test/probe.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { loadWithData, ROOT, CLIENT_PATH } from "./harness.mjs";

/**
 * Functions whose whole job is to accept either schema. A read of an absent key
 * inside one of these is defended by design — the very next `??` supplies the
 * other spelling. Classified by SOURCE POSITION rather than by stack function
 * name, because V8 does not reliably name frames inside a vm-loaded script and a
 * misattributed frame would silently hide a real defect.
 */
const TOLERANT_FNS = ["readOrder", "readDispenser", "orderAssetNames"];

const BUILTIN = new Set([
  "then", "toJSON", "constructor", "valueOf", "toString", "length", "name",
  "inspect", "hasOwnProperty", "isPrototypeOf", Symbol.toPrimitive,
  Symbol.iterator, Symbol.toStringTag, "nodeType", "$$typeof",
]);

const misses = [];

function unionKeys(rows) {
  const s = new Set();
  for (const r of rows) if (r && typeof r === "object") for (const k of Object.keys(r)) s.add(k);
  return s;
}

/** Line ranges of the declared tolerant normalisers, read from the source itself. */
function tolerantRanges(srcLines) {
  const ranges = [];
  for (const name of TOLERANT_FNS) {
    const re = new RegExp(`^(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=)`);
    const start = srcLines.findIndex((l) => re.test(l));
    if (start === -1) continue;
    // These are all top-level declarations, so the body ends at the next
    // column-zero `}` or `];`.
    let end = srcLines.length;
    for (let i = start + 1; i < srcLines.length; i++) {
      if (/^(\}|\]\s*;?)/.test(srcLines[i])) { end = i; break; }
    }
    ranges.push({ name, start: start + 1, end: end + 1 });
  }
  return ranges;
}

/** First app.js frame's line number — position is reliable where the name is not. */
function blame() {
  for (const line of new Error().stack.split("\n")) {
    const loc = line.match(/app\.js:(\d+):/);
    if (loc) {
      const fn = line.match(/at\s+([A-Za-z_$][\w$]*)\s+\(/);
      return { fn: fn ? fn[1] : "(anonymous)", line: Number(loc[1]) };
    }
  }
  return { fn: "(unknown)", line: null };
}

function probe(row, collection, keys) {
  if (!row || typeof row !== "object") return row;
  return new Proxy(row, {
    get(t, prop, recv) {
      if (typeof prop === "string" && !BUILTIN.has(prop) && !keys.has(prop) && !(prop in Object.prototype)) {
        const who = blame();
        misses.push({ collection, key: prop, ...who });
      }
      return Reflect.get(t, prop, recv);
    },
    has(t, prop) { return Reflect.has(t, prop); },
  });
}

const { api, data } = loadWithData();

const collections = {
  "artworks.artworks": data.artworks.artworks,
  "market.dispensers": data.market.dispensers,
  "market.orders": data.market.orders,
  "market.orderHistory": data.market.orderHistory,
  "holders.leaderboard": data.holders.leaderboard || [],
};

const keysOf = {};
for (const [name, rows] of Object.entries(collections)) keysOf[name] = unionKeys(rows);

console.log("Collections and their real key counts:");
for (const [n, k] of Object.entries(keysOf)) {
  console.log(`  ${n.padEnd(22)} ${collections[n].length} rows, ${k.size} distinct keys`);
}

/* ---- exercise the shipping render functions over proxied records ---- */

const P = (rows, name) => rows.map((r) => probe(r, name, keysOf[name]));

const pArt = P(data.artworks.artworks, "artworks.artworks");
const pDisp = P(data.market.dispensers, "market.dispensers");
const pOrders = P(data.market.orders, "market.orders");
const pHist = P(data.market.orderHistory, "market.orderHistory");
const pLead = P(data.holders.leaderboard || [], "holders.leaderboard");

/**
 * Install the proxied rows INTO state, not merely alongside it.
 *
 * First attempt at this probe passed proxies as arguments only, and reported a clean
 * bill of health against a client with the D9 defect deliberately restored — because
 * listingsFor() reads state.market.orders directly and never saw a proxy. A checker
 * that cannot fail on a known bug is worse than no checker, since it manufactures
 * confidence. Everything the client can reach through state is proxied here.
 */
api.state.data = { ...data.artworks, artworks: pArt };
api.state.market = { ...data.market, dispensers: pDisp, orders: pOrders, orderHistory: pHist };
api.state.holders = { ...data.holders, leaderboard: pLead };

const artMap = new Map(pArt.map((a) => [a.asset, a]));

const safe = (label, fn) => { try { return fn(); } catch (e) { console.log(`  (threw in ${label}: ${e.message})`); } };

for (const r of pArt) {
  safe("card", () => api.card(r));
  safe("listingThumb", () => api.listingThumb(r));
  safe("signalBlock", () => api.signalBlock(r.asset));
  safe("isForSale", () => api.isForSale(r));
}
for (const d of pDisp) {
  const r = artMap.get(d.asset);
  safe("dispenserCard", () => api.dispenserCard(d, r, data.market));
  if (r) safe("dispenserRow", () => api.dispenserRow(d, r));
  safe("readDispenser", () => api.readDispenser(d));
}
for (const o of pOrders) {
  const r = api.orderArtwork(o, artMap);
  safe("orderCard", () => api.orderCard(o, r, false, artMap));
  if (r) safe("orderRow", () => api.orderRow(o, r));
  safe("listingsFor", () => api.listingsFor(o.asset ?? o.giveAsset, null));
  safe("orderTouchesCollection", () => api.orderTouchesCollection(o, artMap));
}
for (const o of pHist) {
  const r = api.orderArtwork(o, artMap);
  safe("orderCard/history", () => api.orderCard(o, r, true, artMap));
  safe("orderTouchesCollection", () => api.orderTouchesCollection(o, artMap));
}
safe("statusBreakdown", () => api.statusBreakdown(pHist));

/* ---- report ---- */

const grouped = new Map();
for (const m of misses) {
  const k = `${m.collection}|${m.key}|${m.fn}|${m.line}`;
  grouped.set(k, (grouped.get(k) || 0) + 1);
}

const srcLines = fs.readFileSync(CLIENT_PATH, "utf8").split("\n");
const ranges = tolerantRanges(srcLines);
console.log("\nTolerant-by-design regions (from source):");
for (const r of ranges) console.log(`  ${r.name.padEnd(18)} app.js:${r.start}-${r.end}`);

const inTolerant = (line) => ranges.some((r) => line >= r.start && line <= r.end);

const rows = [...grouped.entries()].map(([k, n]) => {
  const [collection, key, fn, line] = k.split("|");
  const ln = Number(line);
  return { collection, key, fn, line: ln, n, tolerant: inTolerant(ln) };
});

const bugs = rows.filter((r) => !r.tolerant);
const tolerated = rows.filter((r) => r.tolerant);

console.log(`\n=== Reads of keys absent from the queried collection ===`);
console.log(`${rows.length} distinct sites — ${bugs.length} unexplained, ${tolerated.length} known-tolerant\n`);

if (bugs.length) {
  console.log("UNEXPLAINED (no fallback — investigate each):");
  for (const b of bugs.sort((a, b2) => b2.n - a.n)) {
    console.log(`  ${b.collection.padEnd(22)} .${b.key.padEnd(20)} ${b.fn}  app.js:${b.line}  (${b.n}x)`);
  }
} else {
  console.log("UNEXPLAINED: none. Every absent-key read has a declared fallback.");
}

console.log("\nKNOWN-TOLERANT (normalisers trying both schemas — expected):");
const byFn = {};
for (const t of tolerated) (byFn[t.fn] = byFn[t.fn] || []).push(t.key);
for (const [fn, keys] of Object.entries(byFn)) {
  console.log(`  ${fn}: ${[...new Set(keys)].join(", ")}`);
}

process.exitCode = bugs.length ? 1 : 0;
