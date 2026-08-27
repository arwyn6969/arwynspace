/* ============================================================
   Arwyn — digital art on Bitcoin
   Zero-dependency client. Reads the pre-resolved artwork index and
   layers live market/holder data on top when the API is reachable.
   ============================================================ */

const $  = (s, r = document) => r.querySelector(s);
const view = $("#view");

const state = {
  data: null,
  market: null,      // { dispensers, orders, btcPrice }
  holders: null,     // { byAsset, leaderboard }
  filter: "art",
  query: "",
  sort: "newest",          // newest | oldest | name | editions
  collectorFilter: "all",  // all | stamps | xcp
  collectedCohort: "collected",  // collected | uncollected | unknown
  collectedKind: "all",          // all | editions | tokens | stamps
  collectedMetric: "holders",    // see Collected.METRICS
  megaSats: 111100,        // simulator input, in satoshis
  mega: null,              // live mega dispenser state from /api/mega
  stats: null,             // live headline figures from /api/stats
  btcSpot: null,           // { usd, fetchedAt } — live spot, see loadBtcSpot()
  megaLoading: false,
};

/* Bitcoin block times are ~10 minutes, which is close enough to date a piece
   without spending 450 API calls resolving exact block timestamps. Anchored on a
   known height so the estimate doesn't drift. */
const BLOCK_ANCHOR = { height: 951504, ms: Date.UTC(2026, 5, 20) };
function blockDate(h) {
  if (!h) return null;
  return new Date(BLOCK_ANCHOR.ms - (BLOCK_ANCHOR.height - h) * 600000);
}
const blockYear = h => { const d = blockDate(h); return d ? d.getUTCFullYear() : null; };
const fmtDate = h => {
  const d = blockDate(h);
  return d ? d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : "—";
};

/** The asset's real name always leads; a curated title is secondary. */
const nameOf = r => r.assetLongname || r.asset;
const subtitleOf = r => {
  const c = r.curatedName && r.curatedName !== nameOf(r) ? r.curatedName : null;
  return c || null;
};

/* ---------------- helpers ---------------- */

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SATS = 1e8;
const btc = sats => (sats / SATS).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
const btcAmt = b => Number(b).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
/**
 * Number formatting. A bare toLocaleString() defaults to maximumFractionDigits: 3,
 * which rendered 0.0001111 as "0" — that silently zeroed 15 of 28 floor signals and
 * 28 of 73 24h figures. Chain values carry 8 decimals, so 8 is the correct ceiling.
 */
const fmt = n => {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return v.toLocaleString("en-US", { maximumFractionDigits: 8 });
};

/**
 * Quantities reaching the client are ALREADY in human units — the indexer
 * normalises every source before writing. This function therefore only formats;
 * it must never scale. An earlier version divided by 1e8 here, which made every
 * divisible asset read one hundred million times too small (PUDSEC's supply of
 * 69,000,000 displayed as 0.69).
 */
function qty(units, divisible) {
  if (units == null) return "—";
  const n = Number(units);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  // Up to 8 places regardless of the divisible flag. The previous version routed
  // non-divisible values through a bare toLocaleString(), which defaults to 3
  // fraction digits and turned 0.0001111 into "0". Showing full precision on an
  // indivisible asset is also the right call: a fractional balance there is an
  // anomaly worth surfacing rather than rounding away.
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** Supply in human units, whichever field the record carries. */
const supplyUnitsOf = r => Number(r.supplyUnits ?? r.supply ?? 0) || 0;

/**
 * Effective supply: how many separately ownable things exist. The smallest unit
 * counts as one, exactly as a 1-of-1 counts as one, so a divisible asset has 1e8
 * ownable units per whole unit. Equals the chain's own raw integer.
 */
const effSupply = r => (r.effectiveSupply != null ? r.effectiveSupply
  : Math.round(supplyUnitsOf(r) * (r.divisible ? SATS : 1)));

/**
 * Trailing-zero trim. Must stay identical to `trimZeros` in lib/units.mjs, which
 * this file cannot import; test/units.test.mjs asserts the two agree. The earlier
 * form stripped only ".00", so 7.00 became "7" while 6.90 stayed "6.90".
 */
const trimZeros = s => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

function fmtEff(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e15) return trimZeros((n / 1e15).toFixed(2)) + "Q";
  if (abs >= 1e12) return trimZeros((n / 1e12).toFixed(2)) + "T";
  if (abs >= 1e9)  return trimZeros((n / 1e9).toFixed(2))  + "B";
  if (abs >= 1e6)  return trimZeros((n / 1e6).toFixed(2))  + "M";
  // Delegate rather than repeat a bare toLocaleString(), which is what truncated
  // small values to "0" everywhere else.
  return fmt(n);
}

/** Never minted (zero supply, unlocked) has no claim to rarity; locked zero does. */
const rankable = r => {
  const u = supplyUnitsOf(r);
  return u > 0 || !!r.locked;
};

const MEGA_ADDRESS = "1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j";

const shortAddr = a => (!a ? "—" : a.length <= 16 ? a : `${a.slice(0, 7)}…${a.slice(-5)}`);

/** Grid uses the light rendition; detail uses the larger one. */
const thumbOf   = r => r.media?.thumb || r.media?.image || null;
const displayOf = r => r.media?.image || r.media?.thumb || null;

const hasVideo = r => !!r.media?.animationUrl;
const hasAudio = r => !!r.media?.audioUrl;
const hasHtml  = r => !!r.media?.htmlUrl;

/* ---------------- external links ---------------- */

const LINKS = {
  xcpio:      a => `https://www.xcp.io/asset/${encodeURIComponent(a)}`,
  horizon:    a => `https://horizon.market/asset/${encodeURIComponent(a)}`,
  pepewtf:    a => `https://pepe.wtf/asset/${encodeURIComponent(a)}`,
  tokenscan:  a => `https://tokenscan.io/asset/${encodeURIComponent(a)}`,
  stampchain: a => `https://stampchain.io/stamp/${encodeURIComponent(a)}`,
  addr:       a => `https://www.xcp.io/address/${encodeURIComponent(a)}`,
};

/* ---------------- boot ---------------- */

async function boot() {
  // The single-file bundle inlines its data; the deployed site fetches it.
  if (window.__ARTWORKS__) {
    state.data = window.__ARTWORKS__;
    if (window.__MARKET__)  state.market  = window.__MARKET__;
    if (window.__HOLDERS__) state.holders = window.__HOLDERS__;
  } else {
    try {
      const r = await fetch("./data/artworks.json", { cache: "no-cache" });
      state.data = await r.json();
    } catch {
      view.innerHTML = `<div class="wrap"><div class="empty">Could not load the collection index.</div></div>`;
      return;
    }
  }

  const cfgName = state.data.artistName || "Arwyn";
  $("#artist-name").textContent = cfgName;
  document.title = `${cfgName} — Digital Art on Bitcoin`;

  updateFootMeta();

  window.addEventListener("hashchange", route);
  route();

  // Live data is additive: the site is fully usable if these never arrive.
  loadStats();
  loadMarket();
  loadHolders();
  loadLiveDispensers();
  // Cheapest and highest-value of the lot: one keyless call that stops every USD
  // figure inheriting the snapshot's price. See loadBtcSpot().
  loadBtcSpot();
}

function updateFootMeta() {
  const c = state.data?.counts || {};
  const st = state.stats;
  const el = $("#foot-meta");
  if (!el) return;
  el.innerHTML =
    `Artwork index built ${esc(new Date(state.data.generatedAt).toISOString().slice(0, 16).replace("T", " "))} UTC` +
    `<br>${c.artworks ?? 0} works indexed · ${c.tokenOpsExcluded ?? 0} token ops filtered` +
    (st?.chainHeight ? `<br>Chain height ${fmt(st.chainHeight)} · live` : "");
}

/**
 * Live BTC spot price.
 *
 * WHY THIS IS NOT LEFT TO THE SNAPSHOT
 *
 * Every USD figure on the site is a BTC amount multiplied by a price, and the price
 * was only ever read from market.json — so on a static deploy it froze at index
 * time. Measured on 27 Aug 2026: the snapshot said $63,955 while spot was $79,892,
 * a 25% error on every dispenser price, price signal and simulator projection. The
 * asset list drifts slowly and a daily re-index handles it; the BTC price does not,
 * and no re-index cadence fixes a number that moves hourly.
 *
 * One call, CORS-open, no key. If it fails the snapshot value still stands — but
 * btcUsd() reports which source it used so the UI can say so rather than passing a
 * month-old price off as current.
 */
async function loadBtcSpot() {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", { cache: "no-cache" });
    if (!r.ok) throw 0;
    const usd = Number((await r.json())?.data?.amount);
    if (!Number.isFinite(usd) || usd <= 0) throw 0;
    state.btcSpot = { usd, fetchedAt: new Date().toISOString() };
    route();
  } catch { /* snapshot price remains the fallback; btcUsd() will label it indexed */ }
}

/**
 * The BTC price to convert with, and where it came from.
 *
 * Never returns a number without saying whether it is live, because the whole point
 * of the exercise is that a stale price and a current one are different facts.
 * Returns usd: null when neither source has a figure — callers must render nothing
 * rather than a zero.
 */
function btcUsd() {
  if (state.btcSpot?.usd) {
    return { usd: state.btcSpot.usd, live: true, at: state.btcSpot.fetchedAt };
  }
  const snap = state.market?.btcPrice ?? null;
  return { usd: snap, live: false, at: snap ? (state.market?.generatedAt ?? null) : null };
}

/**
 * Live headline figures. Counts baked at build time go stale the moment an asset
 * is issued or moved, and this is a living collection — so anything cheap enough
 * to fetch live, is.
 */
async function loadStats() {
  try {
    const r = await fetch("./api/stats", { cache: "no-cache" });
    if (!r.ok) throw 0;
    state.stats = await r.json();
    updateFootMeta();
    route();
  } catch { /* the indexed snapshot remains the fallback */ }
}

/**
 * Live mega dispenser state, refetched whenever the page is opened.
 *
 * This must not be cached in the bundle: prices and remaining stock change with
 * every purchase, and a stale snapshot would promise tokens that are already gone.
 */
async function loadMega({ force = false } = {}) {
  if (state.megaLoading) return;
  if (state.mega && !force) return;
  state.megaLoading = true;
  if (force) route();
  // Two independent live routes, then the snapshot. The serverless endpoint is
  // preferred because it normalises units server-side, but stampchain sends
  // Access-Control-Allow-Origin: * — so the browser can read chain state directly
  // even on a purely static build with no backend at all.
  try {
    const r = await fetch("./api/mega", { cache: "no-cache" });
    if (r.ok) {
      const j = await r.json();
      if (j?.dispensers?.length) { state.mega = j; return; }
    }
    throw 0;
  } catch {
    try {
      state.mega = await fetchMegaDirect();
    } catch {
      // Both live routes failed. Fall back to the indexed snapshot and say so
      // rather than presenting stale stock as current.
      state.mega = null;
    }
  } finally {
    state.megaLoading = false;
    route();
  }
}

/**
 * Live dispenser state read straight from stampchain in the browser.
 *
 * Works with no backend because stampchain is CORS-open. Its quantities are RAW
 * integers — the chain's smallest-unit counts — so divisible assets need dividing
 * by 1e8 to reach human units. `asset_info.divisible` on each row tells us which.
 */
