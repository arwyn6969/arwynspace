/**
 * Quantity units — one convention, normalised at the point of ingest.
 *
 * This module exists because mixing conventions produced confidently wrong
 * numbers rather than errors, which is far harder to notice than a crash.
 *
 * The sources genuinely disagree:
 *
 *   tokenscan.io      HUMAN units, pre-scaled   supply "69000000.00000000" = 69 million
 *   stampchain.io     RAW integers              same dispenser as give_quantity 100
 *   Counterparty v2   RAW integers              supply 6900000000000000
 *
 * A raw integer counts the SMALLEST unit. A divisible asset has 8 decimal
 * places, so raw = human x 1e8. An indivisible asset has no subdivision, so
 * raw and human are the same number.
 *
 * Everything downstream of this module speaks in two explicit fields:
 *   `units`     human-readable amount   (what a person would say they hold)
 *   `atomic`    smallest-unit count     (the chain's own integer)
 *
 * Never divide or multiply by 1e8 anywhere else in the codebase.
 */

export const ATOMIC_PER_UNIT = 1e8;

/** How many atomic units make up one whole unit of this asset. */
export const atomicFactor = divisible => (divisible ? ATOMIC_PER_UNIT : 1);

/** Convert a RAW/atomic value (stampchain, Counterparty) into human units. */
export function fromAtomic(raw, divisible) {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n / atomicFactor(divisible);
}

/** Convert a HUMAN value (tokenscan) into atomic units. */
export function toAtomic(units, divisible) {
  const n = Number(units ?? 0);
  if (!Number.isFinite(n)) return 0;
  // Rounded because float maths on 8 decimals otherwise yields 20999999.999999996.
  return Math.round(n * atomicFactor(divisible));
}

/**
 * Normalise a quantity from a named source into both representations.
 * `source` must be one of the known conventions so a new source can't be
 * silently assumed to match an old one.
 */
const HUMAN_SOURCES  = new Set(["tokenscan"]);
const ATOMIC_SOURCES = new Set(["stampchain", "counterparty"]);

export function normalizeQuantity(value, divisible, source) {
  if (HUMAN_SOURCES.has(source))  {
    const units = Number(value ?? 0) || 0;
    return { units, atomic: toAtomic(units, divisible) };
  }
  if (ATOMIC_SOURCES.has(source)) {
    const atomic = Number(value ?? 0) || 0;
    return { units: fromAtomic(atomic, divisible), atomic };
  }
  throw new Error(`normalizeQuantity: unknown source "${source}" — declare its unit convention first`);
}

/**
 * Effective supply: how many separately ownable things exist.
 *
 * The smallest ownable unit counts as one, exactly as a 1-of-1 counts as one.
 * A divisible asset therefore splits into 1e8 ownable pieces per whole unit.
 * This is identical to the chain's raw integer, so it isn't a house convention —
 * it's Counterparty's own definition of supply.
 *
 * Consequence worth understanding: a divisible asset with supply 1 has 100
 * million ownable units and is common, not rare. That is correct.
 */
export function effectiveSupply(units, divisible) {
  return toAtomic(units, divisible);
}

/**
 * Rarity classification, accounting for the fact that zero supply means two
 * completely different things depending on whether issuance is locked.
 *
 *   locked + zero supply    a real, final state — nothing exists and none can be made
 *   unlocked + zero supply  never minted, or not minted yet — no claim to rarity
 */
export function rarityOf(asset) {
  const units = Number(asset.supply ?? 0) || 0;
  const divisible = !!asset.divisible;
  const locked = !!asset.locked;

  if (units === 0) {
    return locked
      ? { effective: 0, rank: "burned",    rankable: true,  label: "Zero supply, locked" }
      : { effective: null, rank: "unminted", rankable: false, label: "Not minted" };
  }
  return {
    effective: effectiveSupply(units, divisible),
    rank: "issued",
    rankable: true,
    label: null,
  };
}

/**
 * Sort comparator for rarest-first. Unrankable (never minted) assets always sit
 * at the end regardless of direction, because they have no supply to compare.
 */
export function byRarity(a, b) {
  const ra = rarityOf(a), rb = rarityOf(b);
  if (!ra.rankable && !rb.rankable) return 0;
  if (!ra.rankable) return 1;
  if (!rb.rankable) return -1;
  return ra.effective - rb.effective;
}

/**
 * Trim pointless trailing zeros from a fixed(2) string.
 *
 * The earlier form only stripped an exact ".00", so 7.00 became "7" but 6.90 stayed
 * "6.90" — the same rule producing two different conventions. Duplicated verbatim in
 * public/app.js `fmtEff` (a browser script that cannot import this module);
 * test/units.test.mjs asserts the two agree on every magnitude.
 */
const trimZeros = s => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/** Compact display for very large effective supplies. */
export function fmtEffective(n) {
  if (n == null) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15) return trimZeros((n / 1e15).toFixed(2)) + "Q";
  if (abs >= 1e12) return trimZeros((n / 1e12).toFixed(2)) + "T";
  if (abs >= 1e9)  return trimZeros((n / 1e9).toFixed(2))  + "B";
  if (abs >= 1e6)  return trimZeros((n / 1e6).toFixed(2))  + "M";
  return n.toLocaleString("en-US");
}

/** Human-units display, trimming the trailing zeros 8-decimal formatting leaves. */
export function fmtUnits(units, divisible) {
  if (units == null) return "—";
  const n = Number(units);
  if (!Number.isFinite(n)) return "—";
  if (!divisible) return n.toLocaleString("en-US");
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
