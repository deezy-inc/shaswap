// Layer-1 production monitor. Polls the coordinator's admin API (tailnet-only) and alerts to Telegram
// on anything that could cost a customer funds. Deterministic, read-only, no LLM — it's the safety net
// that must fire reliably. The coordinator's watchtower is the automated ACTOR (claims/refunds for
// offline parties); this watches whether the watchtower + nodes are healthy enough to do their job, and
// pages a human when a swap's own risk flags (from admin.js riskOf) persist longer than the watchtower
// should need.
//
// Run on the swap-server box via cron (every ~2 min):
//   */2 * * * * set -a; . /home/ubuntu/qbit-monitor.env; set +a; /usr/bin/node /home/ubuntu/qbit-otc/coordinator/monitor.js >> /home/ubuntu/qbit-monitor.log 2>&1
// Env: ADMIN_URL (default http://127.0.0.1:8790) · ADMIN_TOKEN · TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID ·
//      MONITOR_STATE (state file) · GRACE_MIN · STALL_MIN · STUCK_HOURS · RE_ALERT_MIN · HEARTBEAT_HOURS
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ADMIN = (process.env.ADMIN_URL || "http://127.0.0.1:8790").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN || "";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "", TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const STATE_PATH = process.env.MONITOR_STATE || "/home/ubuntu/qbit-monitor-state.json";
const GRACE_MIN = Number(process.env.GRACE_MIN || 10);        // let the watchtower act before paging on a swap risk flag
const STALL_MIN = Number(process.env.STALL_MIN || 20);        // a chain height stuck this long = node problem
const STUCK_HOURS = Number(process.env.STUCK_HOURS || 6);     // active + funded, this old, still not settled
const RE_ALERT_MIN = Number(process.env.RE_ALERT_MIN || 30);  // re-page a still-active issue this often
const HEARTBEAT_HOURS = Number(process.env.HEARTBEAT_HOURS || 24);  // periodic "all clear" (0 = off)
// Disk-usage alerts across the fleet. This monitor runs on swap-server; it reads its OWN disk locally and
// the two nodes' disk over SSH with a dedicated key that's FORCED to only run `df -P /` (no shell). Hosts
// as name:host (empty host = local). WARN then CRITICAL thresholds; both page (and clear) via the same
// grace/cooldown/recovery path as everything else.
const DISK_WARN_PCT = Number(process.env.DISK_WARN_PCT || 85);
const DISK_CRIT_PCT = Number(process.env.DISK_CRIT_PCT || 92);
const MONITOR_SSH_KEY = process.env.MONITOR_SSH_KEY || "/home/ubuntu/.ssh/id_ed25519_monitor";
// MagicDNS hostnames, not raw tailnet IPs: a node re-joining the tailnet gets a NEW IP (it happened —
// btc-mainnet-prune moved 100.83.251.84 → 100.67.241.68 on 2026-08-08) and a pinned IP silently breaks.
const DISK_HOSTS = (process.env.DISK_HOSTS || "swap-server:,swap-node:qbit-swap-node,btc-pruned:btc-mainnet-prune")
  .split(",").map((h) => h.trim()).filter(Boolean).map((h) => { const i = h.indexOf(":"); return { name: h.slice(0, i), host: h.slice(i + 1) || null }; });
const now = Date.now();

