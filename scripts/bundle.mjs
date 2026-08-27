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
