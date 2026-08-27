/**
 * Load the browser client under Node so its logic can be asserted directly.
 *
 * public/app.js is a plain script, not a module — it expects a DOM and ends with a
 * boot() call. This strips the boot, stubs just enough DOM for the top-level
 * `const view = $("#view")` and `window.imgFallback` to evaluate, then hands back
 * the client's own functions bound to the real data snapshots.
 *
 * The point is to test the SHIPPING code rather than a reimplementation of it.
 * Every defect this project has had was a mismatch between what the view read and
 * what the data carried, so a test that reimplements the view proves nothing.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Which client to load. Overridable so the probe can be pointed at a deliberately
 * broken copy and PROVED to detect the defect it exists to catch — a checker that
 * has never failed on a known bug is not evidence of anything.
 */
export const CLIENT_PATH = process.env.APP_JS
  ? path.resolve(process.env.APP_JS)
  : path.join(ROOT, "public/app.js");

/** Functions and values the tests are allowed to reach for. */
const EXPOSE = [
  "collectedRows", "collectedRow", "renderCollected", "pctOf", "pctPair", "concLabel",
  "state", "listingsFor", "isForSale", "orderAssetNames", "orderInvolves",
  "orderArtwork", "orderTouchesCollection", "readOrder", "readDispenser",
  "qty", "fmt", "fmtEff", "assetDivisible", "statusBreakdown", "statusKey",
  "shortStatus", "blockDate", "fmtDate", "effSupply", "supplyUnitsOf", "rankable",
  "nameOf", "thumbOf", "artworks", "artworkMap", "filtered", "signalsFor", "priceAmount",
  "btcAmt", "btc", "esc", "sortCollectors", "megaDispensers", "sortListings",
  "dispenserCard", "orderCard", "orderRow", "dispenserRow", "signalBlock",
  "card", "listingThumb", "collectorRow", "megaCard", "simulateMega", "megaTiers",
  "freshness", "dispenserFreshness", "SATS", "DIVISIBLE_OUTSIDE", "LINKS",
];

function stubEl() {
  const el = {
    style: {}, dataset: {}, innerHTML: "", textContent: "", value: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {},
    getAttribute: () => null, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, play() {},
    insertAdjacentHTML() {}, scrollIntoView() {}, getBoundingClientRect: () => ({}),
  };
  return el;
}

/**
 * The sibling plain scripts index.html loads BEFORE app.js. They publish
 * window.Collectors / window.Collected, which app.js reads at render time, so a
 * context without them is not the context the browser has. Loading them here keeps
 * the harness faithful and lets the probe see reads that happen inside them.
 */
const SIBLINGS = [
  path.join(ROOT, "public/collectors.js"),
  // Overridable for the same reason CLIENT_PATH is: the Collected suite has to be
  // pointed at a deliberately broken copy and required to fail, or its assertions
  // about absent-versus-zero are untested claims.
  process.env.COLLECTED_JS
    ? path.resolve(process.env.COLLECTED_JS)
    : path.join(ROOT, "public/collected.js"),
];

export function loadClient() {
  let src = fs.readFileSync(CLIENT_PATH, "utf8");
  // Do not run the app; we only want its functions.
  src = src.replace(/\bboot\s*\(\s*\)\s*;?\s*$/, "");

  const document = {
    querySelector: () => stubEl(), querySelectorAll: () => [],
    getElementById: () => stubEl(), createElement: stubEl,
    addEventListener() {}, removeEventListener() {},
    body: stubEl(), documentElement: stubEl(), head: stubEl(),
  };

  const ctx = {
    document, location: { hash: "", href: "http://localhost/" }, history: { pushState() {} },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    Image: class { set src(_v) {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    navigator: { userAgent: "node" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  for (const f of SIBLINGS) {
    vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: path.basename(f) });
  }

  // Collect whatever of EXPOSE actually exists, without throwing on the rest.
  src += `
;var __API__ = {};
for (const __k of ${JSON.stringify(EXPOSE)}) {
  try { const v = eval(__k); if (v !== undefined) __API__[__k] = v; } catch (_e) {}
}
`;
  vm.runInContext(src, ctx, { filename: "public/app.js" });
  const api = vm.runInContext("__API__", ctx);
  return { api, ctx };
}

/**
 * Load public/megadispenser.js and return the window.MegaDispenser it publishes.
 * Separate from loadClient() because it is an independent browser script with no
 * DOM dependency at all.
 */
export function loadMega() {
  const src = fs.readFileSync(path.join(ROOT, "public/megadispenser.js"), "utf8");
  const ctx = { console };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "public/megadispenser.js" });
  return vm.runInContext("window.MegaDispenser", ctx);
}

export function loadData() {
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  return {
    artworks: rd("public/data/artworks.json"),
    market: rd("public/data/market.json"),
    holders: rd("public/data/holders.json"),
  };
}

/** Client loaded with the real snapshots installed into its state, as in the browser. */
export function loadWithData() {
  const { api, ctx } = loadClient();
  const data = loadData();
  api.state.data = data.artworks;
  api.state.market = data.market;
  api.state.holders = data.holders;
  return { api, ctx, data };
}

/* ------------------------------ tiny test runner ------------------------------ */

const results = { pass: 0, fail: 0, failures: [] };

export function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("returned false");
    results.pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.fail++;
    results.failures.push({ name, message: e.message });
    console.log(`  FAIL  ${name}\n          ${e.message}`);
  }
}

export function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label ? label + ": " : ""}expected ${b}, got ${a}`);
  return true;
}

export function ok(cond, label = "assertion") {
  if (!cond) throw new Error(label);
  return true;
}

export function summary(title) {
  const { pass, fail } = results;
  console.log(`\n${title}: ${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of results.failures) console.log(`  - ${f.name}: ${f.message}`);
    process.exitCode = 1;
  }
  return fail === 0;
}
