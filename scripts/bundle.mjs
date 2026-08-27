/**
 * Produces a single self-contained HTML file with CSS, JS and data inlined.
 * Useful for preview, archiving, or hosting anywhere that serves one file.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const P = f => path.join(ROOT, "public", f);
const D = f => path.join(ROOT, "data", f);

const html = fs.readFileSync(P("index.html"), "utf8");
const css  = fs.readFileSync(P("app.css"), "utf8");
const js   = fs.readFileSync(P("app.js"), "utf8");
const colJs = fs.readFileSync(P("collectors.js"), "utf8");
const megaJs = fs.readFileSync(P("megadispenser.js"), "utf8");
const cfg  = JSON.parse(fs.readFileSync(path.join(ROOT, "config/wallets.json"), "utf8"));

const art = JSON.parse(fs.readFileSync(D("artworks.json"), "utf8"));
art.artistName = cfg.artistName ?? null;
art.tagline = cfg.tagline ?? null;

const readOpt = f => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return null; } };
const market = readOpt("market.json");
const holders = readOpt("holders.json");

/**
 * The test suite reads public/data; this bundler reads data/. If those drift, the
 * checks can pass against one snapshot while a different, unvalidated one ships.
 * Refuse to build rather than let that happen — run `npm run build` to resync.
 */
{
  const drift = [];
  const pub = f => { try { return JSON.parse(fs.readFileSync(P(`data/${f}`), "utf8")); } catch { return null; } };
  for (const [name, src] of [["artworks.json", art], ["market.json", market], ["holders.json", holders]]) {
    if (!src) continue;
    const p = pub(name);
    if (!p) { drift.push(`${name}: missing from public/data`); continue; }
    if (p.generatedAt !== src.generatedAt) drift.push(`${name}: data/=${src.generatedAt} public/=${p.generatedAt}`);
  }
  if (drift.length) {
    console.error("Refusing to bundle — validated snapshots are out of sync with the ones being inlined:");
    for (const d of drift) console.error(`  ${d}`);
    console.error("Run `npm run build` first so the tests and the bundle see the same data.");
    process.exit(1);
  }
}

// </script> inside JSON would close the tag early.
const safe = o => JSON.stringify(o).replace(/<\//g, "<\\/");

let out = html
  .replace(/<link rel="stylesheet" href="\.\/app\.css">/, `<style>\n${css}\n</style>`)
  .replace(/<script src="\.\/collectors\.js"><\/script>\s*/, "")
  .replace(/<script src="\.\/megadispenser\.js"><\/script>\s*/, "")
  .replace(/<script src="\.\/app\.js"><\/script>/,
    `<script>window.__ARTWORKS__=${safe(art)};` +
    (market ? `window.__MARKET__=${safe(market)};` : "") +
    (holders ? `window.__HOLDERS__=${safe(holders)};` : "") +
    `</script>\n<script>\n${colJs}\n</script>\n<script>\n${megaJs}\n</script>\n<script>\n${js}\n</script>`);

const dest = path.join(ROOT, "dist");
fs.mkdirSync(dest, { recursive: true });
const file = path.join(dest, "gallery.html");
fs.writeFileSync(file, out);
console.log(`${file}  ${(out.length / 1024).toFixed(0)} KB`);
console.log(`  artworks:${art.artworks.length} market:${market ? "yes" : "no"} holders:${holders ? "yes" : "no"}`);
