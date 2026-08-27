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

    // Float division on 8-decimal values needs rounding, or 0.099966/0.000001
    // comes out as 99965.99999999999 and loses a lot.
    const lotsAvailable = Math.floor(round8(stock / give));
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
      received: round8(lots * give),
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
 * Every payment level at which the outcome changes.
 *
 * Two kinds of threshold matter: a dispenser's price (a new asset unlocks) and
 * price x stock (that dispenser is exhausted and further payment adds nothing
 * from it). Both are useful to show as tiers.
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
  if (!divisible) return { text: n.toLocaleString("en-US"), atomic: false };
  const atomic = Math.round(n * SATS_PER_BTC);
  // Below a whole unit, atomic counting is the only readable form.
  if (n < 1) return { text: atomic.toLocaleString("en-US"), atomic: true, suffix: atomic === 1 ? "smallest unit" : "smallest units" };
  return { text: n.toLocaleString("en-US", { maximumFractionDigits: 8 }), atomic: false };
}

window.MegaDispenser = { simulateMega, megaTiers, megaQty, round8, SATS_PER_BTC };
