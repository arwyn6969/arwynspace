/**
 * Live mega dispenser state.
 *
 * This one has to be live. Dispenser prices and remaining stock change every time
 * somebody buys, and the whole point of the simulator is telling a visitor what a
 * payment would actually get them right now. A snapshot baked at build time would
 * promise tokens that had already been bought.
 *
 * It is cheap enough to be live: a handful of calls for a single address, not the
 * hundreds the full artwork index needs. Cached for 30 seconds at the edge so a
 * burst of traffic doesn't hammer the upstream, with stale-while-revalidate so
 * nobody waits on a refetch.
 */

const TOKENSCAN = "https://tokenscan.io/api";
const STAMPCHAIN = "https://stampchain.io/api/v2";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function jget(url, { timeout = 9000, headers = {} } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
    if (!r.ok) return null;
    const text = await r.text();
    if (/^\s*</.test(text)) return null;     // Cloudflare challenge, not JSON
    return JSON.parse(text);
  } catch { return null; } finally { clearTimeout(t); }
}

/** Stampchain's health payload sometimes omits btcPrice; fall back to a spot feed. */
async function btcSpot(fromHealth) {
  if (fromHealth) return fromHealth;
  const c = await jget("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  return Number(c?.data?.amount) || null;
}

const num = v => (v == null ? 0 : Number(String(v)) || 0);

export default async function handler(req, res) {
  const address = (req.query?.address || process.env.MEGA_ADDRESS || "1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j").trim();

  // tokenscan reports quantities already in human units, unlike stampchain and
  // Counterparty which use raw integers. Everything here is normalised to human
  // units on the way out so the client never has to know which source it came from.
  const d = await jget(`${TOKENSCAN}/dispensers/${encodeURIComponent(address)}`);

  const dispensers = [];
  for (const row of d?.data ?? []) {
    if (row.close_block_index != null) continue;          // closed
    const remaining = num(row.give_remaining);
    if (remaining <= 0) continue;                          // empty
    const give = num(row.give_quantity);
    if (give <= 0) continue;

    dispensers.push({
      asset: row.asset,
      assetLongname: row.asset_longname || null,
      source: row.source || address,
      priceBtc: num(row.satoshi_price),
      priceSats: Math.round(num(row.satoshi_price) * 1e8),
      giveUnits: give,
      remainingUnits: remaining,
      escrowUnits: num(row.escrow_quantity),
      txHash: row.tx_hash,
    });
  }
  dispensers.sort((a, b) => a.priceSats - b.priceSats);

  // Divisibility decides how a quantity should be read, and it isn't on the
  // dispenser row, so it's fetched per distinct asset. Small and parallel.
  const assets = [...new Set(dispensers.map(x => x.asset))];
  const info = await Promise.all(assets.map(a => jget(`${TOKENSCAN}/asset/${encodeURIComponent(a)}`)));
  const divisibleBy = new Map(assets.map((a, i) => [a, !!info[i]?.divisible]));
  for (const x of dispensers) x.divisible = divisibleBy.get(x.asset) ?? false;

  const health = await jget(`${STAMPCHAIN}/health`);
  const btcPrice = await btcSpot(Number(health?.metadata?.btcPrice) || null);

  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
  res.status(200).json({
    live: true,
    fetchedAt: new Date().toISOString(),
    address,
    btcPrice,
    units: "human",
    dispensers,
    // Surfaced so the page can say plainly whether it's showing live chain state
    // or falling back to the last build's snapshot.
    ok: dispensers.length > 0 || d != null,
  });
}