async function fetchMegaDirect() {
  const url = `https://stampchain.io/api/v2/stamps/dispensers/${MEGA_ADDRESS}?limit=500`;
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error("stampchain " + r.status);
  const j = await r.json();

  const dispensers = [];
  for (const row of j?.data ?? []) {
    if (row.close_block_index != null) continue;
    const divisible = !!row.asset_info?.divisible;
    const scale = divisible ? SATS : 1;
    const remainingUnits = (Number(row.give_remaining) || 0) / scale;
    const giveUnits = (Number(row.give_quantity) || 0) / scale;
    if (remainingUnits <= 0 || giveUnits <= 0) continue;

    dispensers.push({
      asset: row.cpid,
      assetLongname: row.asset_info?.asset_longname || null,
      source: row.source || MEGA_ADDRESS,
      priceSats: Number(row.satoshirate) || 0,
      priceBtc: Number(row.btcrate) || (Number(row.satoshirate) || 0) / SATS,
      giveUnits,
      remainingUnits,
      divisible,
    });
  }
  dispensers.sort((a, b) => a.priceSats - b.priceSats);
  if (!dispensers.length) throw new Error("no open dispensers");

  return {
    live: true,
    via: "stampchain-direct",
    fetchedAt: new Date().toISOString(),
    address: MEGA_ADDRESS,
    btcPrice: btcUsd().usd,
    units: "human",
    dispensers,
  };
}

/**
 * Live dispensers across every wallet, read directly from stampchain.
 *
 * Dispenser stock is the fastest-moving thing on the site, so it should never come
 * from a build snapshot. Orders and the collector leaderboard stay indexed because
 * they need a call per asset — hundreds of them — which is not something to do on
 * page load. Each figure is labelled with which of the two it is.
 */
async function loadLiveDispensers() {
  const addresses = state.data?.addresses || [];
  if (!addresses.length) return;

  const results = await Promise.all(addresses.map(async addr => {
    try {
      const r = await fetch(`https://stampchain.io/api/v2/stamps/dispensers/${addr}?limit=500`, { cache: "no-cache" });
      if (!r.ok) return null;
      return { addr, json: await r.json() };
    } catch { return null; }
  }));

  const rows = [];
  let reachable = 0;
  for (const res of results) {
    if (!res) continue;
    reachable++;
    for (const row of res.json?.data ?? []) {
      if (row.close_block_index != null) continue;
      const divisible = !!row.asset_info?.divisible;
      const scale = divisible ? SATS : 1;
      const remainingUnits = (Number(row.give_remaining) || 0) / scale;
      const giveUnits = (Number(row.give_quantity) || 0) / scale;
      if (remainingUnits <= 0 || giveUnits <= 0) continue;
      rows.push({
        asset: row.cpid,
        assetLongname: row.asset_info?.asset_longname || null,
        source: row.source || res.addr,
        priceSats: Number(row.satoshirate) || 0,
        priceBtc: Number(row.btcrate) || (Number(row.satoshirate) || 0) / SATS,
        giveUnits, remainingUnits, divisible,
        txHash: row.tx_hash,
        origin: "stampchain-live",
      });
    }
  }

  // Only replace the snapshot if every wallet answered. A partial read would
  // silently drop listings and make pieces look unavailable — the same failure
  // mode that wrecked the holder data.
  if (reachable === addresses.length && rows.length) {
    state.market = { ...(state.market || {}), dispensers: rows, dispensersLive: true, dispensersFetchedAt: new Date().toISOString() };
    route();
  }
}

async function loadMarket() {
  try {
    const r = await fetch("./api/market", { cache: "no-cache" });
    if (!r.ok) throw 0;
    state.market = await r.json();
  } catch {
    try { const r2 = await fetch("./data/market.json", { cache: "no-cache" }); if (r2.ok) state.market = await r2.json(); } catch {}
  }
  if (state.market) route();
}

async function loadHolders() {
  try {
    const r = await fetch("./api/holders", { cache: "no-cache" });
    if (!r.ok) throw 0;
    state.holders = await r.json();
  } catch {
    try { const r2 = await fetch("./data/holders.json", { cache: "no-cache" }); if (r2.ok) state.holders = await r2.json(); } catch {}
  }
  if (state.holders) route();
}

/* ---------------- router ---------------- */

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [seg, arg] = h.split("/");
  document.querySelectorAll(".nav a").forEach(a => a.classList.remove("on"));

  if (seg === "art" && arg) return renderDetail(decodeURIComponent(arg));
  if (seg === "collected")  { markNav("collected");  return renderCollected(); }
  if (seg === "collectors") { markNav("collectors"); return renderCollectors(); }
  if (seg === "market")     { markNav("market");     return renderMarket(); }
  if (seg === "mega")       { markNav("mega"); loadMega(); return renderMega(); }
  if (seg === "about")      { markNav("about");      return renderAbout(); }
  markNav("gallery");
  renderGallery();
}

const markNav = r => { const a = document.querySelector(`.nav a[data-route="${r}"]`); if (a) a.classList.add("on"); };

/* ---------------- listings lookup ---------------- */

/**
 * Listings that concern one asset. Matches on longname as well as name, and routes
 * order matching through orderInvolves() rather than reading a field name directly —
 * the previous version filtered open orders on `give_asset`, a key that only exists
 * on order HISTORY, so it matched zero of them and no artwork page ever showed a
 * DEX listing.
 */
function listingsFor(asset, longname = null) {
  const m = state.market;
  if (!m) return { dispensers: [], orders: [] };
  return {
    dispensers: (m.dispensers || []).filter(d =>
      d.asset === asset || (!!longname && d.assetLongname === longname)),
    orders: (m.orders || []).filter(o => orderInvolves(o, asset, longname)),
  };
}

/** Takes the record rather than a bare name, so the longname is always available. */
const isForSale = r => {
  if (!r) return false;
  const l = listingsFor(r.asset, r.assetLongname);
  return l.dispensers.length > 0 || l.orders.length > 0;
};

/* ---------------- gallery ---------------- */

function artworks() { return (state.data.artworks || []).filter(a => !a.excluded); }

function filtered() {
  let rows = artworks();
  const f = state.filter;
  // Default view is work that actually has artwork. 111 assets in this wallet
  // were registered without any discoverable media — showing them as empty
  // frames buries the real collection, so they live behind their own filter.
  if (f === "art")     rows = rows.filter(r => r.hasMedia);
  if (f === "nomedia") rows = rows.filter(r => !r.hasMedia);
  if (f === "stamps")  rows = rows.filter(r => r.isStamp && r.hasMedia);
  if (f === "xcp")     rows = rows.filter(r => !r.isStamp && r.hasMedia);
  if (f === "forsale") rows = rows.filter(r => isForSale(r));

  const q = state.query.trim().toLowerCase();
  if (q) rows = rows.filter(r =>
    r.asset.toLowerCase().includes(q) ||
    (r.assetLongname || "").toLowerCase().includes(q) ||
    (r.title || "").toLowerCase().includes(q) ||
    (r.text || "").toLowerCase().includes(q));

  return sortRows(rows);
}

/** Ordering was previously media-then-type-then-alphabetical, which read as random. */
function sortRows(rows) {
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b));
  const arr = [...rows];
  switch (state.sort) {
    case "oldest":   return arr.sort((a, b) => (a.firstBlock ?? 9e9) - (b.firstBlock ?? 9e9) || byName(a, b));
    case "name":     return arr.sort(byName);
    case "editions": return arr.sort((a, b) => {
      // Rarest first, by separately ownable units. Never-minted pieces sit last
      // regardless of direction, since they have no supply to compare.
      const ra = rankable(a), rb = rankable(b);
      if (ra !== rb) return ra ? -1 : 1;
      return effSupply(a) - effSupply(b) || byName(a, b);
    });
    case "newest":
    default:         return arr.sort((a, b) => (b.firstBlock ?? 0) - (a.firstBlock ?? 0) || byName(a, b));
  }
}

const SORTS = [
  ["newest", "Newest"], ["oldest", "Oldest"], ["name", "A–Z"], ["editions", "Rarest"],
];

function sortControl() {
  return `<div class="sortbar" role="group" aria-label="Sort">
    ${SORTS.map(([k, label]) =>
      `<button class="sortbtn ${state.sort === k ? "on" : ""}" data-s="${k}">${esc(label)}</button>`).join("")}
  </div>`;
}

function bindSort(rerender) {
  view.querySelectorAll(".sortbtn").forEach(el =>
    el.addEventListener("click", () => { state.sort = el.dataset.s; rerender(); }));
}

function renderGallery() {
  const all = artworks();
  const counts = {
    art: all.filter(r => r.hasMedia).length,
    all: all.length,
    nomedia: all.filter(r => !r.hasMedia).length,
    stamps: all.filter(r => r.isStamp && r.hasMedia).length,
    xcp: all.filter(r => !r.isStamp && r.hasMedia).length,
    forsale: all.filter(r => isForSale(r)).length,
  };
  const rows = filtered();
  const c = state.data.counts || {};
  const st = state.stats?.complete ? state.stats : null;

  view.innerHTML = `
  <div class="wrap">
    <section class="hero">
      <h1>Art issued<br><span class="thin">on Bitcoin.</span></h1>
      <p class="hero-sub">
        Pixel art, paintings, animation and video issued as Counterparty tokens and Bitcoin Stamps —
        each one an entry in Bitcoin's ledger rather than a file on a server. The collection grows and
        moves, so the figures below say whether they came from the chain just now or from the last index.
      </p>
      <div class="stat-strip">
        <div class="stat"><b>${counts.art}</b><span>Works with art</span></div>
        <div class="stat"><b>${counts.stamps}</b><span>Bitcoin Stamps</span></div>
        <div class="stat"><b>${counts.xcp}</b><span>Counterparty</span></div>
        ${st ? `<div class="stat live"><b>${fmt(st.assetsOwned)}</b><span>Assets owned · live</span></div>` : ""}
        <div class="stat ${st ? "live" : ""}"><b>${st ? fmt(st.openDispensers) : (counts.forsale || "—")}</b><span>Open dispensers${st ? " · live" : ""}</span></div>
      </div>
      <div class="freshrow">
        ${freshness(false, state.data.generatedAt)}
        <span class="freshnote">Artwork resolution is indexed — it costs thousands of API calls, so it
        refreshes on a schedule rather than per visit. Dispensers, prices and the mega dispenser are live.</span>
      </div>
    </section>

    <div class="toolbar">
      <div class="chips">
        ${chip("art", "Everything", counts.art)}
        ${chip("stamps", "Bitcoin Stamps", counts.stamps)}
        ${chip("xcp", "Counterparty", counts.xcp)}
        ${chip("forsale", "For sale", counts.forsale)}
        ${counts.nomedia ? chip("nomedia", "No art found", counts.nomedia) : ""}
      </div>
      ${sortControl()}
      <label class="search">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input type="search" placeholder="Search the collection" value="${esc(state.query)}" aria-label="Search">
      </label>
    </div>

    ${rows.length ? `<div class="grid">${rows.map(card).join("")}</div>`
                  : `<div class="empty">Nothing matches that.</div>`}
  </div>`;

  view.querySelectorAll(".chip").forEach(el =>
    el.addEventListener("click", () => { state.filter = el.dataset.f; renderGallery(); }));
  bindSort(renderGallery);

  const input = $(".search input", view);
  input.addEventListener("input", e => {
    state.query = e.target.value;
    const g = $(".grid", view);
    const rows2 = filtered();
    if (g) g.innerHTML = rows2.map(card).join("") || "";
    bindCards();
  });

  bindCards();
}

