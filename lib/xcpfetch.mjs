// Counterparty fetch with automatic proxy fallback.
// Direct https://api.counterparty.io:4000 works on Vercel/most hosts.
// Some sandboxes/firewalls block non-standard port 4000 -> fall back to a public proxy.
const XCP = process.env.XCP_API || "https://api.counterparty.io:4000";
let directWorks = null;

async function tryDirect(path, timeout = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(XCP + path, { signal: c.signal });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function tryProxy(path, timeout = 30000) {
  const target = XCP + path;
  const u = "https://api.allorigins.win/get?url=" + encodeURIComponent(target);
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(u, { signal: c.signal });
    if (!r.ok) throw new Error("proxy http " + r.status);
    const w = await r.json();
    return JSON.parse(w.contents);
  } finally { clearTimeout(t); }
}

/**
 * Circuit breaker. When neither the direct node nor the proxy is reachable,
 * every subsequent call would otherwise burn its full retry budget — turning a
 * 79-asset walk into an hour of timeouts. After enough consecutive total
 * failures we fail fast instead, so callers fall back to their other sources
 * immediately.
 */
let consecutiveFailures = 0;
const BREAKER_TRIP = 3;
export const xcpAvailable = () => consecutiveFailures < BREAKER_TRIP;
export function resetXcpBreaker() { consecutiveFailures = 0; }

export async function xcp(path, { retries = 4 } = {}) {
  if (!xcpAvailable()) throw new Error("counterparty unreachable (circuit open)");
  let lastErr;
  for (let i = 0; i < retries; i++) {
    if (directWorks !== false) {
      try { const d = await tryDirect(path); directWorks = true; consecutiveFailures = 0; return d; }
      catch (e) { lastErr = e; if (directWorks === null) directWorks = false; }
    }
    if (directWorks === false) {
      try { const d = await tryProxy(path); consecutiveFailures = 0; return d; }
      catch (e) { lastErr = e; }
    }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  consecutiveFailures++;
  throw new Error(`xcp failed ${path}: ${lastErr?.message}`);
}

// Walk every page of a cursor-paginated endpoint.
export async function xcpAll(path, { limit = 100, cap = 5000 } = {}) {
  const out = []; let cursor = null;
  while (out.length < cap) {
    const sep = path.includes("?") ? "&" : "?";
    const p = `${path}${sep}limit=${limit}` + (cursor ? `&cursor=${cursor}` : "");
    let d;
    try { d = await xcp(p); }
    catch (e) {
      // Keep the pages that already succeeded instead of losing the whole walk.
      // The public node is intermittently unreachable, and a partial list merged
      // with the previous snapshot beats no list at all.
      if (!out.length) throw e;
      out.partial = true;
      console.error(`    page failed; keeping ${out.length} rows (${e.message})`);
      break;
    }
    const rows = d?.result || [];
    out.push(...rows);
    cursor = d?.next_cursor;
    if (!cursor || rows.length === 0) break;
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}
