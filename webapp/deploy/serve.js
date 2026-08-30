// PRODUCTION deployment: serve the built web app and the keyless coordinator behind ONE origin,
// with the coordinator pointed at real BTC + QBT nodes over the tailnet (rpc backend). No local
// chains, no faucet, no mining — unlike deploy/trial.js. The public HTTPS front door is provided
// externally (a Cloudflare Tunnel → this box's WEB_PORT); this process listens on loopback/LAN only
// and needs no inbound ports of its own.
//
// Required env (see infra/webapp/*.tf for the systemd EnvironmentFile that sets these):
//   PUBLIC_URL      https://app.example.com   — the public origin the tunnel maps to (same-origin /coord)
//   NETWORK         regtest | testnet | mainnet — selects the address HRPS the app enforces
//   BTC_BACKEND=rpc  BTC_RPC_URL=http://user:pass@<btc-host>:8332
//   QBIT_BACKEND=rpc QBIT_RPC_URL=http://user:pass@<qbit-host>:<port>
//   (optional) BTC_WATCH=wallet  QBIT_WATCH=scan  ORDERBOOK=1
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { startServer } from "../../coordinator/server.js";
import { startAdmin } from "../../coordinator/admin.js";
import { MIN_SATS } from "../../coordinator/swap.js";   // single source of truth for the min swap value (env-driven)
import { publicChains } from "../../coordinator/chains.js";   // per-leg chain identity (CHAIN2 preset) — injected so keys/signing/replay match the pair

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const WEB = Number(process.env.WEB_PORT || 8080), COORD = Number(process.env.COORD_PORT || 8787);
const BIND = process.env.WEB_BIND || "127.0.0.1"; // the tunnel connects on loopback; no public bind needed
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg" };

// Address HRPS the app enforces per network (see client/addr.js). A wrong-network address is
// rejected client-side before any funds move.
const HRPS = { regtest: { btc: "bcrt", qbit: "qbrt" }, testnet: { btc: "tb", qbit: "tqb" }, mainnet: { btc: "bc", qbit: "qb" } };
const NETWORK = process.env.NETWORK || "regtest";
const hrps = HRPS[NETWORK] || HRPS.regtest;

// Same-origin config injected into index.html: the app talks to /coord on its own origin.
const cfg = [
  `window.QBIT_COORDINATOR=${JSON.stringify(`${PUBLIC_URL}/coord`)};`,
  `window.QBIT_HRPS=${JSON.stringify(hrps)};`,
  `window.QBIT_MIN_SATS=${JSON.stringify({ btc: MIN_SATS.btc, qbit: MIN_SATS.qbit })};`,   // min swap value — the app validates against the SAME config the coordinator enforces
  `window.QBIT_CHAINS=${JSON.stringify(publicChains())};`,   // per-leg identity: labels, script family, trust/replay flags (CHAIN2 pair)
  process.env.ORDERBOOK ? "window.QBIT_ORDERBOOK=true;" : "",
  process.env.RECENT_TRADES ? "window.QBIT_RECENT_TRADES=true;" : "",
  process.env.RFQ ? "window.QBIT_RFQ=true;" : "",   // instant-swap widget (needs RFQ_MAKER_KEYS on the coordinator to actually serve liquidity)
  process.env.FEE_BPS ? `window.QBIT_FEE_BPS=${Number(process.env.FEE_BPS) || 0};` : "",   // pre-create fee estimate; authoritative amount comes from the swap view
  // Browser-reachable QBT broadcast endpoints for the coordinator-down fallback, per network hrp. JSON
  // like {"qb":["https://.../api/tx"]}. Esplora-style: raw tx hex POST body, txid response.
  process.env.QBIT_BROADCAST_URLS ? `window.QBIT_BROADCAST_URLS=${process.env.QBIT_BROADCAST_URLS};` : "",
].join("");
const CONFIG = `<script>${cfg}</script>`;