const chip = (f, label, n) =>
  `<button class="chip ${state.filter === f ? "on" : ""}" data-f="${f}">${esc(label)}<span class="n">${n}</span></button>`;

function card(r) {
  const src = thumbOf(r);
  const px = r.pixelate ? " pixel" : "";
  const sale = isForSale(r);

  let visual;
  if (hasVideo(r)) {
    // Video gets a poster plus an explicit play affordance rather than relying on
    // hover, which is invisible on touch and undiscoverable on desktop.
    visual = (src
        ? `<img class="${px.trim()}" src="${esc(src)}" alt="${esc(nameOf(r))}" loading="lazy" decoding="async">`
        : `<div class="noart"><span>▶</span><span>Video</span></div>`)
      + `<span class="playmark" aria-hidden="true">▶</span>`;
  } else if (src) {
    // Arweave gateways rate-limit and will occasionally 403 a thumbnail. Carry the
    // remaining renditions on the element so a failed load steps down the chain
    // instead of leaving an empty frame.
    const chain = [...new Set([r.media?.image, r.media?.original].filter(u => u && u !== src))];
    // Kaleidoscope's WebP renditions have animation stripped, so an animated piece
    // must load its original GIF to move. That's deferred until the card scrolls
    // into view, because these originals run to several megabytes each.
    const anim = r.animated && r.animatedUrl && r.animatedUrl !== src ? r.animatedUrl : null;
    visual = `<img class="${px.trim()}" src="${esc(src)}" alt="${esc(nameOf(r))}" loading="lazy" decoding="async"` +
      (anim ? ` data-anim="${esc(anim)}"` : "") +
      (chain.length ? ` data-fallback="${esc(chain.join("|"))}"` : "") + ` onerror="imgFallback(this)">`;
  } else if (hasHtml(r)) {
    visual = `<div class="noart"><span>◫</span><span>HTML stamp</span></div>`;
  } else {
    visual = `<div class="noart"><span>⌗</span><span>No image on chain</span></div>`;
  }

  const badges = [
    r.isStamp ? `<span class="badge stamp">Stamp${r.stampNumber ? " #" + r.stampNumber : ""}</span>` : `<span class="badge xcp">XCP</span>`,
    sale ? `<span class="badge forsale">For sale</span>` : "",
  ].filter(Boolean).join("");

  const dim = r.media?.originalDims || r.media?.dims;

  return `
  <article class="card" data-a="${esc(r.asset)}" tabindex="0">
    <div class="frame">${visual}<div class="badges">${badges}</div></div>
    <div class="meta">
      <div class="t">${esc(nameOf(r))}</div>
      ${subtitleOf(r) ? `<div class="t2">${esc(subtitleOf(r))}</div>` : ""}
      <div class="s">
        <span>${rankable(r)
          ? `${qty(supplyUnitsOf(r), r.divisible)}${r.divisible ? " units" : " ed."}`
          : "not minted"}</span>
        ${r.firstBlock ? `<span class="dot">·</span><span>${esc(fmtDate(r.firstBlock))}</span>` : ""}
        ${dim ? `<span class="dot">·</span><span>${dim.w}×${dim.h}</span>` : ""}
      </div>
    </div>
  </article>`;
}

let animObserver = null;

function bindCards() {
  view.querySelectorAll(".card").forEach(el => {
    const go = () => { location.hash = `#/art/${encodeURIComponent(el.dataset.a)}`; };
    el.addEventListener("click", go);
    el.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });

  // Swap in animated originals as cards reach the viewport, so the page doesn't
  // fetch dozens of multi-megabyte GIFs on load.
  animObserver?.disconnect();
  if ("IntersectionObserver" in window) {
    animObserver = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        const anim = img.dataset.anim;
        if (anim) { img.src = anim; delete img.dataset.anim; }
        animObserver.unobserve(img);
      }
    }, { rootMargin: "200px" });
    view.querySelectorAll("img[data-anim]").forEach(img => animObserver.observe(img));
  } else {
    view.querySelectorAll("img[data-anim]").forEach(img => { img.src = img.dataset.anim; });
  }
}

/**
 * Step an <img> down its remaining renditions when a load fails, and if nothing
 * is left, replace it with the same empty-frame treatment used when a piece has
 * no art at all — so a gateway hiccup never shows a broken-image icon.
 */
window.imgFallback = function (el) {
  const rest = (el.dataset.fallback || "").split("|").filter(Boolean);
  const next = rest.shift();
  if (next) {
    el.dataset.fallback = rest.join("|");
    el.src = next;
    return;
  }
  el.onerror = null;
  const frame = el.closest(".frame") || el.closest(".stage");
  if (frame) frame.innerHTML = `<div class="noart"><span>\u2337</span><span>Image unavailable</span></div>` +
    (frame.querySelector(".badges")?.outerHTML || "");
};

/* ---------------- detail ---------------- */

