// Recommended feerates (sat/vB), cached (default ~90s). BTC comes from mempool.space; Qbit has no
// external oracle, so it comes from the Qbit node itself (estimatesmartfee → relay floor). Both are
// used to size live claims/refunds (the client reads them from the swap view) and to pick/escalate the
// watchtower's pre-signed fee-ladder tier.
import { qbit } from "./chain.js";
import { pairEsploraUrl } from "./chains.js";
const URL = (process.env.MEMPOOL_URL || pairEsploraUrl()).replace(/\/$/, "");
const TTL = Number(process.env.FEES_TTL_MS || 90000);
let cache = null, at = 0;

const FALLBACK = { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
export async function btcFeerates() {
  if (cache && Date.now() - at < TTL) return cache;
  try {
    const r = await fetch(`${URL}/v1/fees/recommended`);
    if (r.ok) { cache = await r.json(); at = Date.now(); }
  } catch { /* keep last good value */ }
  // fallback (e.g. regtest / offline): 1 sat/vB → the watchtower picks the lowest pre-signed tier
  return cache || FALLBACK;
}
// Synchronous snapshot of the last fetched recommendation, for embedding in the swap view so the
// browser can size its live claim at mempool's "High priority" (fastestFee). Keep it warm by calling
// btcFeerates() on a timer (server.js). `fastestFee` here === mempool.space's High-priority tier.
export const cachedBtcFeerates = () => cache || FALLBACK;

// Qbit feerates from the node's own estimatesmartfee (no external oracle exists for Qbit). Same shape
// and caching as btcFeerates; kept warm on the same server.js timer.
let qcache = null, qat = 0;
export async function qbitFeerates() {
  if (qcache && Date.now() - qat < TTL) return qcache;
  try { const b = await qbit.feeBundle(); if (b) { qcache = b; qat = Date.now(); } } catch { /* keep last good value */ }
  return qcache || FALLBACK;
}
export const cachedQbitFeerates = () => qcache || FALLBACK;