// Swap the English link-preview strings for 中文 (ordered longest-first so shared prefixes don't clash),
// point the preview image at the zh card, and tag the locale. Applied only to ?lang=zh requests.
function localizeOgZh(html) {
  const subs = [
    ["Non-custodial, peer-to-peer atomic swaps between Bitcoin and Qbit. Send from any wallet; the coordinator never holds your funds.",
     "比特币与 Qbit 之间的非托管、点对点原子兑换。从任意钱包发送；协调器绝不持有您的资金。"],
    ["Non-custodial, peer-to-peer atomic swaps between Bitcoin and Qbit. Trade directly with a counterparty on-chain — send from any wallet.",
     "比特币与 Qbit 之间的非托管、点对点原子兑换。直接与对手方在链上交易——从任意钱包发送。"],
    ["Non-custodial, peer-to-peer atomic swaps between Bitcoin and Qbit.",
     "比特币与 Qbit 之间的非托管、点对点原子兑换。"],
    ["Qbit Swap — Onchain atomic swaps between Bitcoin and Qbit", "Qbit Swap — 比特币与 Qbit 之间的链上原子兑换"],
    ["/og.png", "/og-zh.png"],
  ];
  for (const [en, zh] of subs) html = html.split(en).join(zh);
  return html.replace('<meta property="og:type" content="website" />', '<meta property="og:type" content="website" />\n<meta property="og:locale" content="zh_CN" />');
}

function proxy(req, res, port, path) {
  const up = http.request({ host: "127.0.0.1", port, method: req.method, path, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("proxy error"); });
  req.pipe(up);
}
function unified() {
  return new Promise((resolve) => {
    http.createServer(async (req, res) => {
      const path = req.url;
      if (path === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
      if (path.startsWith("/coord/")) return proxy(req, res, COORD, path.slice(6)); // strip "/coord"
      try {
        const rel = decodeURIComponent(path.split("?")[0]);
        // SPA fallback: "/" and any extensionless client route (/api, /info, /activity, …) serve index.html;
        // real assets (.js/.css/.wasm/…) are served by name.
        const file = join(ROOT, rel === "/" || !extname(rel) ? "/index.html" : rel);
        if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
        let body = await readFile(file);
        if (file.endsWith("index.html")) {
          let html = body.toString().replace("</head>", `${CONFIG}\n</head>`);
          // Localize the link-preview (OG/Twitter) tags for ?lang=zh. Scrapers fetch the exact shared
          // URL, and zh users' shared links carry ?lang=zh — so the zh and en previews never collide.
          if (new URLSearchParams(path.split("?")[1] || "").get("lang") === "zh") html = localizeOgZh(html);
          body = Buffer.from(html);
        }
        // No hashed asset names yet, so tell the browser to revalidate — otherwise a deploy's new
        // dist/app.js stays invisible behind the cached copy until a hard refresh.
        res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-cache" }); res.end(body);
      } catch { res.writeHead(404); res.end("not found"); }
    }).listen(WEB, BIND, () => resolve());
  });
}

async function main() {
  await startServer(COORD);
  await unified();
  // Admin dashboard — tailnet-only (NOT routed through the public tunnel). Off if ADMIN=off.
  if (process.env.ADMIN !== "off") await startAdmin(Number(process.env.ADMIN_PORT || 8790));
  console.log(`\n  qbit-swap is live`);
  console.log(`  ┌──────────────────────────────────────────────────────────────`);
  console.log(`  │  Public URL:  ${PUBLIC_URL}   (front this ${BIND}:${WEB} with a tunnel)`);
  console.log(`  │  same-origin: ${PUBLIC_URL}/coord   ·   network: ${NETWORK}  hrps=${JSON.stringify(hrps)}`);
  console.log(`  │  BTC=${process.env.BTC_BACKEND || "dev"}  QBIT=${process.env.QBIT_BACKEND || "dev"}  (chains over the tailnet)`);
  console.log(`  └──────────────────────────────────────────────────────────────\n`);
}
main().catch((e) => { console.error("serve failed:", e.message); process.exit(1); });
