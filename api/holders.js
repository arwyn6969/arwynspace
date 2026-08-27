/**
 * Collector leaderboard, computed from Counterparty balances.
 *
 * Aggregating holders across the whole collection is too slow for one request,
 * so this reads the pre-built snapshot and only refreshes it on demand. The
 * snapshot is produced by scripts/index-market.mjs.
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