const short = (id) => (id || "").slice(0, 10);
let LBL = { btc: "BTC", qbit: "QBT" };   // pair display tickers — refreshed from the overview each run (CHAIN2-aware)
const fmtAmt = (s) => `${(s.btcSats || 0) / 1e8} ${escHtml(LBL.btc)} ⇄ ${(s.qbtSats || 0) / 1e8} ${escHtml(LBL.qbit)}`;
const mins = (ms) => Math.round(ms / 60000);
const stEmoji = (st) => ({ CREATED: "🆕", READY: "🤝", FROM_FUNDED: "💰", TO_FUNDED: "💰", MATURING: "⏳", CLAIMABLE: "🔓", CLAIMED: "🔑", COMPLETE: "✅", REFUNDED: "↩️", CANCELED: "🚫", ABORTED: "⚠️" }[st] || "🔄");
// Percent-used of the root filesystem on `host` (null = local): parse `df -P /`'s Capacity column. For a
// remote host, ssh runs it via the forced-command key (any command → `df -P /`). Throws on failure.
function diskPct(host) {
  const out = host
    ? execFileSync("ssh", ["-i", MONITOR_SSH_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", `ubuntu@${host}`, "true"], { encoding: "utf8", timeout: 15000 })
    : execFileSync("df", ["-P", "/"], { encoding: "utf8", timeout: 8000 });
  const m = out.trim().split("\n").pop().match(/(\d+)%/);   // last line, Capacity column
  if (!m) throw new Error("unparseable df output");
  return Number(m[1]);
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.error("[no telegram]", text.replace(/<[^>]+>/g, "")); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.error("telegram send failed", r.status, await r.text().catch(() => ""));
  } catch (e) { console.error("telegram error", e.message); }
}
// Coordinator-supplied strings (error messages, chain labels) are untrusted — escape before HTML mode.
const escHtml = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const api = async (p) => {
  const r = await fetch(`${ADMIN}${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const loadState = () => { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; } };
const saveState = (s) => { try { writeFileSync(STATE_PATH, JSON.stringify(s)); } catch (e) { console.error("state write failed", e.message); } };

// Page for an issue, honoring a grace period (for self-healing risk flags) and a re-alert cooldown.
async function maybeAlert(state, i) {
  const a = (state.alerts[i.key] ||= { firstSeen: now, lastSent: 0 });
  if (i.grace && now - a.firstSeen < GRACE_MIN * 60000) return;   // give the watchtower / a returning user time
  if (now - a.lastSent < RE_ALERT_MIN * 60000) return;           // don't spam a known issue
  await tg(`<b>[${i.sev}]</b> ${i.msg}`);
  a.lastSent = now;
}

async function main() {
  const state = loadState();
  state.alerts ||= {}; state.heights ||= {}; state.heightsAt ||= {};
  const firstRun = !state.swapStates; state.swapStates ||= {};   // first run records a baseline (no backlog flood)

  const issues = [];   // { key, sev, msg, grace? }

  let ov;
  try { ov = await api("/api/overview"); }
  catch (e) {
    // The admin API itself is our only visibility — if it's unreachable, that's the top alarm.
    await maybeAlert(state, { key: "admin-unreachable", sev: "CRITICAL", msg: `⛔ Coordinator admin API unreachable: ${e.message}` });
    saveState(state); return;
  }
  if (state.alerts["admin-unreachable"]) { await tg("✅ Coordinator admin API reachable again"); delete state.alerts["admin-unreachable"]; }
  if (ov.labels) LBL = ov.labels;

  // Node connectivity (both legs) + chain-height stall (QBT only). Bitcoin routinely goes >20 min
  // between blocks — that's expected variance, not a fault — so a height-stall alert on BTC is pure
  // noise; we track its height but never page on the gap. QBT targets ~75s blocks, so a stall there
  // is a genuine node problem worth an alert. Node-UNREACHABLE still alerts on both legs.
  for (const leg of ["btc", "qbit"]) {
    const c = ov.chains?.[leg];
    if (!c?.ok) { issues.push({ key: `node-down-${leg}`, sev: "CRITICAL", msg: `⛔ ${leg.toUpperCase()} node unreachable (${escHtml(c?.backend)}): ${escHtml(c?.error) || "no height"}` }); continue; }
    const prev = state.heights[leg], prevAt = state.heightsAt[leg] || now;
    if (leg === "qbit" && prev != null && c.height === prev && now - prevAt > STALL_MIN * 60000)
      issues.push({ key: `stall-${leg}`, sev: "CRITICAL", msg: `⛔ QBT height stuck at ${c.height} for ${mins(now - prevAt)} min` });
    if (prev == null || c.height !== prev) { state.heights[leg] = c.height; state.heightsAt[leg] = now; }
  }

  // Disk usage across the fleet (swap-server local + the two nodes over the df-only SSH key). CRITICAL at
  // ≥DISK_CRIT_PCT, WARN at ≥DISK_WARN_PCT; a host we can't reach for a df is its own WARN. maybeAlert +
  // the resolve pass give these the same loud page + auto-recovery as node outages.
  for (const { name, host } of DISK_HOSTS) {
    let pct;
    try { pct = diskPct(host); }
    catch (e) { issues.push({ key: `disk-check-${name}`, sev: "WARN", msg: `⚠️ Can't read disk on <b>${name}</b>: ${escHtml(String(e.message || e).split("\n")[0])}` }); continue; }
    if (pct >= DISK_CRIT_PCT) issues.push({ key: `disk-${name}`, sev: "CRITICAL", msg: `🛑 Disk <b>${pct}% full</b> on <b>${name}</b> (≥${DISK_CRIT_PCT}%) — free space NOW` });
    else if (pct >= DISK_WARN_PCT) issues.push({ key: `disk-${name}`, sev: "WARN", msg: `⚠️ Disk <b>${pct}% full</b> on <b>${name}</b> (≥${DISK_WARN_PCT}%)` });
    state.disk = { ...(state.disk || {}), [name]: pct };   // last-seen % (for the recovery message)
  }

  const swaps = await api("/api/swaps");

  // Ping on every swap STATE CHANGE — created, → funding, → claimable, → claimed, → complete, refunded, etc.
  // The state file holds each swap's last-seen state across runs; the first run just records a baseline so we
  // don't replay the whole backlog. Informational, so it's sent immediately (no grace / cooldown).
  //
  // BACKFILL, not news: an UNSEEN id that's already settled is almost never a fresh event — it's an old
  // swap re-entering the admin list (a coordinator restart reloading the store, the admin list's history
  // fix, an eviction round-trip). Announcing those dumps the whole backlog at once. So an unseen id in a
  // terminal state is recorded SILENTLY unless it settled within the last ~30 min (a genuinely fresh
  // completion the monitor just hadn't seen mid-flight). Transitions of KNOWN swaps always ping.
  {
    const TERMINAL_STATES = ["COMPLETE", "REFUNDED", "ABORTED", "CANCELED"];
    const live = new Set();
    for (const s of swaps) {
      live.add(s.id);
      const prev = state.swapStates[s.id];
      if (!firstRun && prev !== s.state) {
        const staleBackfill = prev === undefined && TERMINAL_STATES.includes(s.state) && !(s.settledAt && now - s.settledAt < 30 * 60000);
        if (!staleBackfill) await tg(prev === undefined
          ? `${stEmoji(s.state)} New swap <code>${short(s.id)}</code> · ${fmtAmt(s)} · <b>${s.state}</b>`
          : `${stEmoji(s.state)} Swap <code>${short(s.id)}</code> · ${fmtAmt(s)}: ${prev} → <b>${s.state}</b>`);
      }
      state.swapStates[s.id] = s.state;
    }
    for (const id of Object.keys(state.swapStates)) if (!live.has(id)) delete state.swapStates[id];   // forget pruned swaps
  }

  // Per-swap risk. riskOf() flags a funded leg past its timelock, an unprotected (offline, un-armed)
  // deposit, or a public preimage the participant hasn't claimed — the actual fund-loss conditions.
  for (const s of swaps) {
    for (const flag of (s.risk || []))
      issues.push({ key: `risk:${s.id}:${flag}`, sev: "CRITICAL", grace: true, msg: `⚠️ Swap <code>${short(s.id)}</code> (${fmtAmt(s)}): ${flag}` });
    // Underfunded deposit — but only while it's still there. A refund spends the short UTXO
    // (shortFunded[leg].spent → true) and moves the swap to REFUNDED; once that happens this drops out
    // of the issue set and the resolve pass announces it cleared, so a refunded short stops pinging.
    const shortOpen = s.short && Object.values(s.short).some((sf) => sf && !sf.spent) && !["REFUNDED", "ABORTED", "CANCELED", "COMPLETE"].includes(s.state);
    if (shortOpen)
      issues.push({ key: `short:${s.id}`, sev: "WARN", msg: `⚠️ Swap <code>${short(s.id)}</code> underfunded: got ${JSON.stringify(s.short)}` });
    const active = !["COMPLETE", "REFUNDED", "ABORTED", "CANCELED", "CREATED"].includes(s.state);
    if (active && (s.funded?.btc || s.funded?.qbit) && s.createdAt && now - s.createdAt > STUCK_HOURS * 3600000)
      issues.push({ key: `stuck:${s.id}`, sev: "WARN", msg: `⚠️ Swap <code>${short(s.id)}</code> funded but ${s.state} for ${Math.round((now - s.createdAt) / 3600000)}h` });
  }

  // Fire new/re-due issues; announce ones that have cleared. Recovery pings mirror the alert that fired:
  // a node/chain coming back gets an explicit "reachable/advancing again (height N)" — not a terse key —
  // so the all-clear is as legible as the alarm was.
  const seen = new Set(issues.map((i) => i.key));
  for (const i of issues) await maybeAlert(state, i);
  for (const key of Object.keys(state.alerts)) {
    if (key === "admin-unreachable" || key === "_heartbeat") continue;
    if (seen.has(key)) continue;
    const h = (leg) => { const n = ov.chains?.[leg]?.height; return n != null ? ` (height ${n})` : ""; };
    let msg;
    if (key.startsWith("node-down-")) { const leg = key.slice(10); msg = `✅ ${leg.toUpperCase()} node reachable again${h(leg)}`; }
    else if (key.startsWith("stall-")) { const leg = key.slice(6); msg = `✅ ${leg.toUpperCase()} chain advancing again${h(leg)}`; }
    else if (key.startsWith("disk-check-")) { msg = `✅ Disk readable again on <b>${key.slice(11)}</b>`; }
    else if (key.startsWith("disk-")) { const name = key.slice(5); const pct = state.disk?.[name]; msg = `✅ Disk back under threshold on <b>${name}</b>${pct != null ? ` (${pct}%)` : ""}`; }
    else msg = `✅ Resolved: <code>${key}</code>`;
    await tg(msg); delete state.alerts[key];
  }

  // Optional periodic "all clear" so silence-because-broken is distinguishable from silence-because-fine.
  if (HEARTBEAT_HOURS > 0) {
    const hb = state.alerts._heartbeat || { lastSent: 0 };
    if (now - hb.lastSent > HEARTBEAT_HOURS * 3600000) {
      await tg(`✅ qbitswap monitor OK · ${ov.totals?.active || 0} active · ${ov.totals?.complete || 0} complete · BTC h${ov.chains?.btc?.height} · QBT h${ov.chains?.qbit?.height}`);
      state.alerts._heartbeat = { lastSent: now };
    }
  }

  saveState(state);
  console.log(`[monitor] ${new Date(now).toISOString()} — ${issues.length} issue(s), ${swaps.length} swap(s)`);
}

main().catch((e) => { console.error("monitor error", e.message); process.exit(1); });
