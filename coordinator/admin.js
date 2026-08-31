// Admin dashboard for the keyless coordinator — a read-only window into the swap store, order book,
// and chain state, with a live feed. Runs IN-PROCESS with the coordinator so it reads the live
// in-memory store directly (no DB polling). It is NOT routed through the public Cloudflare Tunnel;
// bind it for the tailnet (ADMIN_BIND, default 0.0.0.0 behind a closed security group) and gate it
// with ADMIN_TOKEN. Read-only: it exposes no mutation endpoints and redacts capability tokens.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { allSwaps, getSwap, isOnline, subscribeAll, storeBackend, persistedCounts, persistedVolume, swapsIncludingSettled } from "./swap.js";
import { allOffers } from "./offers.js";
import { rfqStatus } from "./rfq.js";
import { publicChains, chain2Preset } from "./chains.js";
// Dashboard branding follows the pair: a bip110 (shaswap) deployment shouldn't say "qbit-swap".
const brandName = () => (chain2Preset() === "bip110" ? "shaswap" : "qbit-swap");
import { qbit, btc } from "./chain.js";

const TERMINAL = ["COMPLETE", "REFUNDED", "ABORTED"];
const active = (s) => !TERMINAL.includes(s.state);

// Flag swaps that need a human's eye: real funds are committed and something is wrong or unprotected.
// Returns a list of short reason strings (empty = healthy).
function riskOf(s) {
  if (!s.roles || TERMINAL.includes(s.state)) return [];
  const { fromLeg, toLeg } = s.roles, H = s.heights || {}, L = s.locktimes || {};
  const unspent = (leg) => s.funding?.[leg] && !s.funding[leg].spent;
  const armed = { alice: !!s.finish?.alice, bob: !!s.finish?.bob };
  const away = (role) => !isOnline(s, role);
  const r = [];
  // a funded, unspent leg whose timelock has already passed — it should have claimed/refunded by now
  for (const leg of [fromLeg, toLeg])
    if (leg && unspent(leg) && L[leg] && (H[leg] || 0) >= L[leg]) r.push(`${leg} leg past timelock (h${H[leg] || 0}≥${L[leg]})`);
  // a deposit is locked but its owner is offline and never armed the watchtower — nobody will act for them
  for (const [role, leg] of [["alice", fromLeg], ["bob", toLeg]])
    if (leg && unspent(leg) && away(role) && !armed[role]) r.push(`${role}'s ${leg} deposit unprotected (offline, no watchtower)`);
  // preimage is public but the participant hasn't claimed and can't be helped — risk of losing their side
  if (s.preimage && unspent(fromLeg) && away("bob") && !armed.bob) r.push(`preimage public, bob hasn't claimed ${fromLeg} (offline, no watchtower)`);
  return r;
}

// ── redacted projections (never leak tokens / raw signed tx bundles) ──────────────────────────
function summary(s) {
  return {
    id: s.id, direction: s.terms?.direction, state: s.state,
    createdAt: s.createdAt || null, settledAt: s.settledAt || null,
    btcSats: s.terms?.btcSats, qbtSats: s.terms?.qbtSats,
    fromLeg: s.roles?.fromLeg, toLeg: s.roles?.toLeg,
    funded: { btc: !!s.funding?.btc, qbit: !!s.funding?.qbit },
    spent: { btc: !!s.funding?.btc?.spent, qbit: !!s.funding?.qbit?.spent },
    joined: { alice: !!s.party?.alice, bob: !!s.party?.bob },
    online: { alice: isOnline(s, "alice"), bob: isOnline(s, "bob") },
    armed: { alice: !!s.finish?.alice, bob: !!s.finish?.bob }, // watchtower pre-signed
    preimage: !!s.preimage,
    short: s.shortFunded || null,
    risk: riskOf(s),
  };
}
function detail(s) {
  return {
    ...summary(s),
    terms: s.terms, roles: s.roles, locktimes: s.locktimes, confsTarget: s.confsTarget,
    htlc: { btc: s.htlc?.btc?.address || null, qbit: s.htlc?.qbit?.address || null },
    funding: s.funding, heights: s.heights, refund: s.refund,
    broadcasts: s.broadcasts, wt: s.wt || null,
    // Pre-signed watchtower recovery bundle each party uploaded: a compact summary + the full txs.
    recovery: {
      alice: s.finish?.alice ? { claimLeg: s.finish.alice.claim?.leg, needsPreimage: s.finish.alice.claim?.needsPreimage, tiers: (s.finish.alice.claim?.tiers || []).map((t) => t.feerate), refundLeg: s.finish.alice.refund?.leg } : null,
      bob: s.finish?.bob ? { claimLeg: s.finish.bob.claim?.leg, needsPreimage: s.finish.bob.claim?.needsPreimage, tiers: (s.finish.bob.claim?.tiers || []).map((t) => t.feerate), refundLeg: s.finish.bob.refund?.leg } : null,
    },
    finish: s.finish || null,   // full pre-signed claim ladder + refund txs (broadcast-ready; pay only their owner)
    party: {
      alice: s.party?.alice ? { btcPub: s.party.alice.btcPub, qbitPub: s.party.alice.qbitPub, btcDest: s.party.alice.btcDest, qbitDest: s.party.alice.qbitDest } : null,
      bob: s.party?.bob ? { btcPub: s.party.bob.btcPub, qbitPub: s.party.bob.qbitPub, btcDest: s.party.bob.btcDest, qbitDest: s.party.bob.qbitDest } : null,
    },
  };
}