function renderDetail(asset) {
  const r = artworks().find(x => x.asset === asset);
  if (!r) {
    view.innerHTML = `<div class="wrap"><a class="back" href="#/">← Collection</a><div class="empty">Unknown piece.</div></div>`;
    return;
  }

  const px = r.pixelate ? " pixel" : "";
  const src = displayOf(r);

  let stage;
  if (hasHtml(r)) {
    stage = `<iframe src="${esc(r.media.htmlUrl)}" sandbox="allow-scripts allow-same-origin" title="${esc(r.title || r.asset)}"></iframe>`;
  } else if (hasVideo(r)) {
    stage = `<video class="${px.trim()}" src="${esc(r.media.animationUrl)}" controls loop playsinline ${src ? `poster="${esc(src)}"` : ""}></video>`;
  } else if (src) {
    const chain = [...new Set([r.media?.original, r.media?.thumb].filter(u => u && u !== src))];
    stage = `<img id="stage-img" class="${px.trim()}" src="${esc(src)}" alt="${esc(r.title || r.asset)}"` +
      (chain.length ? ` data-fallback="${esc(chain.join("|"))}"` : "") + ` onerror="imgFallback(this)">`;
  } else {
    stage = `<div class="noart"><span>⌗</span><span>No image resolvable on chain</span></div>`;
  }

  const zoomTarget = r.media?.original || src;
  const tools = [];
  if (src) tools.push(`<button class="tool" id="zoom">Zoom</button>`);
  if (r.media?.original) tools.push(`<a class="tool" href="${esc(r.media.original)}" target="_blank" rel="noopener noreferrer">Original${r.media.originalDims ? ` ${r.media.originalDims.w}×${r.media.originalDims.h}` : ""}</a>`);
  if (r.media?.animationUrl && r.media.animationUrl !== r.media.original) tools.push(`<a class="tool" href="${esc(r.media.animationUrl)}" target="_blank" rel="noopener noreferrer">Video file</a>`);

  const { dispensers, orders } = listingsFor(r.asset, r.assetLongname);
  const holders = state.holders?.byAsset?.[r.asset] || null;
  // Read through the same normaliser the Collected view uses, so the two pages can
  // never disagree about the same piece — and so an unmeasured piece renders as
  // "not measured" here too rather than silently omitting the row.
  const dist = window.Collected ? window.Collected.readHolding(holders) : null;

  view.innerHTML = `
  <div class="wrap">
    <a class="back" href="#/">← Collection</a>
    <div class="detail">
      <div>
        <div class="stage">
          ${stage}
          ${tools.length ? `<div class="stage-tools">${tools.join("")}</div>` : ""}
        </div>
        ${hasAudio(r) ? `<div class="audio-bar"><audio controls src="${esc(r.media.audioUrl)}"></audio></div>` : ""}
        ${(r.note || r.warnings?.length) ? `<div class="section-h"><h3>Notes</h3><div class="rule"></div></div>
          <div class="notice">${[r.note, ...(r.warnings || [])].filter(Boolean).map(w => esc(w)).join("<br>")}</div>` : ""}
      </div>

      <div>
        <h2 class="piece">${esc(r.title || r.asset)}</h2>
        <div class="piece-sub">${r.isStamp ? `Bitcoin Stamp${r.stampNumber ? " #" + r.stampNumber : ""}` : "Counterparty asset"}${r.assetLongname ? " · subasset" : ""}</div>
        ${r.artist ? `<div class="byline">Art by ${esc(r.artist)}</div>` : ""}

        ${r.descriptionHtml ? `<div class="prose-html">${sanitize(r.descriptionHtml)}</div>`
          : r.text ? `<div class="prose">${esc(r.text)}</div>` : ""}

        <dl class="facts">
          ${fact("Name", `<a href="${LINKS.xcpio(r.assetLongname || r.asset)}" target="_blank" rel="noopener noreferrer">${esc(r.assetLongname || r.asset)}</a>`)}
          ${r.assetLongname ? fact("Asset ID", esc(r.asset)) : ""}
          ${fact(r.divisible ? "Supply" : "Editions", rankable(r)
            ? qty(supplyUnitsOf(r), r.divisible)
            : `<span class="no">not minted</span>`)}
          ${fact("Divisible", r.divisible
            ? `<span class="yes">yes</span> — splits into 100,000,000 per unit`
            : `<span class="no">no</span>`)}
          ${rankable(r) ? fact("Ownable units", `${fmtEff(effSupply(r))}${r.divisible
            ? ` <span class="hint">(supply × 100,000,000)</span>` : ""}`) : ""}
          ${fact("Supply locked", r.locked ? `<span class="yes">yes</span>` : `<span class="no">no</span>`)}
          ${r.media?.imageMime ? fact("Format", esc(r.media.imageMime)) : ""}
          ${(r.media?.originalDims || r.media?.dims) ? fact("Dimensions", (() => { const d = r.media.originalDims || r.media.dims; return `${d.w} × ${d.h}`; })()) : ""}
          ${fact("Scaling", r.pixelate ? "nearest-neighbour (pixel art)" : "smooth")}
          ${dist ? fact("Holders", dist.dataOk
            ? (dist.holders > 0 ? fmt(dist.holders) : `<span class="no">none yet — artist-held</span>`)
            : `<span class="no">not measured</span>`) : ""}
          ${dist?.measured ? fact("Reach", `${pctOf(dist.reachPct)} <span class="hint">of existing supply held by collectors</span>`) : ""}
          ${fact("Issuer", `<a href="${LINKS.addr(r.issuer)}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(r.issuer))}</a>`)}
          ${r.artist ? fact("Artist", esc(r.artist)) : ""}
          ${r.tags?.length ? fact("Tags", r.tags.map(t => esc(t)).join(", ")) : ""}
          ${r.durationSeconds ? fact("Duration", `${Math.round(r.durationSeconds)}s`) : ""}
          ${r.ipfsCid ? fact("IPFS", `<a href="https://ipfs.io/ipfs/${esc(r.ipfsCid)}" target="_blank" rel="noopener noreferrer">${esc(r.ipfsCid.slice(0, 22))}…</a>`) : ""}
          ${fact("Metadata", esc((r.sources || []).join(", ") || "—"))}
        </dl>

        ${signalsFor(r.asset).length ? `
          <div class="section-h"><h3>Price signals</h3><div class="rule"></div></div>
          ${signalBlock(r.asset)}` : ""}

        ${dispensers.length || orders.length ? `
          <div class="section-h"><h3>Available now</h3><div class="rule"></div></div>
          ${dispensers.map(d => dispenserRow(d, r)).join("")}
          ${orders.map(o => orderRow(o, r)).join("")}
        ` : `
          <div class="section-h"><h3>Availability</h3><div class="rule"></div></div>
          <div class="notice plain">No open dispenser or exchange order for this piece right now.</div>
        `}

        <div class="links-row">
          <a class="btn ghost" href="${LINKS.xcpio(r.asset)}" target="_blank" rel="noopener noreferrer">xcp.io</a>
          <a class="btn ghost" href="${LINKS.horizon(r.asset)}" target="_blank" rel="noopener noreferrer">Horizon</a>
          <a class="btn ghost" href="${LINKS.tokenscan(r.asset)}" target="_blank" rel="noopener noreferrer">Tokenscan</a>
          ${r.isStamp ? `<a class="btn ghost" href="${LINKS.stampchain(r.asset)}" target="_blank" rel="noopener noreferrer">Stampchain</a>` : ""}
          ${r.website ? `<a class="btn ghost" href="${esc(/^https?:/.test(r.website) ? r.website : "https://" + r.website)}" target="_blank" rel="noopener noreferrer">Artist link</a>` : ""}
        </div>

        ${dist?.measured && dist.holders > 0 ? `
          <div class="section-h"><h3>Distribution</h3><div class="rule"></div></div>
          <div class="distblock">
            <div class="distbar">
              <i class="ext" style="width:${Math.max(0, Math.min(100, dist.reachPct || 0)).toFixed(1)}%"></i>
            </div>
            <div class="distlegend">
              <span><i class="sw ext"></i>${pctPair(dist.reachPct).part} with collectors</span>
              <span><i class="sw art"></i>${pctPair(dist.reachPct).rest} still artist-held</span>
              ${dist.burnUnits ? `<span><i class="sw burn"></i>${qty(dist.burnUnits, r.divisible)} burned</span>` : ""}
            </div>
            <dl class="facts tight">
              ${dist.holders > 1 ? fact("Top holder", `${pctOf(dist.top1Share)} of what's out`) : ""}
              ${dist.holders > 5 ? fact("Top five", `${pctOf(dist.top5Share)} of what's out`) : ""}
              ${dist.holders > 1 && concLabel(dist.hhi) ? fact("Spread", esc(concLabel(dist.hhi))) : ""}
              ${!r.divisible && dist.externalUnits != null ? fact("Editions out", fmt(Math.round(dist.externalUnits))) : ""}
            </dl>
          </div>` : ""}

        ${holders?.top?.length ? `
          <div class="section-h"><h3>Held by</h3><div class="rule"></div><span class="count">${fmt(dist?.holders ?? holders.count)}</span></div>
          <div class="table-scroll"><table class="table">
            <thead><tr><th class="rank">#</th><th>Address</th><th class="num">Editions</th></tr></thead>
            <tbody>${holders.top.map((h, i) => `
              <tr><td class="rank ${i === 0 ? "top" : ""}">${i + 1}</td>
                  <td><a class="addr" href="${LINKS.addr(h.address)}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(h.address))}</a></td>
                  <td class="num">${fmt(h.quantity)}</td></tr>`).join("")}
            </tbody></table></div>` : ""}
      </div>
    </div>
  </div>`;

  const zoom = $("#zoom", view);
  if (zoom) zoom.addEventListener("click", () => lightbox(zoomTarget, r.pixelate));
  const si = $("#stage-img", view);
  if (si) { si.style.cursor = "zoom-in"; si.addEventListener("click", () => lightbox(zoomTarget, r.pixelate)); }
  window.scrollTo(0, 0);
}

const fact = (k, v) => `<div class="fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;

/** Allow only presentational tags from third-party metadata HTML. */
function sanitize(html) {
  return String(html)
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

function lightbox(src, pixel) {
  if (!src) return;
  const el = document.createElement("div");
  el.className = "lb";
  el.innerHTML = `<span class="close">esc / click to close</span><img class="${pixel ? "pixel" : ""}" src="${esc(src)}" alt="">`;
  const kill = () => { el.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") kill(); };
  el.addEventListener("click", kill);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(el);
}

/* ---------------- market rows ---------------- */

/**
 * Normalise a dispenser row, whichever schema it arrived in.
 *
 * The market scan writes camelCase (priceSats / giveUnits / remainingUnits); the
 * older stampchain-shaped rows are snake_case (satoshirate / give_quantity /
 * give_remaining). The detail page read only the snake_case names, so against
 * current data every buy row rendered "0 BTC" with em-dashes for both quantities —
 * the same read-a-key-that-isn't-there fault as the order and freshness bugs.
 */
function readDispenser(d) {
  const n = v => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const priceSats = n(d.priceSats) ?? n(d.satoshirate) ?? (n(d.priceBtc) != null ? Math.round(n(d.priceBtc) * SATS) : null);
  return {
    priceSats: priceSats ?? 0,
    giveUnits: n(d.giveUnits) ?? n(d.give_quantity),
    remainingUnits: n(d.remainingUnits) ?? n(d.give_remaining),
    asset: d.asset ?? null,
    assetLongname: d.assetLongname ?? d.asset_longname ?? null,
  };
}

function dispenserRow(d, r) {
  const dd = readDispenser(d);
  const bp = btcUsd();
  const usd = bp.usd ? ` · $${((dd.priceSats / SATS) * bp.usd).toFixed(2)}` : "";
  return `
  <div class="buy-row">
    <div class="left">
      <div class="price">${btc(dd.priceSats)} BTC<small>Dispenser${usd ? esc(usd) : ""}</small></div>
      <div class="qty">${qty(dd.giveUnits, r.divisible)} per purchase · ${qty(dd.remainingUnits, r.divisible)} left</div>
    </div>
    <a class="btn" href="${LINKS.xcpio(r.assetLongname || r.asset)}" target="_blank" rel="noopener noreferrer">Buy →</a>
  </div>`;
}

function orderRow(o, r) {
  const od = readOrder(o);
  const map = new Map(artworks().map(a => [a.asset, a]));
  // The paired asset's real divisibility, not a hardcoded false. XCP is divisible.
  const getDiv = assetDivisible(od.getAsset, map);
  const getting = `${qty(od.getShown, getDiv)} ${esc(od.getAssetLongname || od.getAsset || "")}`;
  return `
  <div class="buy-row">
    <div class="left">
      <div class="price">${getting}<small>${od.isOpen ? "DEX order" : `DEX · ${esc(shortStatus(od.status))}`}</small></div>
      <div class="qty">${od.isFilled ? "traded for" : "for"} ${qty(od.giveShown, r.divisible)} ${esc(nameOf(r))}</div>
    </div>
    ${od.isOpen ? `<a class="btn" href="${LINKS.horizon(r.assetLongname || r.asset)}" target="_blank" rel="noopener noreferrer">Trade →</a>` : ""}
  </div>`;
}



/* ---------------- order reading ---------------- */

/**
 * Assets whose divisibility is known without consulting the collection index.
 * Orders can be denominated in ANY asset, including ones this artist never issued.
 */
const DIVISIBLE_OUTSIDE = { XCP: true, BTC: true, PEPECASH: true };

/** Divisibility of any asset an order names, collection member or not. */
function assetDivisible(name, map) {
  if (!name) return false;
  if (Object.prototype.hasOwnProperty.call(DIVISIBLE_OUTSIDE, name)) return DIVISIBLE_OUTSIDE[name];
  const r = map?.get(name);
  return r ? !!r.divisible : false;
}

/**
 * Normalise an order and pick the quantities that actually mean something for its state.
 *
 * Two schemas reach the client: open orders arrive camelCase from the market scan,
 * history arrives snake_case from tokenscan. More importantly, `*_remaining` is
 * ZERO on a filled order — that is what "filled" means. An earlier nullish chain
 * read remaining first, and `??` cannot fall through zero, so all 44 completed
 * sales rendered as "0 offered / 0 traded for".
 *
 * So: an open order shows what is still on the table; a settled one shows what the
 * trade was actually for.
 */
/** Does this order involve a collection asset, on either side? */
function orderTouchesCollection(o, map) {
  return orderArtwork(o, map) != null;
}

/**
 * Every asset name an order might carry, on either side, in either schema.
 *
 * SINGLE SOURCE OF TRUTH — do not inline this list anywhere else. Open orders
 * arrive camelCase from the market scan (`giveAsset`); history arrives snake_case
 * from tokenscan (`give_asset`). `listingsFor()` once read only `give_asset` and
 * so matched nothing at all against the open-order collection, which silently
 * removed every DEX listing from the artwork pages and the for-sale filter.
 * That was the fourth "right field, wrong collection" defect in this project.
 * Anything that needs to ask "which asset is this order about" comes through here.
 */
const orderAssetNames = o => [
  o.giveAsset, o.give_asset, o.giveAssetLongname, o.give_asset_longname,
  o.getAsset,  o.get_asset,  o.getAssetLongname,  o.get_asset_longname,
  o.asset,
].filter(Boolean);

/** The collection asset an order refers to, whichever side it sits on. */
function orderArtwork(o, map) {
  for (const n of orderAssetNames(o)) if (map.has(n)) return map.get(n);
  return null;
}

/** Does this order concern one specific asset, under either its name or longname? */
function orderInvolves(o, asset, longname) {
  const names = orderAssetNames(o);
  return (!!asset && names.includes(asset)) || (!!longname && names.includes(longname));
}

function readOrder(o) {
  const n = v => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const status = o.status ?? null;
  const isOpen = status == null || status === "open";

  const giveOriginal  = n(o.giveUnits)     ?? n(o.give_quantity);
  const giveRemaining = n(o.giveRemaining) ?? n(o.give_remaining);
  const getOriginal   = n(o.getUnits)      ?? n(o.get_quantity);
  const getRemaining  = n(o.getRemaining)  ?? n(o.get_remaining);

  return {
    raw: o,
    status,
    isOpen,
    // "Settled" is not "sold". Of 154 history events only 44 filled; 98 expired,
    // 10 were cancelled and 2 were invalid. Labelling every non-open order as a
    // sale claims 101 trades that never happened, so the wording keys off this
    // rather than off !isOpen.
    isFilled: status === "filled",
    giveAsset: o.giveAsset ?? o.give_asset ?? null,
    getAsset:  o.getAsset  ?? o.get_asset  ?? null,
    giveAssetLongname: o.giveAssetLongname ?? o.give_asset_longname ?? null,
    getAssetLongname:  o.getAssetLongname  ?? o.get_asset_longname  ?? null,
    giveShown: isOpen ? (giveRemaining ?? giveOriginal) : (giveOriginal ?? giveRemaining),
    getShown:  isOpen ? (getRemaining  ?? getOriginal)  : (getOriginal  ?? getRemaining),
    // Open orders carry blockIndex; history carries block_index.
    blockIndex: o.blockIndex ?? o.block_index ?? null,
    txHash: o.txHash ?? o.tx_hash ?? null,
  };
}

/* ---------------- price signals ---------------- */

/**
 * Signals are rendered as a LIST, not collapsed into one number. A dispenser
 * price in BTC and a DEX ask denominated in PUDSEC aren't comparable, so
 * flattening them would invent a fact. Each keeps its mechanism and denomination.
 */
const SIGNAL_LABEL = {
  floor: "Floor", bid: "Best bid", lastSale: "Last sale", market24: "24h last",
};

function signalsFor(asset) {
  return state.market?.signalsByAsset?.[asset] || [];
}

function priceAmount(sig) {
  if (sig.asset === "BTC") {
    const bp = btcUsd();
    const usd = bp.usd ? ` · $${(sig.amount * bp.usd).toFixed(2)}` : "";
    return `${btcAmt(sig.amount)} BTC${usd}`;
  }
  // 24h signals name a trading PAIR ("FAUXCORNHOLE/PUDSEC"), not a single asset.
  // Printing that where a ticker belongs read as though it were one asset's symbol.
  const amount = fmt(Number(sig.amount.toPrecision(6)));
  if (typeof sig.asset === "string" && sig.asset.includes("/")) {
    const [base, quote] = sig.asset.split("/");
    return `${amount} ${esc(quote)} <span class="pairnote">per ${esc(base)}</span>`;
  }
  return `${amount} ${esc(sig.asset)}`;
}

function signalBlock(asset) {
  const sigs = signalsFor(asset);
  if (!sigs.length) return "";
  const order = { floor: 0, lastSale: 1, bid: 2, market24: 3 };
  const rows = [...sigs].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  return `
  <div class="signals">
    ${rows.map(sig => `
      <div class="sig s-${esc(sig.kind)}">
        <div class="sig-k">${esc(SIGNAL_LABEL[sig.kind] || sig.kind)}</div>
        <div class="sig-v">${priceAmount(sig)}</div>
        <div class="sig-m">${esc(sig.mechanism === "dex" ? "exchange" : sig.mechanism)}${sig.note ? " · " + esc(sig.note) : ""}</div>
      </div>`).join("")}
  </div>`;
}

/* ---------------- shared: the collection, keyed ---------------- */

const COLLECTORS_SHOWN = 150;

/**
 * Every collectible piece, keyed by asset — not just the ones whose media resolved.
 *
 * The collectors page ranks by distinct pieces held, a figure the indexer computes
 * over everything a holder owns. Resolving those holdings through a media-only map
 * meant `pieces` and the stamps/Counterparty split were counted over different sets,
 * so 272 of 896 collectors displayed a total that did not equal its own parts —
 * "52 pieces · 30 stamps · 20 Counterparty". Over the full collection every holding
 * resolves and all 896 reconcile exactly. Thumbnails filter for media themselves.
 */
function artworkMap() {
  return new Map(artworks().map(a => [a.asset, a]));
}

/* ---------------- collected ---------------- */

const COLLECTED_SHOWN = 120;

/** Percentages: one decimal below 10, none above, em-dash for genuinely absent. */
const pctOf = n => (n == null ? "—" : `${Number(n).toFixed(Number(n) < 10 && Number(n) > 0 ? 1 : 0)}%`);

/**
 * A percentage and its complement, formatted with the SAME precision so the pair
 * reads as a whole. pctOf's variable precision is right for a lone figure but wrong
 * for two halves of one bar: 98.5 and 1.5 came out as "99%" and "1.5%", which
 * appears to sum to 100.5 and makes a correct measurement look like a broken one.
 */
function pctPair(n) {
  if (n == null) return { part: "—", rest: "—" };
  const v = Math.max(0, Math.min(100, Number(n)));
  const dp = (v % 1 === 0 && (100 - v) % 1 === 0) ? 0 : 1;
  return { part: `${v.toFixed(dp)}%`, rest: `${(100 - v).toFixed(dp)}%` };
}

/**
 * Herfindahl over external holders, read as a sentence. The raw index means nothing
 * to a reader; the thresholds are the conventional competition-authority bands.
 */
function concLabel(hhi) {
  if (hhi == null) return null;
  if (hhi >= 5000) return "one holder dominates";
  if (hhi >= 2500) return "concentrated";
  if (hhi >= 1500) return "moderately spread";
  return "widely spread";
}

/** Every piece with its holder-distribution stats, ready to rank. */
function collectedRows() {
  const CD = window.Collected;
  const map = artworkMap();
  const sales = CD.salesIndex(state.market, map);
  const byAsset = state.holders?.byAsset || {};
  return artworks().map(a => CD.assetStats(a, byAsset[a.asset], sales));
}

function renderCollected() {
  const CD = window.Collected;

  if (!state.holders) {
    view.innerHTML = `<div class="wrap"><section class="hero"><h1>Collected</h1></section>
      <div class="loading"><span class="spinner"></span>Reading holder balances…</div></div>`;
    return;
  }

  const rows = collectedRows();
  const summary = CD.collectedSummary(rows);
  const groups = CD.cohorts(rows);
  const cohort = state.collectedCohort;

  let pool = groups[cohort] || groups.collected;
  if (state.collectedKind === "editions") pool = pool.filter(r => !r.divisible);
  if (state.collectedKind === "tokens")   pool = pool.filter(r => r.divisible);
  if (state.collectedKind === "stamps")   pool = pool.filter(r => r.isStamp);

  const q = state.query.trim().toLowerCase();
  if (q) pool = pool.filter(r => r.name.toLowerCase().includes(q) || r.title.toLowerCase().includes(q));

  // Ranking only applies where the numbers exist. The unknown cohort has nothing to
  // rank by, so it is listed by name rather than pretending to an order.
  const metric = cohort === "unknown" ? "name" : state.collectedMetric;
  const ranked = CD.rankBy(pool, metric);
  const shown = ranked.slice(0, COLLECTED_SHOWN);

  view.innerHTML = `
  <div class="wrap">
    <section class="hero" style="padding-bottom:1.25rem">
      <h1>Collected</h1>
      <p class="hero-sub">Which pieces have actually found holders. Rank is by number of
      <strong>collectors</strong>, with <strong>reach</strong> — the share of a piece's existing
      supply sitting in someone else's wallet — in the next column, because a large holder count
      can still mean the artist holds nearly all of it.</p>
      <div class="stat-strip">
        <div class="stat"><b>${fmt(summary.collected)}</b><span>Pieces collected</span></div>
        <div class="stat"><b>${pctOf(summary.collectedPctOfMeasured)}</b><span>Of those measured</span></div>
        <div class="stat"><b>${fmt(summary.relationships)}</b><span>Holder relationships</span></div>
        <div class="stat"><b>${summary.hasDistribution ? pctOf(summary.medianReach) : fmt(summary.medianHolders)}</b>
          <span>${summary.hasDistribution ? "Median reach" : "Median holders"}</span></div>
      </div>
    </section>

    ${summary.hasDistribution ? "" : `<div class="notice">Reach and concentration are not in
      this snapshot yet — they are measured over the full holder list when the holder index
      next runs. Holder counts and market activity below are current.</div>`}

    <div class="section-h"><h3>Where the collection stands</h3><div class="rule"></div></div>
    <div class="cohort-cards">
      <div class="cohort-card ${cohort === "collected" ? "on" : ""}">
        <div class="cohort-n">${fmt(summary.collected)}</div>
        <div class="cohort-name">Collected</div>
        <p>Held by at least one address that isn't the artist.</p>
      </div>
      <div class="cohort-card ${cohort === "uncollected" ? "on" : ""}">
        <div class="cohort-n">${fmt(summary.uncollected)}</div>
        <div class="cohort-name">Not yet collected</div>
        <p>Issued and held entirely in the artist's own wallets.</p>
      </div>
      <div class="cohort-card ${cohort === "unknown" ? "on" : ""}">
        <div class="cohort-n">${fmt(summary.unknown)}</div>
        <div class="cohort-name">Not measured</div>
        <p>The holder fetch failed for these. Unknown — not zero.</p>
      </div>
    </div>

    ${summary.widest || summary.deepestReach ? `
      <div class="headline-facts">
        ${summary.widest ? `<div><span>Most collectors</span>
          <a href="#/art/${encodeURIComponent(summary.widest.asset)}">${esc(summary.widest.name)}</a>
          <em>${fmt(summary.widest.holders)} addresses</em></div>` : ""}
        ${summary.deepestReach && summary.deepestReach.measured ? `<div><span>Furthest distributed
          (${CD.REACH_HEADLINE_MIN_HOLDERS}+ collectors)</span>
          <a href="#/art/${encodeURIComponent(summary.deepestReach.asset)}">${esc(summary.deepestReach.name)}</a>
          <em>${pctOf(summary.deepestReach.reachPct)} out, ${fmt(summary.deepestReach.holders)} holders</em></div>` : ""}
        ${summary.mostConcentrated ? `<div><span>Most concentrated</span>
          <a href="#/art/${encodeURIComponent(summary.mostConcentrated.asset)}">${esc(summary.mostConcentrated.name)}</a>
          <em>top holder has ${pctOf(summary.mostConcentrated.top1Share)}</em></div>` : ""}
        ${summary.withSales ? `<div><span>Traded on the DEX</span>
          <strong>${fmt(summary.withSales)} pieces</strong>
          <em>${fmt(summary.withDispensers)} with a dispenser</em></div>` : ""}
      </div>` : ""}

    <div class="toolbar" style="margin-top:2.5rem">
      <div class="chips">
        ${dchip("collected", "Collected", groups.collected.length)}
        ${dchip("uncollected", "Not yet collected", groups.uncollected.length)}
        ${dchip("unknown", "Not measured", groups.unknown.length)}
      </div>
      <div class="chips">
        ${kchip("all", "All")}
        ${kchip("editions", "Editions")}
        ${kchip("tokens", "Divisible")}
        ${kchip("stamps", "Stamps")}
      </div>
      ${cohort === "unknown" ? "" : collectedSortControl()}
      <label class="search">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input type="search" placeholder="Search piece" value="${esc(state.query)}" aria-label="Search pieces">
      </label>
    </div>

    ${metric === "editions" ? `<p class="explainer">Editions out counts indivisible pieces only.
      A divisible balance is a token quantity, not a number of ownable editions.</p>` : ""}
    ${metric === "concentration" || metric === "spread"
      ? `<p class="explainer">Concentration is measured across a piece's external holders only,
         so pieces with a single holder are excluded — one holder is not a distribution.</p>` : ""}

    ${shown.length
      ? `<div class="table-scroll"><table class="table ctable">
          <thead><tr>
            <th class="rank">#</th><th>Piece</th>
            <th class="num">Holders</th>
            ${summary.hasDistribution ? `<th class="num">Reach</th><th class="num">Top holder</th>` : ""}
            <th class="num">Editions out</th><th class="num">Market</th>
          </tr></thead>
          <tbody>${shown.map((r, i) => collectedRow(r, i, summary.hasDistribution)).join("")}</tbody>
        </table></div>`
      : `<div class="empty">Nothing matches that.</div>`}
    ${ranked.length > COLLECTED_SHOWN
      ? `<p class="foot-note" style="padding:1.5rem 0 4rem">Showing ${COLLECTED_SHOWN} of ${fmt(ranked.length)}.</p>`
      : `<div style="height:4rem"></div>`}
  </div>`;

  view.querySelectorAll(".chip[data-c]").forEach(el =>
    el.addEventListener("click", () => { state.collectedCohort = el.dataset.c; renderCollected(); }));
  view.querySelectorAll(".chip[data-k]").forEach(el =>
    el.addEventListener("click", () => { state.collectedKind = el.dataset.k; renderCollected(); }));
  view.querySelectorAll(".sortbtn").forEach(el =>
    el.addEventListener("click", () => { state.collectedMetric = el.dataset.s; renderCollected(); }));
  const input = $(".search input", view);
  if (input) input.addEventListener("input", e => { state.query = e.target.value; renderCollected(); });
  view.querySelectorAll(".ctable tr[data-a]").forEach(el =>
    el.addEventListener("click", e => {
      if (e.target.closest("a")) return;
      location.hash = `#/art/${encodeURIComponent(el.dataset.a)}`;
    }));
}

