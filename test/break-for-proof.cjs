/**
 * Write a copy of the client with a real historical defect reintroduced, so the probe
 * can be required to fail on it.
 *
 * The defect restored here is D9: `listingsFor` filtering open orders on `give_asset`,
 * a key that exists only on order HISTORY. It matched zero open orders, so no artwork
 * page ever displayed a DEX listing and the for-sale filter silently ignored them.
 *
 * This exists because the first version of the probe reported a clean bill of health
 * against exactly this bug — it passed proxies in as arguments while `listingsFor`
 * reads `state.market.orders` directly and never saw one. A checker that cannot fail
 * on a known defect does not provide confidence, it manufactures it. CI therefore
 * proves the probe still bites on every run.
 *
 * If the marker below no longer matches, `listingsFor` has been rewritten. Do not
 * delete this step — update the marker so the proof keeps working.
 *
 * Usage:  node test/break-for-proof.cjs <output-path>
 */
const fs = require("node:fs");
const path = require("node:path");

const out = process.argv[2];
if (!out) {
  console.error("usage: node test/break-for-proof.cjs <output-path>");
  process.exit(2);
}

const clientPath = path.join(__dirname, "..", "public", "app.js");
const src = fs.readFileSync(clientPath, "utf8");

const FIXED = "filter(o => orderInvolves(o, asset, longname))";
const BROKEN = "filter(o => o.give_asset === asset)";

if (!src.includes(FIXED)) {
  console.error(
    "Could not find the listingsFor order filter to break.\n" +
    "listingsFor has changed shape, so the probe is no longer being proven.\n" +
    `Expected to find: ${FIXED}\n` +
    "Update FIXED/BROKEN in test/break-for-proof.cjs to match the current code."
  );
  process.exit(1);
}

fs.writeFileSync(out, src.replace(FIXED, BROKEN));
console.log(`Wrote ${out} with D9 reintroduced (${FIXED} -> ${BROKEN}).`);
