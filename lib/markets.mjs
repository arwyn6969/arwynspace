/**
 * Per-asset market discovery.
 *
 * The earlier version asked tokenscan for orders belonging to the artist's own
 * address, which made any market opened by somebody ELSE invisible. PUDSEC had
 * 22 orders; the address-scoped query found 1. Everything here is therefore keyed
 * by ASSET, not by address.
 *
 * Unit note: tokenscan returns quantities already in human units, unlike
 * stampchain and Counterparty which return raw integers. Every value that leaves
 * this module carries explicit `units`, and prices carry their denominating asset,
 * because orders here are frequently priced in something other than BTC.
 */

const BASE = "https://tokenscan.io/api";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = Number(String(v ?? "0")); return Number.isFinite(n) ? n : 0; };

async function get(pathname, { timeout = 25000, retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(BASE + pathname, { signal: c.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
      clearTimeout(t);
      if (r.status === 404) return null;
      if (r.status === 429 || r.status === 503) { await sleep(2500 * (i + 1)); continue; }
      if (!r.ok) throw new Error("http " + r.status);
      const text = await r.text();
      if (/^\s*</.test(text)) throw new Error("html (cloudflare?)");
      return JSON.parse(text);
    } catch (e) { clearTimeout(t); lastErr = e; if (i < retries - 1) await sleep(1200 * (i + 1)); }
  }
  throw new Error(`markets ${pathname}: ${lastErr?.message}`);
}

/* ---------------- orders ---------------- */

/**
 * Every order touching an asset, from any address, in either direction.
 * `side` distinguishes an offer to sell the asset from an offer to buy it.
 */
export async function ordersForAsset(asset) {
  const d = await get(`/orders/${encodeURIComponent(asset)}`);
  const rows = d?.data ?? [];
  return rows.map(o => {
    const selling = o.give_asset === asset;
    return {
      side: selling ? "ask" : "bid",
      status: o.status ?? null,
      giveAsset: o.give_asset,
      giveUnits: num(o.give_quantity),
      giveRemaining: num(o.give_remaining),
      getAsset: o.get_asset,
      getUnits: num(o.get_quantity),
      getRemaining: num(o.get_remaining),
      // Price expressed as "what you pay per one of the asset", in getAsset terms.
      pricePerUnit: selling
        ? (num(o.give_quantity) ? num(o.get_quantity) / num(o.give_quantity) : null)
        : (num(o.get_quantity) ? num(o.give_quantity) / num(o.get_quantity) : null),
      priceAsset: selling ? o.get_asset : o.give_asset,
      source: o.source,
      txHash: o.tx_hash,
      blockIndex: o.block_index ?? null,
      timestamp: o.timestamp ?? null,
    };
  });
}

/* ---------------- dispensers ---------------- */

/**
 * Dispensers for an asset, opened by anyone. tokenscan gives human units here,
 * and `satoshi_price` is confusingly expressed in BTC rather than satoshis, so it
 * is converted explicitly.
 */
export async function dispensersForAsset(asset) {
  const d = await get(`/dispensers/${encodeURIComponent(asset)}`);
  const rows = d?.data ?? [];
  return rows.map(x => {
    const btcPrice = num(x.satoshi_price);          // already BTC despite the name
    return {
      asset: x.asset,
      assetLongname: x.asset_longname || null,
      source: x.source,
      origin: x.origin ?? x.source,
      giveUnits: num(x.give_quantity),
      remainingUnits: num(x.give_remaining),
      escrowUnits: num(x.escrow_quantity),
      priceBtc: btcPrice,
      priceSats: Math.round(btcPrice * 1e8),
      status: x.status ?? null,
      closeBlockIndex: x.close_block_index ?? null,
      blockIndex: x.block_index ?? null,
      txHash: x.tx_hash,
      open: x.close_block_index == null && num(x.give_remaining) > 0,
    };
  });
}

/* ---------------- market summaries ---------------- */

/** 24h high / low / last per trading pair for an asset. */
export async function marketsForAsset(asset) {
  const d = await get(`/markets/${encodeURIComponent(asset)}`);
  const rows = d?.data ?? [];
  return rows.map(m => ({
    pairAsset: m.name ?? null,
    pairLongname: m.longname || null,
    high24: num(m["24hour"]?.high) || null,
    low24: num(m["24hour"]?.low) || null,
    last: num(m["24hour"]?.price) || null,
    changePct: m["24hour"]?.percent != null ? num(m["24hour"].percent) : null,
  })).filter(m => m.pairAsset);
}

/* ---------------- derived signals ---------------- */

/**
 * Collapse everything known about one asset into the price signals worth showing.
 *
 * Deliberately returns a LIST of signals rather than one number. A dispenser
 * price in BTC and a DEX ask denominated in PUDSEC are not comparable, so
 * flattening them into a single "floor" would invent a fact. Each signal keeps
 * its mechanism and its denominating asset.
 */
export function priceSignals({ orders = [], dispensers = [], markets = [] }) {
  const signals = [];

  const openDispensers = dispensers.filter(d => d.open && d.priceBtc > 0);
  if (openDispensers.length) {
    const cheapest = openDispensers.reduce((a, b) => (a.priceBtc <= b.priceBtc ? a : b));
    signals.push({
      kind: "floor", mechanism: "dispenser",
      amount: cheapest.priceBtc, asset: "BTC",
      perUnits: cheapest.giveUnits,
      note: openDispensers.length > 1 ? `lowest of ${openDispensers.length} dispensers` : null,
    });
  }

  const openAsks = orders.filter(o => o.side === "ask" && o.status === "open" && o.pricePerUnit != null);
  for (const asset of new Set(openAsks.map(o => o.priceAsset))) {
    const inAsset = openAsks.filter(o => o.priceAsset === asset);
    const cheapest = inAsset.reduce((a, b) => (a.pricePerUnit <= b.pricePerUnit ? a : b));
    signals.push({
      kind: "floor", mechanism: "dex",
      amount: cheapest.pricePerUnit, asset,
      note: inAsset.length > 1 ? `lowest of ${inAsset.length} asks` : null,
    });
  }

  const openBids = orders.filter(o => o.side === "bid" && o.status === "open" && o.pricePerUnit != null);
  for (const asset of new Set(openBids.map(o => o.priceAsset))) {
    const best = openBids.filter(o => o.priceAsset === asset)
      .reduce((a, b) => (a.pricePerUnit >= b.pricePerUnit ? a : b));
    signals.push({ kind: "bid", mechanism: "dex", amount: best.pricePerUnit, asset });
  }

  // Last completed trade. Filled orders carry a real agreed price.
  const filled = orders.filter(o => o.status === "filled" && o.pricePerUnit != null)
    .sort((a, b) => (b.blockIndex ?? 0) - (a.blockIndex ?? 0));
  if (filled.length) {
    const f = filled[0];
    signals.push({
      kind: "lastSale", mechanism: "dex",
      amount: f.pricePerUnit, asset: f.priceAsset,
      blockIndex: f.blockIndex, txHash: f.txHash,
      note: filled.length > 1 ? `${filled.length} completed trades` : null,
    });
  }

  for (const m of markets) {
    if (m.last) signals.push({ kind: "market24", mechanism: "dex", amount: m.last, asset: m.pairAsset, high: m.high24, low: m.low24, changePct: m.changePct });
  }

  return signals;
}

/** Walk a list of assets, gathering all three sources with polite pacing. */
export async function scanAssets(assets, { onProgress, pace = 220 } = {}) {
  const out = {};
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const rec = { orders: [], dispensers: [], markets: [], errors: [] };
    for (const [key, fn] of [["orders", ordersForAsset], ["dispensers", dispensersForAsset], ["markets", marketsForAsset]]) {
      try { rec[key] = await fn(asset) ?? []; }
      catch (e) { rec.errors.push(`${key}: ${e.message}`); }
      await sleep(pace);
    }
    rec.signals = priceSignals(rec);
    // Only keep assets that actually have market activity.
    if (rec.orders.length || rec.dispensers.length || rec.markets.length) out[asset] = rec;
    onProgress?.(i + 1, assets.length, asset, rec);
  }
  return out;
}