const dchip = (c, label, n) =>
  `<button class="chip ${state.collectedCohort === c ? "on" : ""}" data-c="${c}">${esc(label)}<span class="n">${n}</span></button>`;
const kchip = (k, label) =>
  `<button class="chip ${state.collectedKind === k ? "on" : ""}" data-k="${k}">${esc(label)}</button>`;

function collectedSortControl() {
  return `<div class="sortbar" role="group" aria-label="Rank pieces">
    ${window.Collected.METRICS.map(([k, label]) =>
      `<button class="sortbtn ${state.collectedMetric === k ? "on" : ""}" data-s="${k}">${esc(label)}</button>`).join("")}
  </div>`;
}

function collectedRow(r, i, showDist) {
  const th = thumbOf(r.artwork);
  // An unmeasured piece gets an em-dash, never a zero. The whole point of the
  // cohort split is that "nobody holds this" and "we could not find out" are
  // different facts, and a 0 in this cell would erase the difference.
  const holders = r.dataOk ? fmt(r.holders) : `<span class="unk" title="Holder data unavailable">—</span>`;
  const eds = r.divisible
    ? `<span class="hint">n/a</span>`
    : (r.editionsOut != null ? fmt(Math.round(r.editionsOut)) : `<span class="unk">—</span>`);

  return `
  <tr data-a="${esc(r.asset)}" class="crow-t">
    <td class="rank ${i < 3 ? "top" : ""}">${i + 1}</td>
    <td class="cpiece">
      ${th ? `<img src="${esc(th)}" alt="" loading="lazy" class="${r.artwork.pixelate ? "pixel" : ""}">`
           : `<span class="noimg" aria-hidden="true">⌗</span>`}
      <span class="cnames">
        <a href="#/art/${encodeURIComponent(r.asset)}">${esc(r.name)}</a>
        <em>${r.isStamp ? `Stamp${r.artwork.stampNumber ? " #" + r.artwork.stampNumber : ""}` : "Counterparty"}${r.divisible ? " · divisible" : ""}</em>
      </span>
    </td>
    <td class="num">${holders}</td>
    ${showDist ? `
      <td class="num">${r.measured ? `<span class="reach"><b>${pctOf(r.reachPct)}</b>
        <span class="bar"><i style="width:${Math.max(0, Math.min(100, r.reachPct || 0)).toFixed(1)}%"></i></span></span>`
        : `<span class="unk">—</span>`}</td>
      <td class="num">${r.measured && r.holders > 1
        ? `${pctOf(r.top1Share)}<span class="hint"> ${esc(concLabel(r.hhi) || "")}</span>`
        : r.measured && r.holders === 1 ? `<span class="hint">sole holder</span>`
        : `<span class="unk">—</span>`}</td>` : ""}
    <td class="num">${eds}</td>
    <td class="num">${r.sales ? `${fmt(r.sales)} sold` : `<span class="hint">—</span>`}${
      r.dispensers ? `<span class="hint"> · ${r.dispensers} disp</span>` : ""}</td>
  </tr>`;
}

