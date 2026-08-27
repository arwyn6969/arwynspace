/**
 * Unit conversion.
 *
 * lib/units.mjs exists because three upstreams disagree about what a quantity means
 * and mixing them produced confidently wrong numbers rather than errors:
 *
 *   tokenscan.io     HUMAN units    supply "69000000.00000000" = 69 million
 *   stampchain.io    RAW integers   the same dispenser as give_quantity 100
 *   Counterparty v2  RAW integers   supply 6900000000000000
 *
 * It is the most dangerous code in the project and had no tests. A wrong answer here
 * is off by a factor of one hundred million and still looks like a plausible number.
 *
 * Usage:  node test/units.test.mjs
 */
import * as U from "../lib/units.mjs";
import { loadWithData, check, eq, ok, summary } from "./harness.mjs";

const { api, data } = loadWithData();

console.log("Unit conversion\n");

/* ------------------------------------------------------------- conversions */

check("divisible: raw is human x 1e8, both directions", () => {
  eq(U.fromAtomic(6900000000000000, true), 69000000, "fromAtomic divisible");
  eq(U.toAtomic(69000000, true), 6900000000000000, "toAtomic divisible");
  return eq(U.fromAtomic(U.toAtomic(4.2, true), true), 4.2, "round trip");
});

check("indivisible: raw and human are the same number", () => {
  eq(U.fromAtomic(100, false), 100, "fromAtomic indivisible");
  eq(U.toAtomic(100, false), 100, "toAtomic indivisible");
  return eq(U.atomicFactor(false), 1);
});

check("toAtomic rounds rather than trusting float maths", () => {
  // The comment in units.mjs cites 20999999.999999996; assert the class of error.
  eq(U.toAtomic(0.20999999999999996, true), 21000000, "float residue rounded away");
  eq(U.toAtomic(4.2, true), 420000000, "4.2 exactly");
  return ok(Number.isInteger(U.toAtomic(0.099966, true)), "atomic values must be integers");
});

check("the 8-decimal floor survives conversion", () => {
  eq(U.toAtomic(1e-8, true), 1, "one smallest unit");
  return eq(U.fromAtomic(1, true), 1e-8, "back again");
});

/* --------------------------------------------------- source-tagged ingest */

check("the same dispenser reads identically from a human and a raw source", () => {
  // tokenscan reports human 0.00000100; stampchain reports raw 100. Same thing.
  const fromHuman = U.normalizeQuantity("0.00000100", true, "tokenscan");
  const fromRaw = U.normalizeQuantity(100, true, "stampchain");
  eq(fromHuman.atomic, fromRaw.atomic, "atomic agreement");
  return eq(fromHuman.units, fromRaw.units, "human agreement");
});

check("an undeclared source is rejected, not guessed", () => {
  let threw = false;
  try { U.normalizeQuantity(100, true, "xchain.example"); } catch { threw = true; }
  return ok(threw, "unknown source must throw so a new upstream cannot be silently assumed");
});

check("counterparty and stampchain are both treated as raw", () => {
  eq(U.normalizeQuantity(6900000000000000, true, "counterparty").units, 69000000);
  return eq(U.normalizeQuantity(6900000000000000, true, "stampchain").units, 69000000);
});

/* ------------------------------------------------------- effective supply */

check("effective supply is the chain's own integer", () => {
  eq(U.effectiveSupply(69000000, true), 6900000000000000, "divisible");
  return eq(U.effectiveSupply(1, false), 1, "a 1-of-1 is one ownable thing");
});

check("a divisible supply of 1 is common, not rare", () => {
  // Documented consequence: 1e8 separately ownable pieces exist.
  return eq(U.effectiveSupply(1, true), 100000000);
});

check("client effSupply agrees with lib/units effectiveSupply", () => {
  const bad = [];
  for (const r of data.artworks.artworks.slice(0, 400)) {
    const units = Number(r.supplyUnits ?? r.supply ?? 0) || 0;
    if (!units) continue;
    const lib = U.effectiveSupply(units, !!r.divisible);
    const client = api.effSupply(r);
    if (lib !== client) bad.push(`${r.asset}: lib=${lib} client=${client}`);
  }
  return eq(bad.slice(0, 5), [], `${bad.length} assets where the two definitions disagree`);
});

/* ------------------------------------------------------------------ rarity */

check("zero supply means different things locked and unlocked", () => {
  const burned = U.rarityOf({ supply: 0, locked: true, divisible: false });
  const unminted = U.rarityOf({ supply: 0, locked: false, divisible: false });
  eq(burned.rank, "burned"); ok(burned.rankable, "locked zero is a real final state");
  eq(unminted.rank, "unminted");
  return ok(!unminted.rankable, "never-minted has no claim to rarity");
});

check("never-minted assets sort last regardless of direction", () => {
  const minted = { supply: 5, locked: true, divisible: false };
  const never = { supply: 0, locked: false, divisible: false };
  ok(U.byRarity(minted, never) < 0, "minted before unminted");
  return ok(U.byRarity(never, minted) > 0, "and still last when reversed");
});

check("rarest-first ordering is by effective supply", () => {
  const rows = [
    { asset: "COMMON", supply: 1, divisible: true, locked: true },   // 1e8 units
    { asset: "RARE", supply: 5, divisible: false, locked: true },    // 5 units
    { asset: "NEVER", supply: 0, divisible: false, locked: false },
  ];
  return eq([...rows].sort(U.byRarity).map((r) => r.asset), ["RARE", "COMMON", "NEVER"]);
});

/* -------------------------------------------------------------- formatting */

check("neither formatter truncates a small value to zero", () => {
  const bad = [];
  for (const v of [0.000042, 0.0001111, 1e-8]) {
    const s = U.fmtUnits(v, true);
    if (Number(String(s).replace(/,/g, "")) === 0) bad.push(`fmtUnits(${v}) => "${s}"`);
  }
  return eq(bad, [], "fmtUnits truncating");
});

check("large effective supplies stay legible, with no stray trailing zero", () => {
  eq(U.fmtEffective(6900000000000000), "6.9Q", "69M divisible");
  eq(U.fmtEffective(7000000000000000), "7Q", "exact magnitudes lose the decimal");
  eq(U.fmtEffective(1230000000000), "1.23T", "two real decimals survive");
  eq(U.fmtEffective(0), "0", "zero is zero, not a dash");
  return eq(U.fmtEffective(null), "—", "absent is a dash");
});

check("client fmtEff and lib fmtEffective agree on every magnitude", () => {
  // Two implementations of one display rule is how drift starts. They diverged
  // once already: ".00" was stripped but a lone trailing zero was not.
  const vals = [0, 1, 999, 1e6, 6.9e6, 1e9, 1.23e12, 6.9e15, 7e15, 100000000];
  const bad = vals.filter((v) => api.fmtEff(v) !== U.fmtEffective(v))
    .map((v) => `${v}: client="${api.fmtEff(v)}" lib="${U.fmtEffective(v)}"`);
  return eq(bad, [], "the duplicated formatter has drifted");
});

check("no conversion helper silently accepts nonsense", () => {
  eq(U.fromAtomic("not a number", true), 0);
  eq(U.toAtomic(undefined, true), 0);
  return eq(U.fmtUnits(NaN, true), "—");
});

summary("Unit conversion");
