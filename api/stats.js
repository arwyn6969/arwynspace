/**
 * Live collection headline figures.
 *
 * Counts baked into a build go stale the moment an asset is issued or moved, and
 * this is a living collection. These numbers are cheap to fetch live — one call
 * per wallet — so there is no reason for them to be frozen.
 *
 * What is NOT here, deliberately: the per-artwork index and the collector
 * leaderboard. Resolving 500+ assets costs several thousand calls across hosts
 * that are slow, rate limited and occasionally down; the leaderboard alone is
 * 400+ calls. Those stay on a scheduled refresh. Pretending otherwise would mean
 * a page that takes twenty minutes to load or, worse, one that silently shows
 * half the data when an upstream throttles.
 */

const TOKENSCAN = "https://tokenscan.io/api";
const STAMPCHAIN = "https://stampchain.io/api/v2";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function jget(url, timeout = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) return null;
    const text = await r.text();
    if (/^\s*</.test(text)) return null;
    return JSON.parse(text);
  } catch { return null; } finally { clearTimeout(t); }
}

/** Stampchain's health payload sometimes omits btcPrice; fall back to a spot feed. */
async function btcSpot(fromHealth) {
  if (fromHealth) return fromHealth;
  const c = await jget("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  return Number(c?.data?.amount) || null;
}

export default async function handler(req, res) {
  const wallets = (process.env.WALLETS ||
    "1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j,16ty9iygA4N1uw8Tu7ssGV5SeHscAAXjXP,17bP2D968mUtYWJHgLKaCC7cPFJ9L5jm9f,1BepCXzZ7RRcPaqUdvBp2jvkJcaRvHMGKz,1GLtNBpGqpNLGfH5iQHLipVqiVu6LeqSin,1GZsmqM5PFBytkC81JxcSWDU5QzNwaCs2M,1MNVKFunSKArs3ya776VoALR6Lv1eu6yUt")
    .split(",").map(s => s.trim()).filter(Boolean);

  const [infos, dispSets, health] = await Promise.all([
    Promise.all(wallets.map(w => jget(`${TOKENSCAN}/address/${w}`))),
    Promise.all(wallets.map(w => jget(`${TOKENSCAN}/dispensers/${w}`))),
    jget(`${STAMPCHAIN}/health`),
  ]);

  let owned = 0, held = 0;
  const perWallet = wallets.map((w, i) => {
    const a = infos[i]?.assets;
    if (a) { owned += Number(a.owned) || 0; held += Number(a.held) || 0; }
    return { address: w, owned: Number(a?.owned) || 0, held: Number(a?.held) || 0, reachable: !!infos[i] };
  });

  // Open dispensers across every wallet, which is the figure that moves most.
  let openDispensers = 0;
  const dispenserAssets = new Set();
  for (const d of dispSets) {
    for (const row of d?.data ?? []) {
      if (row.close_block_index != null) continue;
      if ((Number(String(row.give_remaining)) || 0) <= 0) continue;
      openDispensers++;
      dispenserAssets.add(row.asset);
    }
  }

  const reachable = perWallet.filter(w => w.reachable).length;

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
  res.status(200).json({
    live: true,
    fetchedAt: new Date().toISOString(),
    wallets: wallets.length,
    walletsReachable: reachable,
    // Partial data is flagged rather than quietly presented as complete.
    complete: reachable === wallets.length,
    assetsOwned: owned,
    assetsHeld: held,
    openDispensers,
    assetsWithDispensers: dispenserAssets.size,
    btcPrice: await btcSpot(Number(health?.metadata?.btcPrice) || null),
    chainHeight: health?.services?.blockSync?.indexed ?? null,
    perWallet,
  });
}