/* ---------------- collectors ---------------- */

function renderCollectors() {
  const C = window.Collectors;
  const lbAll = state.holders?.leaderboard;
  const map = artworkMap();
  const totalCollectible = map.size;

  if (!state.holders) {
    view.innerHTML = `<div class="wrap"><section class="hero"><h1>Collectors</h1></section>
      <div class="loading"><span class="spinner"></span>Reading holder balances…</div></div>`;
    return;
  }

  const summary = C.collectorSummary(lbAll, map, totalCollectible);
  let stats = lbAll.map(c => C.collectorStats(c, map, totalCollectible));

  if (state.collectorFilter === "stamps") stats = stats.filter(s => s.stamps > 0);
  if (state.collectorFilter === "xcp")    stats = stats.filter(s => s.xcp > 0);

  const q = state.query.trim().toLowerCase();
  if (q) stats = stats.filter(s => s.address.toLowerCase().includes(q));

  stats = sortCollectors(stats);
  const shown = stats.slice(0, COLLECTORS_SHOWN);

  view.innerHTML = `
  <div class="wrap">
    <section class="hero" style="padding-bottom:1.25rem">
      <h1>Collectors</h1>
      <p class="hero-sub">${fmt(summary.collectors)} addresses hold at least one piece. Rank is by how
      many <strong>distinct pieces</strong> someone holds, never by quantity — otherwise a single
      large-supply token would buy the top spot.</p>
      <div class="stat-strip">
        <div class="stat"><b>${fmt(summary.collectors)}</b><span>Collectors</span></div>
        <div class="stat"><b>${summary.deepest?.pieces ?? "—"}</b><span>Deepest holding</span></div>
        <div class="stat"><b>${summary.deepestSharePct.toFixed(0)}%</b><span>Of the collection</span></div>
        <div class="stat"><b>${fmt(summary.mixed)}</b><span>Hold both kinds</span></div>
      </div>
    </section>

    <div class="section-h"><h3>Ranks</h3><div class="rule"></div></div>
    <p class="explainer">Ranks are named after the mechanisms these works are actually built on,
    from a single data push up to stamp data that cannot be pruned from Bitcoin.</p>
    <div class="tiers">
      ${C.tierLadder().map(t => `
        <div class="tier t-${t.key}">
          <div class="tier-n">${fmt(summary.tierCounts[t.key] || 0)}</div>
          <div class="tier-name">${esc(t.name)}</div>
          <div class="tier-req">${t.min}${t.min >= 50 ? "+" : "+"} pieces</div>
          <div class="tier-blurb">${esc(t.blurb)}</div>
        </div>`).join("")}
    </div>

    <div class="toolbar" style="margin-top:2.5rem">
      <div class="chips">
        ${cchip("all", "Everyone", lbAll.length)}
        ${cchip("stamps", "Hold stamps", lbAll.filter(c => (c.assets||[]).some(a => map.get(a)?.isStamp)).length)}
        ${cchip("xcp", "Hold Counterparty", lbAll.filter(c => (c.assets||[]).some(a => map.get(a) && !map.get(a).isStamp)).length)}
      </div>
      ${collectorSortControl()}
      <label class="search">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input type="search" placeholder="Search address" value="${esc(state.query)}" aria-label="Search collectors">
      </label>
    </div>

    ${shown.length ? `<div class="collectors">${shown.map((s, i) => collectorRow(s, i)).join("")}</div>`
      : `<div class="empty">No collectors match that.</div>`}
    ${stats.length > COLLECTORS_SHOWN
      ? `<p class="foot-note" style="padding:1.5rem 0 4rem">Showing the top ${COLLECTORS_SHOWN} of ${fmt(stats.length)}.</p>`
      : `<div style="height:4rem"></div>`}
  </div>`;

  view.querySelectorAll(".chip").forEach(el =>
    el.addEventListener("click", () => { state.collectorFilter = el.dataset.f; renderCollectors(); }));
  bindSort(renderCollectors);
  const input = $(".search input", view);
  if (input) input.addEventListener("input", e => { state.query = e.target.value; renderCollectors(); });
  view.querySelectorAll(".crow").forEach(el =>
    el.addEventListener("click", e => {
      if (e.target.closest("a")) return;
      el.classList.toggle("open");
    }));
}

const cchip = (f, label, n) =>
  `<button class="chip ${state.collectorFilter === f ? "on" : ""}" data-f="${f}">${esc(label)}<span class="n">${n}</span></button>`;

const CSORTS = [["newest", "Most pieces"], ["editions", "Rarest holding"], ["oldest", "Earliest piece"], ["name", "Address"]];

function collectorSortControl() {
  return `<div class="sortbar" role="group" aria-label="Sort collectors">
    ${CSORTS.map(([k, label]) =>
      `<button class="sortbtn ${state.sort === k ? "on" : ""}" data-s="${k}">${esc(label)}</button>`).join("")}
  </div>`;
}

function sortCollectors(stats) {
  const arr = [...stats];
  switch (state.sort) {
    // Sorting on total units was noise: it was dominated by a handful of
    // billion-supply indivisible tokens, so the "most editions" leader was really
    // just whoever held the most of one common asset. Ranking by the scarcest piece
    // someone holds is a question worth asking.
    case "editions": return arr.sort((a, b) => {
      const ra = a.rarest ? effSupply(a.rarest) : Infinity;
      const rb = b.rarest ? effSupply(b.rarest) : Infinity;
      return ra - rb || b.pieces - a.pieces;
    });
    case "oldest":   return arr.sort((a, b) => (a.earliest?.firstBlock ?? 9e9) - (b.earliest?.firstBlock ?? 9e9));
    case "name":     return arr.sort((a, b) => a.address.localeCompare(b.address));
    default:         return arr.sort((a, b) => b.pieces - a.pieces || b.editions - a.editions);
  }
}

function collectorRow(s, i) {
  const pics = s.held.filter(r => thumbOf(r)).slice(0, 8);
  const extra = s.held.length - pics.length;
  return `
  <article class="crow" tabindex="0">
    <div class="crank ${i < 3 ? "top" : ""}">${i + 1}</div>

    <div class="cmain">
      <div class="cline">
        <a class="addr" href="${LINKS.addr(s.address)}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(s.address))}</a>
        <span class="tierbadge t-${s.tier.key}">${esc(s.tier.name)}</span>
      </div>
      <div class="cstats">
        <span><b>${fmt(s.pieces)}</b> pieces</span>
        <span class="dot">·</span><span><b>${s.sharePct.toFixed(1)}%</b> of the collection</span>
        ${s.stamps ? `<span class="dot">·</span><span>${fmt(s.stamps)} stamps</span>` : ""}
        ${s.xcp ? `<span class="dot">·</span><span>${fmt(s.xcp)} Counterparty</span>` : ""}
        ${s.animated ? `<span class="dot">·</span><span>${fmt(s.animated)} moving</span>` : ""}
      </div>
      <div class="cstats sub">
        ${s.rarest ? `<span>Rarest held: <a href="#/art/${encodeURIComponent(s.rarest.asset)}">${esc(nameOf(s.rarest))}</a>
          (${fmtEff(effSupply(s.rarest))} ownable${s.rarest.divisible ? ", divisible" : ""})</span>` : ""}
        ${s.earliest ? `<span class="dot">·</span><span>Collecting since ${esc(fmtDate(s.earliest.firstBlock))}</span>` : ""}
      </div>
    </div>

    <div class="cthumbs">
      ${pics.map(r => `<a href="#/art/${encodeURIComponent(r.asset)}" title="${esc(nameOf(r))}"><img src="${esc(thumbOf(r))}" alt="" loading="lazy" class="${r.pixelate ? "pixel" : ""}"></a>`).join("")}
      ${extra > 0 ? `<span class="more">+${extra}</span>` : ""}
    </div>
  </article>`;
}

