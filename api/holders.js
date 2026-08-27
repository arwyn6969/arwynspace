/**
 * Collector leaderboard, computed from Counterparty balances.
 *
 * Aggregating holders across the whole collection is too slow for one request,
 * so this reads the pre-built snapshot and only refreshes it on demand. The
 * snapshot is produced by scripts/index-market.mjs.
 *
 * DELIBERATELY A PASS-THROUGH. The snapshot already carries per-asset distribution
 * figures (reach, holder counts, concentration) in human units, and this route must
 * not recompute or rescale any of them. api/market.js was one deploy away from
 * rendering every divisible dispenser 100,000,000x too large precisely because it
 * rebuilt its payload instead of serving the indexer's canonical shape — a second
 * implementation of the same arithmetic is a second chance to get the units wrong.
 * test/schema.test.mjs asserts this file stays a pass-through.
 *
 * The empty fallback below yields no byAsset entries, which the client reads as
 * "not measured" for every piece rather than as zero holders. That distinction is
 * the whole point of the Collected view.
 */
import fs from "node:fs";
import path from "node:path";

export default function handler(req, res) {
  try {
    const p = path.join(process.cwd(), "data/holders.json");
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
    res.status(200).json(json);
  } catch {
    res.status(200).json({ byAsset: {}, leaderboard: [], note: "holder snapshot not built yet" });
  }
}
