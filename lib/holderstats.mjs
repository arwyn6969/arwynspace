/**
 * Per-asset holder distribution statistics.
 *
 * Computed over the FULL holder list the upstream returned, before it is truncated
 * to the twelve rows the UI shows. Concentration measured from a truncated tail is
 * not concentration, it is an estimate of it, and this file exists so the number on
 * the page is the real one.
 *
 * Every quantity in and out of here is in HUMAN UNITS. The caller divides raw
 * integers by 1e8 for divisible assets before calling; nothing here rescales.
 * That convention has broken this project twice (a divisible supply reading
 * 100,000,000x too small, then api/market.js nearly shipping the inverse), so it is
 * stated once and held to.
 *
 * The denominator for "reach" is the holder list itself — external units over
 * external plus artist units — deliberately NOT the asset's declared supply.
 * Supply fields arrive from three different sources with three different unit
 * conventions; the holder list is internally consistent with itself. Burned units
 * are reported but excluded from the denominator, because a burned edition is not
 * supply the artist could still distribute.
 */

/**
 * @param rows  [{ address, units }] in human units, the complete list
 * @param opts  { artist: Set<string>, burn: Set<string> }
 * @returns the enriched block, or null when there was no list to measure
 */
export function distributionStats(rows, { artist, burn } = {}) {
  if (!Array.isArray(rows)) return null;

  const A = artist instanceof Set ? artist : new Set(artist || []);
  const B = burn instanceof Set ? burn : new Set(burn || []);

  const external = [], artistRows = [], burnRows = [];
  for (const r of rows) {
    if (B.has(r.address)) burnRows.push(r);
    else if (A.has(r.address)) artistRows.push(r);
    else external.push(r);
  }

  const sum = list => list.reduce((t, r) => t + (Number(r.units) || 0), 0);
  const externalUnits = sum(external);
  const artistUnits = sum(artistRows);
  const burnUnits = sum(burnRows);

  // Distributable base: what exists and is not burned. Zero means there is nothing
  // to have a reach OF, which is not the same as a reach of zero.
  const base = externalUnits + artistUnits;
  const reachPct = base > 0 ? (externalUnits / base) * 100 : null;

  const desc = [...external].sort((x, y) => (Number(y.units) || 0) - (Number(x.units) || 0));
  const shareOf = n => (externalUnits > 0
    ? (desc.slice(0, n).reduce((t, r) => t + (Number(r.units) || 0), 0) / externalUnits) * 100
    : null);

  // Herfindahl over EXTERNAL holdings only: how concentrated the collector base is
  // among itself. Including the artist's own balance would make every undistributed
  // piece look maximally concentrated, which says nothing about its collectors.
  const hhi = externalUnits > 0
    ? desc.reduce((t, r) => {
        const s = ((Number(r.units) || 0) / externalUnits) * 100;
        return t + s * s;
      }, 0)
    : null;

  return {
    holderDataOk: true,
    externalHolders: external.length,
    artistHolders: artistRows.length,
    burnHolders: burnRows.length,
    externalUnits,
    artistUnits,
    burnUnits,
    reachPct,
    top1Share: shareOf(1),
    top5Share: shareOf(5),
    hhi,
  };
}

/**
 * The shape written when the upstream fetch FAILED. An explicit record beats an
 * absent key: absent forces every reader to guess, and this project has shipped
 * that bug four times (D1, D3, D9, dispenserRow). `holderDataOk: false` is a fact
 * the UI can render as "not measured" instead of inventing a zero.
 */
export function holderDataMissing(reason = null) {
  return {
    holderDataOk: false,
    reason,
    externalHolders: null,
    artistHolders: null,
    burnHolders: null,
    externalUnits: null,
    artistUnits: null,
    burnUnits: null,
    reachPct: null,
    top1Share: null,
    top5Share: null,
    hhi: null,
  };
}

/** Keys every enriched entry carries, for the probe's per-collection contract. */
export const DISTRIBUTION_KEYS = Object.freeze([
  "holderDataOk", "externalHolders", "artistHolders", "burnHolders",
  "externalUnits", "artistUnits", "burnUnits",
  "reachPct", "top1Share", "top5Share", "hhi",
]);
