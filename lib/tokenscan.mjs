/**
 * TokenScan client — the reliable route to Counterparty asset data.
 *
 * The public Counterparty node (api.counterparty.io:4000) is frequently
 * unreachable: it sits on a non-standard port that many networks block, and it
 * goes down periodically. TokenScan mirrors the same chain data over ordinary
 * HTTPS and has proven stable, so it is the primary source for the asset list.
 *
 * Quirks worth knowing:
 *  - Page size is fixed at 100. Passing a larger limit is silently ignored.
 *  - Pagination is a path segment: /api/issuances/{address}/{page}
 *  - `total` counts issuance EVENTS, not distinct assets. A reissue, a lock and
 *    a transfer each add a row, so 1,340 events collapse to far fewer assets.
 *  - `asset_longname` is populated here (unlike some sources), which is how
 *    subassets such as RAREBEAR.POLARMEME become resolvable.
 *  - Cloudflare fronts it and rejects requests without a browser user-agent.
 */

const BASE = "https://tokenscan.io/api";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PAGE_SIZE = 100;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(pathname, { timeout = 30000, retries = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(BASE + pathname, {
        signal: c.signal,
        headers: { "User-Agent": UA, "Accept": "application/json" },
      });
      clearTimeout(t);
      if (r.status === 429 || r.status === 503) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) throw new Error("http " + r.status);
      const text = await r.text();
      if (/^\s*</.test(text)) throw new Error("html response (cloudflare?)");
      return JSON.parse(text);
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`tokenscan ${pathname}: ${lastErr?.message}`);
}

/** Address summary: { assets: { held, owned }, estimated_value }. */
export const addressInfo = addr => get(`/address/${addr}`);

/** Single asset, including its `description`. */
export const assetInfo = asset => get(`/asset/${encodeURIComponent(asset)}`);

/**
 * Every issuance event for an address, walked to completion.
 * onProgress receives (fetchedEvents, totalEvents).
 */
export async function allIssuances(addr, { onProgress } = {}) {
  const first = await get(`/issuances/${addr}/1`);
  const total = Number(first.total) || first.data?.length || 0;
  const rows = [...(first.data || [])];
  const pages = Math.ceil(total / PAGE_SIZE);

  onProgress?.(rows.length, total);

  for (let p = 2; p <= pages; p++) {
    try {
      const d = await get(`/issuances/${addr}/${p}`);
      const batch = d.data || [];
      if (!batch.length) break;
      rows.push(...batch);
      onProgress?.(rows.length, total);
    } catch (e) {
      console.error(`    page ${p} failed: ${e.message}`);
    }
    await sleep(250);
  }
  return rows;
}

/**
 * Collapse issuance events into one record per distinct asset, shaped like the
 * Counterparty v2 `/assets/issued` response so it drops straight into the
 * existing resolver.
 *
 * The latest valid issuance wins for description and lock state, because a
 * reissue can change them. Supply is summed across issuances, since that is how
 * Counterparty accumulates it. Transfer-only rows carry no supply and must not
 * clobber a real description.
 */
export function collapseIssuances(rows) {
  const byAsset = new Map();

  for (const r of rows) {
    if (r.status && r.status !== "valid") continue;
    const key = r.asset;
    const cur = byAsset.get(key) ?? {
      asset: key,
      asset_longname: r.asset_longname || null,
      issuer: r.issuer || r.source || null,
      owner: r.issuer || r.source || null,
      divisible: !!r.divisible,
      locked: !!r.locked,
      description: null,
      supply: 0,
      first_issuance_block_index: r.block_index ?? null,
      last_issuance_block_index: r.block_index ?? null,
      _events: 0,
    };

    cur._events++;
    if (r.asset_longname) cur.asset_longname = r.asset_longname;

    const qty = Number(r.quantity ?? 0);
    if (Number.isFinite(qty)) cur.supply += qty;

    // Later blocks reflect the current state.
    if ((r.block_index ?? 0) >= (cur.last_issuance_block_index ?? 0)) {
      cur.last_issuance_block_index = r.block_index ?? cur.last_issuance_block_index;
      cur.divisible = !!r.divisible;
      cur.locked = !!r.locked;
      if (r.transfer && r.issuer) cur.owner = r.issuer;
      // Don't let a transfer or lock row blank out an existing description.
      if (typeof r.description === "string" && r.description.length) cur.description = r.description;
    } else if (cur.description == null && typeof r.description === "string" && r.description.length) {
      cur.description = r.description;
    }

    if ((r.block_index ?? Infinity) < (cur.first_issuance_block_index ?? Infinity)) {
      cur.first_issuance_block_index = r.block_index;
    }

    byAsset.set(key, cur);
  }

  return [...byAsset.values()];
}

/**
 * Full order history for an address, walked to completion.
 *
 * This exists because "no DEX listings" and "DEX not supported" look identical
 * on a page that shows nothing. For this wallet all 148 orders are closed
 * (expired / filled / cancelled) and none are open, so the history is the only
 * DEX story there is — and the filled ones are real prices somebody paid, which
 * beats any floor estimate.
 *
 * Note orders can be denominated in ANY asset, not just BTC.
 */
export async function allOrders(addr, { onProgress } = {}) {
  const first = await get(`/orders/${addr}/1`);
  const total = Number(first.total) || first.data?.length || 0;
  const rows = [...(first.data || [])];
  const pages = Math.ceil(total / PAGE_SIZE);
  onProgress?.(rows.length, total);

  for (let p = 2; p <= pages; p++) {
    try {
      const d = await get(`/orders/${addr}/${p}`);
      const batch = d.data || [];
      if (!batch.length) break;
      rows.push(...batch);
      onProgress?.(rows.length, total);
    } catch (e) { console.error(`    orders page ${p} failed: ${e.message}`); }
    await sleep(250);
  }
  return rows;
}

/** Normalize an order row, keeping the status so the UI can be honest about it. */
export function normalizeOrder(o) {
  const num = v => (v == null ? 0 : Number(String(v)));
  return {
    give_asset: o.give_asset,
    give_asset_longname: o.give_asset_longname || null,
    give_quantity: num(o.give_quantity),
    give_remaining: num(o.give_remaining),
    get_asset: o.get_asset,
    get_asset_longname: o.get_asset_longname || null,
    get_quantity: num(o.get_quantity),
    get_remaining: num(o.get_remaining),
    status: o.status || null,
    block_index: o.block_index ?? null,
    timestamp: o.timestamp ?? null,
    tx_hash: o.tx_hash,
    source: o.source,
  };
}