function renderMarket() {
  const m = state.market;
  const map = new Map(artworks().map(a => [a.asset, a]));
  const disp = sortListings((m?.dispensers || []).filter(d => map.has(d.asset)), map);
  const openOrders = (m?.orders || []).filter(o => map.has(o.asset) || orderTouchesCollection(o, map));
  // Match on EITHER side of the trade, and on longnames. Joining on give_asset
  // alone dropped 18 of 154 events: a purchase paid for in XCP puts the artwork on
  // the get side, so those sales vanished from the history entirely.
  const history = (m?.orderHistory || []).filter(o => orderTouchesCollection(o, map));
  const filled = history.filter(o => o.status === "filled");

  view.innerHTML = `
  <div class="wrap">
    <section class="hero" style="padding-bottom:1.25rem">
      <h1>Market</h1>
      <p class="hero-sub">Two separate mechanisms operate on Counterparty, and this page keeps them
      apart because they behave very differently. Buying always happens in your own wallet — this
      site never holds funds or asks for keys.</p>
      ${btcUsd().usd ? `<div class="stat-strip">
        <div class="stat"><b>${disp.length}</b><span>Open dispensers</span></div>
        <div class="stat"><b>${openOrders.length}</b><span>Open DEX orders</span></div>
        <div class="stat"><b>${filled.length}</b><span>Filled historically</span></div>
        <div class="stat"><b>${Object.keys(m.signalsByAsset || {}).length}</b><span>With price data</span></div>
        <div class="stat"><b>$${fmt(Math.round(btcUsd().usd))}</b>
          <span>BTC ${btcUsd().live ? "· live" : "· indexed"}</span></div>
      </div>` : ""}
    </section>

    ${!m ? `<div class="loading"><span class="spinner"></span>Reading the market…</div>` : `
      <div class="section-h"><h3>Dispensers</h3><div class="rule"></div>
        ${dispenserFreshness(m)}${sortControl()}</div>
      <p class="explainer">A dispenser is a vending machine written into the chain. You send the exact
      amount of BTC to the dispenser address and it releases the piece automatically. Fixed price,
      no negotiation, no counterparty risk.</p>
      ${disp.length ? `<div class="listings">${disp.map(d => dispenserCard(d, map.get(d.asset), m)).join("")}</div>`
                    : `<div class="notice plain">No open dispensers right now.</div>`}

      <div class="section-h"><h3>Exchange orders</h3><div class="rule"></div><span class="count">${openOrders.length} open</span></div>
      <p class="explainer">The DEX is an order book: an offer to trade one asset for another at a
      chosen rate, which sits until matched or expired. Orders can be priced in any asset, not just
      BTC. Unlike dispensers these are indexed rather than live, because checking them means one
      request per asset across hundreds of assets.</p>
      ${openOrders.length
        ? `<div class="listings">${openOrders.map(o => orderCard(o, orderArtwork(o, map) ?? map.get(o.asset), false, map)).join("")}</div>`
        : `<div class="notice">No exchange orders are open at the moment.${history.length
            ? ` There are <strong>${history.length}</strong> in this wallet's history — ${
              statusBreakdown(history)}${filled.length
                ? `. The ${filled.length} that filled are listed below; the rest expired or were cancelled without trading.`
                : `, none of which filled.`}` : ""}</div>`}

      ${filled.length ? `
        <div class="section-h"><h3>Sold via the exchange</h3><div class="rule"></div><span class="count">${filled.length}</span></div>
        <p class="explainer">These trades completed, so they are prices somebody actually paid rather
        than an estimate.</p>
        <div class="listings">${filled.slice(0, 40).map(o => orderCard(o, orderArtwork(o, map), true, map)).join("")}</div>
      ` : ""}
      <div style="height:4rem"></div>
    `}
  </div>`;

  bindSort(renderMarket);
  bindListingThumbs();
}

function sortListings(rows, map) {
  const key = a => map.get(a.asset);
  const arr = [...rows];
  switch (state.sort) {
    case "oldest":   return arr.sort((a, b) => (key(a)?.firstBlock ?? 9e9) - (key(b)?.firstBlock ?? 9e9));
    case "name":     return arr.sort((a, b) => nameOf(key(a) || {}).localeCompare(nameOf(key(b) || {})));
    case "editions": return arr.sort((a, b) => Number(key(a)?.supply || 0) - Number(key(b)?.supply || 0));
    default:         return arr.sort((a, b) => (key(b)?.firstBlock ?? 0) - (key(a)?.firstBlock ?? 0));
  }
}

/** Listing rows lead with the asset name, which is the thing being bought. */
function listingThumb(r) {
  const src = r && thumbOf(r);
  if (!src) return `<div class="lthumb empty">⌗</div>`;
  return `<div class="lthumb"><img src="${esc(src)}" alt="" loading="lazy"
    class="${r.pixelate ? "pixel" : ""}"></div>`;
}

function dispenserCard(d, r, m) {
  // Quantities and prices here are already human units, normalised at ingest.
  const priceBtc = d.priceBtc != null ? Number(d.priceBtc) : Number(d.satoshirate || 0) / SATS;
  const usd = btcUsd().usd ? `$${(priceBtc * btcUsd().usd).toFixed(2)}` : null;
  return `
  <article class="listing" data-a="${esc(d.asset)}">
    ${listingThumb(r)}
    <div class="lbody">
      <div class="lname">${esc(nameOf(r || { asset: d.asset }))}</div>
      <div class="lmeta">
        <span>${qty(readDispenser(d).giveUnits, r?.divisible)} per purchase</span>
        <span class="dot">·</span><span>${qty(readDispenser(d).remainingUnits, r?.divisible)} remaining</span>
        ${r?.divisible ? `<span class="dot">·</span><span>divisible</span>` : ""}
        ${r?.isStamp ? `<span class="dot">·</span><span>Bitcoin Stamp</span>` : ""}
      </div>
    </div>
    <div class="lprice">
      <b>${btcAmt(priceBtc)} BTC</b>
      ${usd ? `<small>${esc(usd)}</small>` : ""}
    </div>
    <a class="btn" href="${LINKS.xcpio(r?.assetLongname || d.asset)}" target="_blank" rel="noopener noreferrer">Buy →</a>
  </article>`;
}

function orderCard(o, r, isHistory = false, map = null) {
  const od = readOrder(o);
  const lookup = map || new Map(artworks().map(a => [a.asset, a]));

  // Which side of the trade is the artwork? A purchase paid for in XCP puts the
  // piece on the GET side, and those were being dropped entirely (see the join).
  const artIsGive = !!(r && (od.giveAsset === r.asset || od.giveAssetLongname === r.assetLongname));
  const artUnits  = artIsGive ? od.giveShown : od.getShown;
  const payAsset  = artIsGive ? od.getAsset  : od.giveAsset;
  const payName   = (artIsGive ? od.getAssetLongname : od.giveAssetLongname) || payAsset || "";
  const payUnits  = artIsGive ? od.getShown : od.giveShown;
  const payDiv    = assetDivisible(payAsset, lookup);

  // Only a filled order is a sale. An expired or cancelled one was an offer nobody
  // took, and the status chip beside this says so.
  const artLabel  = od.isFilled ? (artIsGive ? "sold" : "bought")
                                : (artIsGive ? "offered" : "wanted");
  const payLabel  = od.isFilled ? "traded for"
                  : od.isOpen   ? (artIsGive ? "asking" : "offering")
                                : (artIsGive ? "was asking" : "was offering");

  return `
  <article class="listing ${isHistory ? "past" : ""}" data-a="${esc(r?.asset ?? od.giveAsset ?? "")}">
    ${listingThumb(r)}
    <div class="lbody">
      <div class="lname">${esc(nameOf(r || { asset: od.giveAsset }))}</div>
      <div class="lmeta">
        <span>${qty(artUnits, r?.divisible)} ${esc(artLabel)}</span>
        ${od.status && od.status !== "open" ? `<span class="dot">·</span><span class="st-${esc(statusKey(od.status))}">${esc(shortStatus(od.status))}</span>` : ""}
        ${od.blockIndex ? `<span class="dot">·</span><span>${esc(fmtDate(od.blockIndex))}</span>` : ""}
      </div>
    </div>
    <div class="lprice"><b>${qty(payUnits, payDiv)} ${esc(payName)}</b><small>${esc(payLabel)}</small></div>
    ${od.isOpen ? `<a class="btn" href="${LINKS.horizon(r?.assetLongname || od.giveAsset)}" target="_blank" rel="noopener noreferrer">Trade →</a>` : ""}
  </article>`;
}

/**
 * Status counts derived from the data rather than a fixed list.
 *
 * A hardcoded [filled, expired, cancelled] silently omitted the 2 events carrying
 * "invalid: non-positive give quantity; zero give or zero get", so the numbers on
 * screen did not sum to the total stated beside them.
 */
function statusBreakdown(orders) {
  const counts = new Map();
  for (const o of orders) {
    const k = shortStatus(o.status ?? "unknown");
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${esc(k)}`)
    .join(", ");
}

/** CSS-safe status key, and a short label for the long "invalid: ..." status. */
const statusKey = s => String(s || "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const shortStatus = s => (String(s || "").startsWith("invalid") ? "invalid" : String(s || ""));

function bindListingThumbs() {
  view.querySelectorAll(".listing[data-a]").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.closest("a")) return;
      location.hash = `#/art/${encodeURIComponent(el.dataset.a)}`;
    });
  });
}

/* ---------------- mega dispenser ---------------- */

/**
 * Dispenser state, live where possible.
 *
 * The live endpoint is authoritative because stock changes with every purchase.
 * The indexed snapshot is only a fallback for the static preview build, and the
 * page states which one it is rather than presenting stale data as current.
 */
function megaDispensers() {
  const map = new Map(artworks().map(a => [a.asset, a]));
  const live = state.mega?.dispensers;
  const rows = live && live.length
    ? live
    : (state.market?.dispensers || []).filter(d => d.source === MEGA_ADDRESS);

  return rows
    .map(d => ({
      ...d,
      // Live rows carry their own divisibility; snapshot rows borrow it from the index.
      divisible: d.divisible ?? map.get(d.asset)?.divisible ?? false,
      art: map.get(d.asset) || null,
    }))
    .sort((a, b) => a.priceSats - b.priceSats);
}

const megaIsLive = () => !!(state.mega?.dispensers?.length);