// Every action the coordinator's watchtower took on behalf of an OFFLINE party, flattened across swaps
// and enriched: resolve the tier index to its actual feerate, and which leg/chain it hit. Newest first.
function watchtowerActions() {
  const out = [];
  for (const s of swapsIncludingSettled()) {   // incl. evicted settled swaps — their wt actions are history worth showing
    for (const [key, rec] of Object.entries(s.wt || {})) {
      const [role, kind] = key.split(":");
      const leg = kind === "claim"
        ? (role === "alice" ? s.roles?.toLeg : s.roles?.fromLeg)     // claim: initiator takes toLeg, participant takes fromLeg
        : (role === "alice" ? s.roles?.fromLeg : s.roles?.toLeg);    // refund: own funded leg
      const feerate = kind === "claim" && typeof rec.tier === "number"
        ? s.finish?.[role]?.claim?.tiers?.[rec.tier]?.feerate ?? null : null;
      out.push({ swapId: s.id, role, kind, leg, tier: rec.tier, feerate, txid: rec.txid, at: rec.at, ts: rec.ts || null, state: s.state });
    }
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

async function chainInfo(c) {
  try { return { backend: c.backend, watch: c.watch, height: await c.height(), ok: true }; }
  catch (e) { return { backend: c.backend, watch: c.watch, height: null, ok: false, error: String(e.message || e) }; }
}

async function overview() {
  const swaps = allSwaps();   // in-memory WORKING SET (active + recently-settled; long-settled are evicted)
  // Full-history counts/volume from the store (includes evicted swaps); fall back to the working set when
  // the backend can't aggregate (JSON/memory — nothing is evicted there, so the Map IS the full history).
  const pc = persistedCounts(), pv = persistedVolume();
  let onlineSwaps = 0, memVolBtc = 0, memVolQbt = 0; const memCounts = {};
  for (const s of swaps) {
    memCounts[s.state] = (memCounts[s.state] || 0) + 1;
    if (isOnline(s, "alice") || isOnline(s, "bob")) onlineSwaps++;
    if (s.state === "COMPLETE") { memVolBtc += s.terms?.btcSats || 0; memVolQbt += s.terms?.qbtSats || 0; }
  }
  const counts = pc || memCounts;
  const volume = pv ? { btcSats: pv.btcSats, qbtSats: pv.qbtSats } : { btcSats: memVolBtc, qbtSats: memVolQbt };
  const totalSwaps = pc ? Object.values(pc).reduce((a, n) => a + n, 0) : swaps.length;
  const offers = allOffers();
  const offerCounts = offers.reduce((a, o) => ((a[o.status] = (a[o.status] || 0) + 1), a), {});
  const [b, q] = await Promise.all([chainInfo(btc), chainInfo(qbit)]);
  return {
    now: Date.now(), network: process.env.NETWORK || "regtest", persistence: storeBackend(),
    labels: { btc: publicChains().btc.label, qbit: publicChains().qbit.label },   // pair display tickers (CHAIN2-aware)
    chains: { btc: b, qbit: q },
    counts,
    totals: {
      swaps: totalSwaps,
      active: swaps.filter(active).length,   // active swaps are never evicted → always in the working set
      complete: counts.COMPLETE || 0,
      refunded: (counts.REFUNDED || 0) + (counts.ABORTED || 0),
      inMemory: swaps.length,                // working-set size (bounded); vs totals.swaps (full history)
      onlineSwaps,
      wtActions: swaps.reduce((n, s) => n + Object.keys(s.wt || {}).length, 0),
      atRisk: swaps.reduce((n, s) => n + (riskOf(s).length ? 1 : 0), 0),
    },
    volume,
    offers: { total: offers.length, ...offerCounts },
    rfq: rfqStatus(),   // maker-bot liquidity: who's live, quote ages, pending matches (never keys/tokens)
  };
}

// ── server ────────────────────────────────────────────────────────────────────────────────────
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

export function startAdmin(port = Number(process.env.ADMIN_PORT || 8790), opts = {}) {
  // Bind loopback by default (tailnet-only box: serve.js sets ADMIN_BIND when it routes out).
  const bind = opts.bind || process.env.ADMIN_BIND || "127.0.0.1";
  // Token compared with timingSafeEqual (no length/timing oracle); per-IP backoff after failures.
  const TOKEN = opts.token || process.env.ADMIN_TOKEN || randomBytes(24).toString("hex");
  const tokenBuf = Buffer.from(TOKEN);
  const failures = new Map();
  const authed = (req, url) => {
    const ip = req.socket.remoteAddress || "?";
    const f = failures.get(ip);
    if (f && Date.now() - f.at < Math.min(60_000, 500 * 2 ** Math.min(f.n, 7))) return false;   // backoff active
    const t = req.headers["x-admin-token"] || url.searchParams.get("token") || "";
    const ok = t && t.length === TOKEN.length && timingSafeEqual(Buffer.from(t), tokenBuf);
    const rec = failures.get(ip) || { n: 0, at: 0 };
    failures.set(ip, ok ? { n: 0, at: 0 } : { n: rec.n + 1, at: Date.now() });
    return ok;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (p === "/" || p === "/index.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE.replaceAll("qbit-swap", brandName())); }
      // everything under /api requires the token
      if (p.startsWith("/api/") || p === "/stream") {
        if (!authed(req, url)) return json(res, 401, { error: "admin token required (?token= or X-Admin-Token)" });
      }
      if (p === "/api/overview") return json(res, 200, await overview());
      if (p === "/api/swaps") {
        const st = url.searchParams.get("state");
        // Memory + store, merged — the working set alone loses completed swaps once they evict (24h).
        let list = swapsIncludingSettled(Math.min(Number(url.searchParams.get("limit")) || 1000, 5000)).map(summary);
        if (st) list = list.filter((s) => s.state === st);
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return json(res, 200, list);
      }
      if (p.startsWith("/api/swaps/")) {
        const id = p.slice("/api/swaps/".length);
        const s = getSwap(id);   // O(1) map lookup, not an O(n) scan of every swap
        return s ? json(res, 200, detail(s)) : json(res, 404, { error: "no such swap" });
      }
      if (p === "/api/offers") return json(res, 200, allOffers());
      if (p === "/api/watchtower") return json(res, 200, watchtowerActions());
      if (p === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": connected\n\n"); // immediate flush so EventSource fires onopen right away
        const send = (s) => res.write(`data: ${JSON.stringify(summary(s))}\n\n`);
        const unsub = subscribeAll(send);
        const hb = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => { clearInterval(hb); unsub(); });
        return;
      }
      return json(res, 404, { error: "not found" });
    } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  });

  return new Promise((resolve) => server.listen(port, bind, () => {
    const access = process.env.ADMIN_TOKEN ? "with your configured token" : `ephemeral token: ${TOKEN}`;
    console.log(`  admin dashboard: http://${bind}:${port} (${access}) — set ADMIN_TOKEN to keep it stable`);
    resolve(server);
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) startAdmin();

// ── single-file dashboard ───────────────────────────────────────────────────────────────────
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>qbit-swap · admin</title>
<style>
:root{--bg:#0b0e14;--surface:#131722;--surface2:#1a1f2e;--line:#242b3d;--ink:#f3f5fb;--dim:#8b95ad;--accent:#6b93ff;--good:#3fd98b;--warn:#f4c14e;--bad:#ff6b6b;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,14,20,.9);backdrop-filter:blur(6px);z-index:5}
header h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
.pill{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:3px 10px}
.live{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dim)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--dim);display:inline-block}
.dot.on{background:var(--good);box-shadow:0 0 0 3px rgba(63,217,139,.15)}
.dot.off{background:var(--line)}
main{padding:20px;max-width:1240px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:8px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{font-size:12px;color:var(--dim);margin-bottom:4px}.card .v{font-size:22px;font-weight:600}
.card .v small{font-size:12px;color:var(--dim);font-weight:400}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:18px 0 10px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);background:var(--surface2);color:var(--dim);cursor:pointer}
.chip.sel{border-color:var(--accent);color:var(--ink)}
input.search{margin-left:auto;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 11px;font-size:13px;min-width:190px}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;white-space:nowrap}
th{color:var(--dim);font-weight:500;font-size:12px;background:var(--surface2)}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--surface2)}
td.wrap{white-space:normal}
.badge{font-size:11px;padding:2px 8px;border-radius:6px;font-weight:600;letter-spacing:.2px}
.b-created{background:#243049;color:#9db4ff}.b-fund{background:#2a2740;color:#c3b4ff}
.b-mature{background:#3a3320;color:var(--warn)}.b-claim{background:#123227;color:var(--good)}
.b-complete{background:#0f3325;color:var(--good)}.b-refund{background:#3a2222;color:var(--bad)}
.dots{display:inline-flex;gap:4px}
.mut{color:var(--dim)}
.flash{animation:fl 1.2s ease}@keyframes fl{from{background:rgba(107,147,255,.22)}to{background:transparent}}
#log{margin-top:20px}.logline{font-size:12px;color:var(--dim);padding:4px 2px;border-bottom:1px solid var(--line)}
.logline b{color:var(--ink);font-weight:600}
dialog{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:14px;max-width:760px;width:92%;padding:0}
dialog::backdrop{background:rgba(0,0,0,.6)}
.dhead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line)}
.dhead .x{margin-left:auto;cursor:pointer;color:var(--dim);font-size:20px;line-height:1;background:none;border:none}
pre{margin:0;padding:16px 18px;overflow:auto;max-height:64vh;font-size:12px;color:#cdd6f4}
.empty{padding:30px;text-align:center;color:var(--dim)}
.gate{max-width:360px;margin:12vh auto;text-align:center}
.gate input{width:100%;margin:12px 0;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:10px}
.gate button{background:var(--accent);border:none;color:#0b0e14;font-weight:600;border-radius:8px;padding:9px 18px;cursor:pointer}
a{color:var(--accent)}
</style></head><body>
<header>
  <h1>qbit-swap <span class="mut">· admin</span></h1>
  <span class="pill" id="net">—</span>
  <span class="pill" id="btcp">BTC —</span>
  <span class="pill" id="qbtp">QBT —</span>
  <span class="live"><span class="dot" id="livedot"></span><span id="livetxt">connecting…</span></span>
</header>
<main id="app"><div class="empty">loading…</div></main>

<dialog id="dlg"><div class="dhead"><strong id="dtitle" class="mono"></strong><button class="x" onclick="dlg.close()">×</button></div><pre id="dbody"></pre></dialog>

<script>
const $=(s,r=document)=>r.querySelector(s);
let TOKEN=new URLSearchParams(location.search).get("token")||sessionStorage.getItem("qadm")||"";
const H=()=>({"x-admin-token":TOKEN});
const api=(p)=>fetch(p,{headers:H()}).then(r=>{if(r.status===401)throw new Error("401");return r.json()});
const short=(id)=>id?id.slice(0,8):"—";
const sat=(n)=>n==null?"—":(n>=1e5?(n/1e8).toFixed(n%1e8?4:0)+" ":"")+(n>=1e5?"":n+" sat");
let LBL={btc:"BTC",qbt:"QBT"};   // pair labels from /api/overview (BTC-SHA256/BTC-Blake2b on a fork pair)
const btc=(n)=>n==null?"—":(n/1e8).toFixed(8).replace(/0+$/,"").replace(/\\.$/,"")+" "+LBL.btc;
const qbt=(n)=>n==null?"—":(n/1e8).toFixed(8).replace(/0+$/,"").replace(/\\.$/,"")+" "+LBL.qbt;
const ago=(t)=>{if(!t)return"—";const s=(Date.now()-t)/1e3;if(s<60)return Math.floor(s)+"s";if(s<3600)return Math.floor(s/60)+"m";if(s<86400)return Math.floor(s/3600)+"h";return Math.floor(s/86400)+"d"};
const BADGE={CREATED:"b-created",READY:"b-created",FROM_FUNDED:"b-fund",TO_FUNDED:"b-fund",MATURING:"b-mature",CLAIMABLE:"b-claim",CLAIMED:"b-claim",COMPLETE:"b-complete",REFUNDED:"b-refund",ABORTED:"b-refund"};
const badge=(st)=>'<span class="badge '+(BADGE[st]||"b-created")+'">'+st+'</span>';
const dd=(on)=>'<span class="dot '+(on?"on":"off")+'"></span>';
let SWAPS=new Map(), FILTER=null, Q="";
// Sortable swaps table: [header label, sort key]; getters return a comparable value per column.
const SWAP_COLS=[["id","id"],["dir","dir"],["state","state"],["BTC","btc"],["QBT","qbt"],["funded","funded"],["parties","parties"],["armed","armed"],["age","created"],["settled","settled"]];
const SORT_GET={id:s=>s.id||"",dir:s=>s.direction||"",state:s=>s.state||"",btc:s=>s.btcSats||0,qbt:s=>s.qbtSats||0,
  funded:s=>(s.funded&&s.funded.btc?1:0)+(s.funded&&s.funded.qbit?1:0),
  parties:s=>(s.online&&s.online.alice?1:0)+(s.online&&s.online.bob?1:0),
  armed:s=>(s.armed&&s.armed.alice?1:0)+(s.armed&&s.armed.bob?1:0),
  created:s=>s.createdAt||0, settled:s=>s.settledAt||0};
let SORT={key:"created",dir:-1};   // default: newest first
const swapHeadHtml=()=>'<tr>'+SWAP_COLS.map(([label,key])=>'<th onclick="setSort(\\''+key+'\\')" style="cursor:pointer;user-select:none" title="click to sort">'+label+(SORT.key===key?' '+(SORT.dir<0?'▼':'▲'):'')+'</th>').join("")+'</tr>';
window.setSort=(k)=>{if(SORT.key===k)SORT.dir=-SORT.dir;else SORT={key:k,dir:(k==="id"||k==="dir"||k==="state")?1:-1};const h=$("#swhead");if(h)h.innerHTML=swapHeadHtml();renderRows();};

function gate(){
  $("#app").innerHTML='<div class="gate"><h2>admin token</h2><input id="tk" type="password" placeholder="paste ADMIN_TOKEN"/><br><button onclick="sv()">enter</button></div>';
  window.sv=()=>{TOKEN=$("#tk").value.trim();sessionStorage.setItem("qadm",TOKEN);boot()};
}
async function boot(){
  try{ await refreshOverview(); await refreshSwaps(); await refreshWatchtower(); connectStream(); }
  catch(e){ if(String(e.message).includes("401")) return gate(); $("#app").innerHTML='<div class="empty">error: '+e.message+'</div>'; }
}
async function refreshOverview(){
  const o=await api("/api/overview");
  $("#net").textContent=o.network;
  const cp=(el,c,label)=>{const e=$(el);e.textContent=label+" "+(c.ok?("#"+c.height):"down")+" · "+c.backend;e.style.color=c.ok?"":"var(--bad)"};
  if(o.labels)LBL={btc:o.labels.btc||"BTC",qbt:o.labels.qbit||"QBT"};
  cp("#btcp",o.chains.btc,LBL.btc);cp("#qbtp",o.chains.qbit,LBL.qbt);
  const t=o.totals;
  const risk=t.atRisk||0;
  const cards=[
    ["at risk",risk,"need attention",risk>0?"var(--bad)":null],
    ["swaps",t.swaps],["active",t.active],["complete",t.complete],["refunded",t.refunded],
    ["parties online",t.onlineSwaps,"swaps"],
    ["watchtower acts",t.wtActions||0,"coordinator stepped in"],
    ["completed volume",btc(o.volume.btcSats)+" · "+qbt(o.volume.qbtSats),""],
    ["offers",o.offers.total,(o.offers.open||0)+" open"],
  ].map(([k,v,s,color])=>'<div class="card"'+(color?' style="border-color:'+color+'"':'')+'><div class="k">'+k+'</div><div class="v"'+(color?' style="color:'+color+'"':'')+'>'+v+(s?' <small>'+s+'</small>':'')+'</div></div>').join("");
  window._counts=o.counts; window._atRisk=risk;
  renderShell(cards);
}
function renderShell(cards){
  if($("#cards")){$("#cards").innerHTML=cards;renderChips();return;}
  $("#app").innerHTML='<div class="cards" id="cards">'+cards+'</div>'
    +'<div class="row"><div class="chips" id="chips"></div><input class="search" id="q" placeholder="filter by id / state"/></div>'
    +'<table><thead id="swhead"></thead><tbody id="rows"></tbody></table>'
    +'<div class="row" style="margin-top:24px"><b>watchtower actions</b> <span class="mut" id="wtcount"></span><span class="mut" style="font-weight:400"> — txs the coordinator broadcast for an offline party</span></div>'
    +'<table><thead><tr><th>when</th><th>swap</th><th>party</th><th>action</th><th>leg</th><th>feerate</th><th>txid</th></tr></thead><tbody id="wtrows"></tbody></table>'
    +'<div id="log"><div class="row" style="margin-top:24px"><b>activity</b></div><div id="loglines"></div></div>';
  $("#swhead").innerHTML=swapHeadHtml();
  $("#q").oninput=(e)=>{Q=e.target.value.trim().toLowerCase();renderRows()};
  renderChips();
}
function renderChips(){
  const c=window._counts||{};const states=Object.keys(c);
  const risk=(window._atRisk||0)>0?'<span class="chip'+(FILTER==="@risk"?" sel":"")+'" style="border-color:var(--bad);color:var(--bad)" onclick="setF(\\'@risk\\')">⚠ at risk '+window._atRisk+'</span>':'';
  $("#chips").innerHTML='<span class="chip '+(FILTER?"":"sel")+'" onclick="setF(null)">all</span>'+risk+
    states.map(s=>'<span class="chip '+(FILTER===s?"sel":"")+'" onclick="setF(\\''+s+'\\')">'+s+' '+c[s]+'</span>').join("");
}
window.setF=(s)=>{FILTER=s;renderChips();renderRows()};
async function refreshSwaps(){
  const list=await api("/api/swaps");
  SWAPS=new Map(list.map(s=>[s.id,s]));renderRows();
}
function rowHtml(s){
  const dir=s.direction==="btc2qbt"?LBL.btc+"→"+LBL.qbt:LBL.qbt+"→"+LBL.btc;
  const funded='<span class="dots" title="'+LBL.btc+' / '+LBL.qbt+' funding">'+dd(s.funded.btc)+dd(s.funded.qbit)+'</span>';
  const parties='<span class="dots" title="alice / bob online">'+dd(s.online.alice)+dd(s.online.bob)+'</span>';
  const armed='<span class="dots" title="watchtower armed: alice / bob">'+dd(s.armed.alice)+dd(s.armed.bob)+'</span>';
  const risky=s.risk&&s.risk.length;
  const warn=risky?' <span title="'+s.risk.join(" · ")+'" style="color:var(--bad)">⚠</span>'
    :(s.short?' <span title="short-funded" style="color:var(--bad)">⚠</span>':'');
  return '<tr data-id="'+s.id+'"'+(risky?' style="box-shadow:inset 3px 0 0 var(--bad)"':'')+' onclick="openSwap(\\''+s.id+'\\')"><td class="mono">'+short(s.id)+
    warn+'</td><td class="mut">'+dir+'</td><td>'+badge(s.state)+
    '</td><td>'+btc(s.btcSats)+'</td><td>'+qbt(s.qbtSats)+'</td><td>'+funded+'</td><td>'+parties+'</td><td>'+armed+
    '</td><td class="mut">'+ago(s.createdAt)+'</td><td class="mut">'+(s.settledAt?ago(s.settledAt)+" ago":"—")+'</td></tr>';
}
function renderRows(){
  let list=[...SWAPS.values()];
  if(FILTER==="@risk")list=list.filter(s=>s.risk&&s.risk.length);
  else if(FILTER)list=list.filter(s=>s.state===FILTER);
  if(Q)list=list.filter(s=>s.id.toLowerCase().includes(Q)||s.state.toLowerCase().includes(Q)||(s.direction||"").includes(Q));
  const g=SORT_GET[SORT.key]||SORT_GET.created;
  list.sort((a,b)=>{const x=g(a),y=g(b);return (x<y?-1:x>y?1:0)*SORT.dir;});
  const tb=$("#rows");if(!tb)return;
  tb.innerHTML=list.length?list.map(rowHtml).join(""):'<tr><td colspan="10" class="empty">no swaps</td></tr>';
}
window.openSwap=async(id)=>{
  $("#dtitle").textContent=id;$("#dbody").textContent="loading…";$("#dlg").showModal();
  try{$("#dbody").textContent=JSON.stringify(await api("/api/swaps/"+id),null,2);}catch(e){$("#dbody").textContent="error: "+e.message;}
};
function wtRowHtml(a){
  const leg=(a.leg||"?").toUpperCase();
  const act=a.kind==="claim"?'<span class="badge b-claim">claim</span>':'<span class="badge b-refund">refund</span>';
  const fee=a.kind==="claim"
    ?(a.feerate!=null?'<b>'+a.feerate+'</b> <span class="mut">sat/vB · tier '+a.tier+'</span>':'<span class="mut">tier '+a.tier+'</span>')
    :'<span class="mut">—</span>';
  return '<tr onclick="openSwap(\\''+a.swapId+'\\')"><td class="mut">'+(a.ts?ago(a.ts)+' ago':'—')+
    '</td><td class="mono">'+short(a.swapId)+'</td><td>'+a.role+'</td><td>'+act+'</td><td>'+leg+
    '</td><td>'+fee+'</td><td class="mono mut" title="'+(a.txid||'')+'">'+short(a.txid)+'…</td></tr>';
}
async function refreshWatchtower(){
  const acts=await api("/api/watchtower");const tb=$("#wtrows");if(!tb)return;
  $("#wtcount").textContent=acts.length?("· "+acts.length):"";
  tb.innerHTML=acts.length?acts.map(wtRowHtml).join(""):'<tr><td colspan="7" class="empty">the coordinator has not had to step in yet</td></tr>';
}
let logn=0;
function logLine(s){
  const box=$("#loglines");if(!box)return;
  const dir=s.direction==="btc2qbt"?LBL.btc+"→"+LBL.qbt:LBL.qbt+"→"+LBL.btc;
  const el=document.createElement("div");el.className="logline";
  el.innerHTML='<span class="mono">'+new Date().toLocaleTimeString()+'</span> · <b>'+short(s.id)+'</b> '+dir+' → '+badge(s.state);
  box.prepend(el);if(++logn>60)box.lastChild?.remove();
}
function connectStream(){
  const es=new EventSource("/stream?token="+encodeURIComponent(TOKEN));
  es.onopen=()=>{$("#livedot").className="dot on";$("#livetxt").textContent="live"};
  es.onerror=()=>{$("#livedot").className="dot off";$("#livetxt").textContent="reconnecting…"};
  es.onmessage=(e)=>{
    const s=JSON.parse(e.data);const prev=SWAPS.get(s.id);
    SWAPS.set(s.id,s);
    if(!prev||prev.state!==s.state)logLine(s);
    renderRows();
    const tr=$('tr[data-id="'+s.id+'"]');if(tr){tr.classList.remove("flash");void tr.offsetWidth;tr.classList.add("flash")}
    if(!prev||prev.state!==s.state)renderOverviewSoon(); // new swap or transition (incl. watchtower acting) -> refresh overview + wt panel
  };
}
let ovT;function renderOverviewSoon(){clearTimeout(ovT);ovT=setTimeout(()=>{refreshOverview().catch(()=>{});refreshWatchtower().catch(()=>{});},400);}
setInterval(()=>{refreshOverview().catch(()=>{});refreshWatchtower().catch(()=>{});},8000); // heights + counts + watchtower tick
if(!TOKEN)gate();else boot();
</script></body></html>`;
