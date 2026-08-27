/**
 * Write a copy of collected.js with the project's signature defect reintroduced, so
 * the Collected suite can be required to fail on it.
 *
 * The defect restored here is the absent-versus-zero conflation: readHolding()
 * reporting 0 holders for a piece whose holder fetch FAILED. That is the same
 * mistake as D1 (a real zero read as absent) and D3/D9 (an absent key read as a
 * value), and it is the single thing the Collected view exists to get right — 53 of
 * 489 pieces have no holder data, and showing them as "0 holders" would state as
 * fact something never measured.
 *
 * Usage:  node test/break-collected-for-proof.cjs <output-path>
 */
const fs = require("node:fs");
const path = require("node:path");

const out = process.argv[2];
if (!out) {
  console.error("usage: node test/break-collected-for-proof.cjs <output-path>");
  process.exit(2);
}

const src = fs.readFileSync(path.join(__dirname, "..", "public", "collected.js"), "utf8");

const FIXED = "holders: dataOk ? holders : null,";
const BROKEN = "holders: holders ?? 0,";

if (!src.includes(FIXED)) {
  console.error(
    "Could not find readHolding's holder-count branch to break.\n" +
    "readHolding has changed shape, so the Collected suite is no longer being proven.\n" +
    `Expected to find: ${FIXED}\n` +
    "Update FIXED/BROKEN in test/break-collected-for-proof.cjs to match the current code."
  );
  process.exit(1);
}

fs.writeFileSync(out, src.replace(FIXED, BROKEN));
console.log(`Wrote ${out} with the absent-as-zero defect reintroduced (${FIXED} -> ${BROKEN}).`);