/**
 * Dispenser freshness, reading keys that actually exist.
 *
 * Two things can make dispenser rows current: a successful in-page live fetch,
 * which sets dispensersLive at runtime, or the indexer's own scan, which now stamps
 * dispensersSource and dispensersFetchedAt into market.json. The previous version
 * checked only the runtime keys — absent from the file — so the badge was stuck on
 * "Indexed" permanently, even immediately after a live fetch.
 */
function dispenserFreshness(m) {
  if (!m) return freshness(false, null);
  const at = m.dispensersFetchedAt ?? m.generatedAt ?? null;
  // The indexer records which upstream it scanned; surfacing it means the badge
  // states provenance as well as age, and stops dispensersSource being written
  // to market.json and read by nothing.
  return freshness(!!m.dispensersLive, at, m.dispensersLive ? null : m.dispensersSource);
}

/** A small, consistent badge so every figure declares its own freshness. */
function freshness(isLive, at, source = null) {
  const when = at ? new Date(at) : null;
  const stamp = when ? when.toISOString().slice(11, 16) + " UTC" : null;
  const via = source ? ` · ${esc(String(source))}` : "";
  return isLive
    ? `<span class="fresh live" title="Fetched from the chain just now">Live${stamp ? ` · ${esc(stamp)}` : ""}</span>`
    : `<span class="fresh stale" title="From the last index build, not live">Indexed${stamp ? ` · ${esc(stamp)}` : ""}${via}</span>`;
}

function renderMega() {
  const M = window.MegaDispenser;
  const disp = megaDispensers();

  if (!state.market && !state.mega) {
    view.innerHTML = `<div class="wrap"><section class="hero"><h1>The mega dispenser</h1></section>
      <div class="loading"><span class="spinner"></span>Reading live dispenser state…</div></div>`;
    return;
  }
  if (!disp.length) {
    view.innerHTML = `<div class="wrap"><section class="hero"><h1>The mega dispenser</h1></section>
      <div class="empty">No open dispensers on this address right now.</div></div>`;
    return;
  }

  const sim = M.simulateMega(disp, state.megaSats);
  const tiers = M.megaTiers(disp);
  const btcPrice = btcUsd().usd;
  const usd = btcPrice ? `$${(sim.paymentBtc * btcPrice).toFixed(2)}` : null;

  const presets = tiers.map(t => t.sats);

  view.innerHTML = `
  <div class="wrap">
    <section class="hero" style="padding-bottom:1.5rem">
      <h1>One payment.<br><span class="thin">Many pieces.</span></h1>
      <p class="hero-sub">${disp.length} dispensers share a single Bitcoin address. A payment triggers
      <strong>every one of them it can afford</strong> — and takes as many lots from each as it covers.
      Move the amount to see exactly what would arrive.</p>
      <div class="freshrow">
        ${freshness(megaIsLive(), state.mega?.fetchedAt ?? state.market?.generatedAt)}
        <button class="tool" id="mega-refresh" ${state.megaLoading ? "disabled" : ""}>
          ${state.megaLoading ? "Refreshing…" : "Refresh"}
        </button>
        ${!megaIsLive() ? `<span class="freshnote">Live endpoint unreachable — showing the last indexed snapshot.</span>` : ""}
      </div>
    </section>

    <div class="megacalc">
      <div class="megainput">
        <label class="megalabel" for="mega-btc">You send</label>
        <div class="megafield">
          <input id="mega-btc" type="text" inputmode="decimal" value="${(state.megaSats / 1e8).toFixed(8)}" aria-label="BTC amount">
          <span class="megaunit">BTC</span>
        </div>
        ${usd ? `<div class="megausd">${esc(usd)}</div>` : ""}
        <input id="mega-range" type="range" min="0" max="${presets.length - 1}" step="1"
          value="${Math.max(0, presets.findIndex(p => p >= state.megaSats))}" aria-label="Amount tier">
        <div class="megapresets">
          ${presets.map(p => `<button class="megapreset ${p === state.megaSats ? "on" : ""}" data-s="${p}">${(p / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}</button>`).join("")}
        </div>
      </div>

      <div class="megaresult">
        <div class="megabig"><b>${sim.assets}</b><span>of ${disp.length} dispensers trigger</span></div>
        ${sim.anyCapped ? `<div class="megaflag">Some dispensers have less stock than this payment asks for. You receive what remains.</div>` : ""}
      </div>
    </div>

    <div class="notice" style="margin-bottom:2rem">
      <strong>Before you send anything.</strong> Counterparty does not refund overpayment. If a
      dispenser has less stock than your payment asks for, you receive only what is left and the
      remainder of that portion is not returned. Stock and prices change as people buy, so treat this
      as a projection${megaIsLive() ? " from state fetched moments ago" : ` from the indexed snapshot of ${esc(new Date(state.market.generatedAt).toISOString().slice(0, 16).replace("T", " "))} UTC`},
      not a promise. The chain decides what actually happens.
    </div>

    <div class="section-h"><h3>What arrives</h3><div class="rule"></div><span class="count">${sim.assets} assets</span></div>
    ${sim.hits.length ? `<div class="megahaul">${sim.hits.map(h => megaCard(h, M)).join("")}</div>`
      : `<div class="notice plain">This amount is below every dispenser's price. The cheapest is
         ${(disp[0].priceSats / 1e8).toFixed(8)} BTC.</div>`}

    ${sim.results.filter(r => !r.triggered).length ? `
      <div class="section-h"><h3>Not reached at this amount</h3><div class="rule"></div></div>
      <div class="megamissed">
        ${sim.results.filter(r => !r.triggered).map(r => `
          <button class="missed" data-s="${r.priceSats}">
            <span class="mname">${esc(nameOf(r.art || { asset: r.asset }))}</span>
            <span class="mprice">${(r.priceSats / 1e8).toFixed(8)} BTC${r.empty ? " · out of stock" : ""}</span>
          </button>`).join("")}
      </div>` : ""}

    <div class="section-h"><h3>Every threshold</h3><div class="rule"></div></div>
    <p class="explainer">Each price point is a dispenser. Paying at least that much triggers it, and
    paying a multiple of it takes multiple lots — stock permitting.</p>
    <div class="table-scroll" style="padding-bottom:1.5rem">
      <table class="table">
        <thead><tr><th>Send at least</th><th class="num">Dispensers triggered</th><th>Unlocks</th></tr></thead>
        <tbody>${tiers.map(t => `
          <tr class="tierrow ${t.sats === state.megaSats ? "on" : ""}" data-s="${t.sats}">
            <td><b>${(t.sats / 1e8).toFixed(8)}</b> BTC</td>
            <td class="num">${t.assets}</td>
            <td>${t.unlocks.map(u => esc(nameOf(u.art || { asset: u.asset }))).join(", ")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>

    <div class="section-h"><h3>The address</h3><div class="rule"></div></div>
    <p class="explainer">Payment goes to this address from your own wallet. This site never handles
    funds, never asks for a key, and cannot send anything on your behalf.</p>
    <div class="megaaddr">
      <code id="mega-addr">${esc(MEGA_ADDRESS)}</code>
      <button class="btn ghost" id="mega-copy">Copy</button>
      <a class="btn ghost" href="${LINKS.addr(MEGA_ADDRESS)}" target="_blank" rel="noopener noreferrer">View on xcp.io</a>
    </div>
    <div style="height:4rem"></div>
  </div>`;

  const apply = sats => { state.megaSats = Math.max(0, Math.round(sats)); renderMega(); };

  const input = $("#mega-btc", view);
  input.addEventListener("change", () => apply((parseFloat(input.value) || 0) * 1e8));
  input.addEventListener("keydown", e => { if (e.key === "Enter") apply((parseFloat(input.value) || 0) * 1e8); });

  const range = $("#mega-range", view);
  range.addEventListener("input", () => apply(presets[Number(range.value)]));

  view.querySelectorAll(".megapreset, .missed, .tierrow").forEach(el =>
    el.addEventListener("click", () => apply(Number(el.dataset.s))));

  const refresh = $("#mega-refresh", view);
  if (refresh) refresh.addEventListener("click", () => loadMega({ force: true }));

  const copy = $("#mega-copy", view);
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(MEGA_ADDRESS); copy.textContent = "Copied"; setTimeout(() => copy.textContent = "Copy", 1600); }
    catch { copy.textContent = "Select it manually"; }
  });

  window.scrollTo(0, 0);
}

function megaCard(h, M) {
  const r = h.art;
  const q = M.megaQty(h.received, h.divisible);
  const src = r && thumbOf(r);
  return `
  <article class="megaitem" ${r ? `data-a="${esc(h.asset)}"` : ""}>
    <div class="lthumb">${src
      ? `<img src="${esc(src)}" alt="" loading="lazy" class="${r.pixelate ? "pixel" : ""}">`
      : `<span style="color:var(--muted-2)">⌗</span>`}</div>
    <div class="megabody">
      <div class="lname">${esc(nameOf(r || { asset: h.asset }))}</div>
      <div class="megaqty">
        <b>${esc(q.text)}</b>${q.suffix ? ` <span class="atomic">${esc(q.suffix)}</span>` : ""}
        <span class="lots">${h.lots} lot${h.lots > 1 ? "s" : ""} @ ${(h.priceSats / 1e8).toFixed(8)}</span>
      </div>
      ${h.stockCapped ? `<div class="capped">Stock limited — this payment covers ${fmt(h.lotsWanted)} lots, ${fmt(h.lotsAvailable)} remain</div>` : ""}
    </div>
  </article>`;
}

/* ---------------- about ---------------- */

function renderAbout() {
  const c = state.data.counts || {};
  const addrs = state.data.addresses || [];
  view.innerHTML = `
  <div class="wrap"><div class="about">
    <h1>About this collection</h1>
    <p>Every piece here lives on Bitcoin. Some are <strong>Counterparty assets</strong>, where the
    artwork is referenced by an on-chain asset whose description points at the image. Others are
    <strong>Bitcoin Stamps</strong>, where the image data itself is embedded in the transaction and
    cannot be detached from the chain.</p>

    <p>This site reads directly from the Counterparty and Bitcoin Stamps indexers. It hosts no
    artwork of its own — if this page disappeared tomorrow, every piece would still be exactly
    where it is.</p>

    <h4>Wallets indexed</h4>
    <ul>${addrs.map(a => `<li><code>${esc(a)}</code></li>`).join("")}</ul>

    <h4>What's in here</h4>
    <ul>
      <li>${c.artworks ?? 0} works, of which ${c.withMedia ?? 0} have artwork resolved</li>
      <li>${c.stamps ?? 0} Bitcoin Stamps and ${c.counterparty ?? 0} Counterparty assets</li>
      <li>${c.tokenOpsExcluded ?? 0} SRC-20 token operations filtered out — these are issued from the
      same wallet but are token transactions, not artwork</li>
    </ul>

    <h4>On scaling</h4>
    <p>Pixel art is scaled with nearest-neighbour so it stays crisp, while high-resolution work is
    scaled smoothly. That choice is made per piece from the artwork's real measured dimensions rather
    than from its type, so a small stamp stays sharp and a large painting never gets crunched.</p>

    <h4>Buying</h4>
    <p>Where a piece has an open dispenser or exchange order, the market pages link out to a
    marketplace where the purchase happens in your own wallet. This site never asks for keys and
    never holds funds.</p>
  </div></div>`;
}

boot();
