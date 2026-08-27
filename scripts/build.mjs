/**
 * Build: copies the resolved data snapshots into public/data so the static
 * site can read them, and injects config-driven text.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const outDir = path.join(ROOT, "public/data");
fs.mkdirSync(outDir, { recursive: true });

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/wallets.json"), "utf8"));

// artworks.json is required; the market/holders snapshots are optional.
const art = JSON.parse(fs.readFileSync(path.join(ROOT, "data/artworks.json"), "utf8"));
art.artistName = cfg.artistName ?? null;
art.tagline = cfg.tagline ?? null;
fs.writeFileSync(path.join(outDir, "artworks.json"), JSON.stringify(art));
console.log(`artworks.json  ${art.artworks.length} works`);

for (const name of ["market.json", "holders.json"]) {
  const src = path.join(ROOT, "data", name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(outDir, name));
    console.log(`${name}  copied`);
  } else {
    console.log(`${name}  (absent — site will degrade gracefully)`);
  }
}
