/* ============================================================
   Mega dispenser simulation.

   A Counterparty address can hold many open dispensers at once, and a single BTC
   payment triggers EVERY dispenser at that address whose price the payment meets.
   Each one gives as many lots as the payment covers, limited by its stock.

   The arithmetic below is ported directly from counterparty-core
   (lib/messages/dispense.py) and then verified against this address's real
   dispense history: 53 historical events reproduced exactly, zero contradictions,
   including multi-lot cases such as a 22,220 sat payment yielding 3 lots from a
   6,900 sat dispenser.

       lots_wanted    = floor(payment_sats / price_sats)
       lots_available = floor(remaining / give_per_lot)
       lots_given     = min(lots_wanted, lots_available)
       received       = lots_given * give_per_lot

   Nothing here composes or broadcasts a transaction. It is a projection of what
   the chain would do, and the chain remains the authority.
   ============================================================ */

const SATS_PER_BTC = 1e8;

/**
 * Simulate a payment against a set of dispensers sharing one address.
 *
 * `dispensers` use the normalised shape written by the indexer:
 *   { asset, assetLongname, priceSats, giveUnits, remainingUnits, divisible }
 */
function simulateMega(dispensers, paymentSats) {
  const sats = Math.max(0, Math.floor(Number(paymentSats) || 0));
  const results = [];

  for (const d of dispensers) {
    const price = Number(d.priceSats) || 0;
    const give = Number(d.giveUnits) || 0;
    const stock = Number(d.remainingUnits) || 0;
    if (price <= 0 || give <= 0) continue;

    const lotsWanted = Math.floor(sats / price);
    if (lotsWanted < 1) {
      results.push({ ...d, triggered: false, lotsWanted: 0, lotsAvailable: null, lots: 0, received: 0 });
      continue;
    }

    // Count lots in integer atomic units rather than dividing floats.
    //
    // The previous form was Math.floor(round8(stock / give)). That is correct for
    // every dispenser currently open, but round8 multiplies by 1e8, and for a
    // divisible asset dispensing atomic lots the intermediate exceeds
    // Number.MAX_SAFE_INTEGER: a 69,000,000 stock at 0.00000001 per lot gives
    // 6.9e23 inside round8 and returns 6,899,999,999,999,999 — one lot short, with
    // no error raised. Atomic units are exact integers, so the division is exact.
    const lotsAvailable = Math.floor(atomicUnits(stock) / atomicUnits(give));
    const lots = Math.min(lotsWanted, lotsAvailable);
    if (lots < 1) {
      results.push({ ...d, triggered: false, empty: true, lotsWanted, lotsAvailable, lots: 0, received: 0 });
      continue;
    }

    results.push({
      ...d,
      triggered: true,
      lotsWanted,
      lotsAvailable,
      lots,
      // Also atomic, and clamped: what is dispensed can never exceed what is held.
      received: Math.min(lots * atomicUnits(give), atomicUnits(stock)) / SATS_PER_BTC,
      // Factual, not editorial: the payment covered more lots than exist.
      stockCapped: lots < lotsWanted,
    });
  }

  const hits = results.filter(r => r.triggered);
  return {
    paymentSats: sats,
    paymentBtc: sats / SATS_PER_BTC,
    assets: hits.length,
    totalDispensers: dispensers.length,
    anyCapped: hits.some(r => r.stockCapped),
    results,
    hits,
  };
}

/** 8-decimal rounding, since every quantity here is an 8-decimal chain value. */
function round8(n) {
  return Math.round(Number(n) * SATS_PER_BTC) / SATS_PER_BTC;
}

/**
 * A quantity as an exact integer count of smallest units.
 *
 * Counterparty stores divisible quantities as 8-decimal fixed point, so the integer
 * form is the chain's own representation and arithmetic on it is exact. Prefer this
 * over float division whenever the result feeds a lot count.
 *
 * lib/units.mjs says the 1e8 factor must live nowhere else, and it is right — but it
 * is an ES module and this file is a plain browser script that cannot import it.
 * This is the one deliberate duplication, kept identical to units.mjs `toAtomic`
 * and covered by test/units.test.mjs, which asserts the two agree.
 */
function atomicUnits(n) {
  return Math.round(Number(n) * SATS_PER_BTC);
}

/**
 * Every payment level at which the outcome changes.
 *
 * Two kinds of threshold exist: a dispenser's price, where a new asset unlocks, and
 * price x stock, where that dispenser is exhausted and further payment adds nothing
 * from it. Only the unlock prices are returned as tiers — exhaustion is surfaced per
 * row via stockCapped instead, which keeps the tier list to the levels a buyer
 * actually chooses between. The earlier wording here claimed both were returned.
 */
function megaTiers(dispensers) {
  const points = new Set();
  for (const d of dispensers) {
    const price = Number(d.priceSats) || 0;
    if (price > 0) points.add(price);
  }
  return [...points].sort((a, b) => a - b).map(sats => {
    const sim = simulateMega(dispensers, sats);
    return {
      sats,
      btc: sats / SATS_PER_BTC,
      assets: sim.assets,
      unlocks: dispensers.filter(d => Number(d.priceSats) === sats),
      anyCapped: sim.anyCapped,
    };
  });
}

/**
 * Present a quantity in the clearest available terms.
 *
 * Divisible dispensers deal in atomic units — BTCPUNK.4505 gives 0.00000001 per
 * lot, and 65 lots renders as 6.5e-7, which tells a reader nothing. Expressing
 * those as a count of smallest units is far more legible, and matches how
 * effective supply is defined elsewhere in the site.
 */
function megaQty(received, divisible) {
  const n = Number(received) || 0;
  // maximumFractionDigits, not a bare toLocaleString() — that defaults to 3 and is
  // what rendered small chain values as "0" elsewhere on the site.
  if (!divisible) return { text: n.toLocaleString("en-US", { maximumFractionDigits: 8 }), atomic: false };
  const atomic = Math.round(n * SATS_PER_BTC);
  // Below a whole unit, atomic counting is the only readable form.
  if (n < 1) return { text: atomic.toLocaleString("en-US"), atomic: true, suffix: atomic === 1 ? "smallest unit" : "smallest units" };
  return { text: n.toLocaleString("en-US", { maximumFractionDigits: 8 }), atomic: false };
}

window.MegaDispenser = { simulateMega, megaTiers, megaQty, round8, SATS_PER_BTC };
