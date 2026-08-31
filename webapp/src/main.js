// qbit-swap web app — a one-decision-per-screen wizard. Wallet-agnostic: the browser makes ephemeral
// per-swap keys, signs its own claim/refund, and talks to a keyless coordinator. Either side can
// initiate (the first screen picks the direction). Backup is a plaintext file (no password for now).
// UI strings are translated via i18n (English / 简体中文) with a header switcher.
import { SwapClient, dynFee } from "./swapflow.js";
import { exportBackup, importBackup, Vault } from "./keystore.js";
import { t, getLang, setLang, LANGS, tickers } from "./i18n.js";
import { addressToScriptPubKey, addressCoin } from "@qbit-swap/client";

// Expected network per coin (bech32 hrp). Regtest by default; a mainnet deploy injects
// window.QBIT_HRPS = { btc: "bc", qbit: "qb" } (testnet: "tb" / a qbit testnet hrp).
const HRPS = globalThis.QBIT_HRPS || { btc: "bcrt", qbit: "qbrt" };
const KNOWN_HRPS = ["bcrt", "bc", "tb", "sb", "qbrt", "qbt", "tqb", "qb"];
// All SwapClients get the BTC network (hrp) so they can fall back to a direct public broadcast of the
// BTC leg if the coordinator is unreachable while the tab is open (see swapflow.js #send).
const mkClient = (opts) => new SwapClient({ btcHrp: HRPS.btc, qbitHrp: HRPS.qbit, ...opts });
// Is `addr` on the specific network `expectedHrp`? bech32 by hrp; btc legacy base58 by mainnet-vs-test.
function addressOnNetwork(addr, expectedHrp) {
  const a = addr.trim(), l = a.toLowerCase(), sep = l.lastIndexOf("1");
  if (sep > 0) { const hrp = l.slice(0, sep); if (KNOWN_HRPS.includes(hrp)) return hrp === expectedHrp; }
  const mainnet = expectedHrp === "bc";                       // btc legacy: 1/3 = mainnet, m/n/2 = test/regtest
  if (/^[13]/.test(a)) return mainnet;
  if (/^[mn2]/.test(a)) return !mainnet;
  return false;
}
// Validate a receiving/refund address: non-empty, decodable, the right CHAIN (a BTC address where a QBT
// one is needed would send funds to an unspendable cross-chain output), and the right NETWORK (a testnet
// address on a mainnet swap would be unspendable by the intended wallet).
function validAddr(value, coin) {
  const a = (value || "").trim();
  if (!a) throw new Error(t("errEnterAddr", { coin }));
  const want = coin === "BTC" ? "btc" : "qbit";
  // Fork pairs share one address format (both legs hrp "bc") — the address alone can't say which
  // leg it belongs to, so the cross-chain check only applies when the hrps actually differ.
  const sameNet = HRPS.btc === HRPS.qbit;
  let ok = false;
  try { addressToScriptPubKey(a); ok = (sameNet || addressCoin(a) === want) && addressOnNetwork(a, HRPS[want]); } catch { ok = false; }
  if (!ok) throw new Error(t("errBadAddr", { coin }));
  return a;
}

const DEFAULT_COORD = globalThis.QBIT_COORDINATOR || "http://127.0.0.1:8787";
// Per-chain feerates for the setup-screen fee estimate (cached once per page load; the swap view carries
// its own live feerates thereafter). Best-effort — the note falls back to "…" if this can't be reached.
let _feerates = null;
const fetchFeerates = async () => (_feerates ||= await (await fetch(`${DEFAULT_COORD}/feerates`)).json());
const FAUCET = globalThis.QBIT_TRIAL_FAUCET || null;
const ORDERBOOK = globalThis.QBIT_ORDERBOOK === true;   // feature flag, default OFF — peer-to-peer only
const RECENT_TRADES = globalThis.QBIT_RECENT_TRADES === true;   // feature flag, default OFF — public recent-trades tab
const RFQ = globalThis.QBIT_RFQ === true;   // feature flag, default OFF — instant-swap widget backed by market-maker bot liquidity (/rfq)
const FEE_BPS = Number(globalThis.QBIT_FEE_BPS || 0);   // >0 when the coordinator charges a platform fee (basis points)
const MIN_SATS = globalThis.QBIT_MIN_SATS || null;   // min swap value per leg, injected from the coordinator's own config; null (not injected) → skip the up-front check and let the coordinator be the authority
const appEl = document.getElementById("app");
const vault = new Vault();
let rerender = () => init();     // re-invoked on language change to redraw the current screen
let liveGuard = { risky: false };   // true when funds are committed but the safety net isn't armed yet
// Warn before leaving if funds are locked but the watchtower isn't armed yet (nothing to finish for you).
window.addEventListener("beforeunload", (e) => { if (liveGuard.risky) { e.preventDefault(); e.returnValue = t("leaveWarn"); return t("leaveWarn"); } });

// ── coin / direction helpers ──────────────────────────────────────────────────
// Every swap is btc2qbt under the hood (initiator=alice=QBT buyer, sends BTC). A party's personal
// orientation is just a view of their role: alice sends BTC / sells nothing (buys QBT); bob sends QBT.
const DIR = { btc2qbt: { from: "BTC", to: "QBT" }, qbt2btc: { from: "QBT", to: "BTC" } };
// Display label for an internal coin symbol — configured pair tickers (e.g. BTC-SHA256/BTC-Blake2b
// under CHAIN2=bip110). Strings built via t() are relabeled inside i18n; use L() for raw templates.
const L = (coin) => (coin === "BTC" ? tickers().btc : coin === "QBT" ? tickers().qbt : coin);
// Brand pack (window.QBIT_BRAND, injected by serve.js from CHAIN2): the bip110/shaswap deployment gets
// its own community links, project-about copy, and hero emblem; default deployments keep Qbit's.
const BRAND = globalThis.QBIT_BRAND || null;
const DISCORD_URL = BRAND === "bip110" ? "https://discord.gg/3Ccegp9YrU" : DISCORD_URL;
const PROJECT_LINK = BRAND === "bip110" ? { href: "https://btc-blake2b.org/", text: "btc-blake2b.org" } : { href: "https://qbit.org/", text: "qbit.org" };
const bk = (key) => (BRAND === "bip110" ? { aboutQbitTitle: "aboutForkTitle", aboutQbitBody: "aboutForkBody", faqWhatQ: "faqWhatForkQ", faqWhatA: "faqWhatForkA" }[key] || key : key);
const dirForRole = (role) => (role === "bob" ? "qbt2btc" : "btc2qbt");
const coinLeg = (coin) => (coin === "BTC" ? "btc" : "qbit");
const sats = (n) => (n / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });   // DISPLAY only (grouped) — never write this into an <input>: its thousands comma breaks parseFloat on re-read
const amtStr = (n) => (n / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");         // plain, grouping-free — safe to round-trip through an input field
const fmtWhen = (ts) => { try { return new Date(ts).toLocaleString(getLang() === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
// Swaps whose receive/refund addresses were TYPED in THIS browser (the create/join/take flow) — so it
// already knows they're its own and the address-verification gate is skipped. A different browser/device
// that only RESUMED the swap (permalink or imported backup) has no mark, so it still gets the gate. Stored
// in localStorage (per-browser) and NOT part of the exportable backup, so importing elsewhere re-gates.
const ENTERED_KEY = "qbit-entered-addrs";
const enteredAddrsHere = (id) => { try { return JSON.parse(localStorage.getItem(ENTERED_KEY) || "[]").includes(id); } catch { return false; } };
const markEnteredAddrs = (id) => { try { const a = JSON.parse(localStorage.getItem(ENTERED_KEY) || "[]"); if (id && !a.includes(id)) localStorage.setItem(ENTERED_KEY, JSON.stringify([...a, id].slice(-200))); } catch {} };
const toSats = (v) => Math.round(parseFloat(String(v).replace(/,/g, "")) * 1e8);          // tolerate a stray grouping comma (en/zh use it as a thousands separator) so "4,441.4" isn't read as 4
const DUST_UI = 546;
// ── coordinator fee (optional) ────────────────────────────────────────────────
// The platform fee for the current swap, in BTC sats (0 when off). Authoritative from the live view;
// during the pre-create screens it's estimated from the configured rate.
function feeSats(v) {
  const fee = v?.fee ?? flow.client?.view?.fee ?? flow.fee;
  if (fee) return fee.sats || 0;
  return FEE_BPS ? Math.round((flow.btcSats || 0) * FEE_BPS / 10000) : 0;
}
const feeBps = (v) => (v?.fee ?? flow.client?.view?.fee ?? flow.fee)?.bps ?? FEE_BPS;
const feePct = (v) => (feeBps(v) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
// What the current party must SEND — grossed up by the fee only for the BTC sender (the buyer bears it).
function sendSats(v) { const { send } = roleCoins(); return coinSats(send) + (send === "BTC" ? feeSats(v) : 0); }

// What the receiver nets after the network fee for CLAIMING the coin they receive. The claim is sized
// at mempool's High-priority feerate (same dynFee the client signs with), so this matches reality. When
// a coordinator fee is on, the BTC receiver (seller) nets the full amount — the fee output absorbs the
// claim's network fee.
function netReceive(recv, feerates, feeOn = false) {
  const gross = coinSats(recv);
  if (recv === "BTC" && feeOn) return { gross, fee: 0, net: gross };
  const fee = Math.min(dynFee(coinLeg(recv), "claim", feerates), Math.max(0, gross - DUST_UI));
  return { gross, fee, net: gross - fee };
}
const feeStr = (coin, fee) => (coin === "BTC" ? `${fee.toLocaleString()} sat` : `${sats(fee)} ${tickers().qbt}`);
// A one-line breakdown shown to the BTC sender (buyer) when a platform fee applies: swap + fee = total.
function feeBreakdown(v) {
  const { send } = roleCoins(), fee = v?.fee ?? flow.client?.view?.fee ?? flow.fee, f = feeSats(v);
  if (!(send === "BTC" && f > 0)) return null;
  const plat = fee?.platform ?? f, net = fee?.netFee ?? 0;   // fee = platform (bps) + prepaid network fee
  const key = net <= 0 ? "feeBreakdownNoNet" : plat <= 0 ? "feeBreakdownNoPlat" : "feeBreakdown";   // small swaps below the platform floor → reserve only
  return h("div", { class: "note", style: "margin-top:6px;font-size:12.5px" }, t(key, { swap: sats(coinSats("BTC")), plat: sats(plat), pct: feePct(v), net: sats(net) }));
}
const shorten = (s, n = 10) => (s && s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const trimZeros = (s) => s.replace(/0+$/, "").replace(/\.$/, "");
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const parseHash = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));

// ── tiny DOM helper ───────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid?.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const render = (node) => { while (appEl.firstChild) appEl.removeChild(appEl.firstChild); appEl.append(node); };

// ── browser history: the native Back button mirrors the on-page "Back" ─────────
// This is a single-page app, but people reach for the browser Back button anyway. Every screen
// registers its Back action via markScreen(); the on-page Back link just calls history.back(), so
// both routes pop the same stack. Forward navigation pushes a state; going back runs the current
// screen's Back handler, which re-renders the previous screen (suppressed so it doesn't re-push).
let curBack = null, histSeq = 0, histPos = 0, histSuppress = false;
// Optional `url` gives a screen a real permalink (e.g. /api); omitted → the URL is left as-is.
function markScreen(back, url) {
  curBack = typeof back === "function" ? back : null;
  if (histSuppress) return;              // rendering because of a back-nav or a lang re-render — don't push
  const first = histSeq === 0;           // first screen: replace, so Back off it leaves the app
  if (first) histSeq = histPos = 1; else histPos = ++histSeq;
  const st = { pos: histPos };
  if (url !== undefined) (first ? history.replaceState(st, "", url) : history.pushState(st, "", url));
  else (first ? history.replaceState(st, "") : history.pushState(st, ""));
}
// Header pages with their own permalink: /info · /api · /activity (or the #info/#api/#activity forms).
const NAV_PAGES = { info: () => stepInfo(), api: () => stepApi(), ...(RECENT_TRADES ? { activity: () => stepTrades() } : {}) };
function pageFromLocation() {
  const path = location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (NAV_PAGES[path]) return path;
  const hash = decodeURIComponent(location.hash.replace(/^#/, "")).toLowerCase();
  return NAV_PAGES[hash] ? hash : null;
}
window.addEventListener("popstate", (e) => {
  const pg = pageFromLocation();           // forward/back landed on a nav-page URL → render it
  if (pg) { histPos = e.state?.pos ?? histPos; histSuppress = true; try { NAV_PAGES[pg](); } finally { histSuppress = false; } return; }
  const target = e.state?.pos ?? 0;
  if (target < histPos && curBack) {       // going back one or more screens
    histPos = target;
    histSuppress = true;
    try { curBack(); } finally { histSuppress = false; }
  } else {
    histPos = target;                      // at the root, or a forward hop we can't reconstruct — leave the view as-is
  }
});

function screen({ title, subtitle, body = [], cta, onCta, secondary, back }) {
  markScreen(back);
  const btn = cta ? h("button", { class: "primary", style: "width:100%;margin-top:18px", onclick: async (e) => { const b = e.target; b.disabled = true; try { await onCta(); } catch (err) { b.disabled = false; alert(err.message); } } }, cta) : null;
  const backLink = back ? h("a", { href: "#", style: "color:var(--mut)", onclick: (e) => { e.preventDefault(); history.back(); } }, t("back")) : null;
  const footer = (backLink || secondary) ? h("div", { style: "margin-top:14px;display:flex;justify-content:space-between;align-items:center;gap:12px" }, backLink || h("span"), secondary || h("span")) : null;
  return h("div", { class: "card" }, h("h2", {}, title), subtitle ? h("p", { class: "note", style: "margin-top:-4px" }, subtitle) : null, ...body, btn, footer);
}
const bigChoice = (glyph, label, sub, onClick) => h("button", { class: "choice", onclick: onClick },
  h("span", { class: "glyph" }, glyph),
  h("span", { class: "ct" }, h("b", {}, label), h("span", {}, sub)),
  h("span", { class: "arr", "aria-hidden": "true" }, "→"));
const field = (placeholder, value = "") => h("input", { placeholder, value });
// Copy button that flashes a "copied" label, then reverts after a moment.
function copyButton(labelKey, copiedKey, getText) {
  const btn = h("button", { class: "copy", onclick: () => {
    try { navigator.clipboard?.writeText(getText()); } catch {}
    btn.textContent = t(copiedKey);
    clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = t(labelKey); }, 2500);
  } }, t(labelKey));
  return btn;
}

// trial helper: pre-fill throwaway receive/refund addresses (funding is manual — the user sends).
async function faucetNewAddress(leg) { const r = await fetch(`${FAUCET}/newaddress?leg=${leg}`); return (await r.json()).address; }
async function prefill(input, coin) { if (!FAUCET) return; try { input.value = await faucetNewAddress(coinLeg(coin)); } catch {} }

// ── flow state ────────────────────────────────────────────────────────────────
const flow = { mode: null, role: null, direction: null, coordinator: DEFAULT_COORD, btcSats: 0, qbtSats: 0, receiveAddr: "", refundAddr: "", client: null, inviteLink: null, fee: null, verified: false };
const coinSats = (coin) => (coin === "BTC" ? flow.btcSats : flow.qbtSats);
// What THIS party sends/receives, from their role: alice (QBT buyer) sends BTC & receives QBT; bob
// (QBT seller) sends QBT & receives BTC. Independent of who created the swap.
const roleCoins = () => (flow.role === "bob" ? { send: "QBT", recv: "BTC" } : { send: "BTC", recv: "QBT" });
// coordinator REST helpers (the order book lives outside the per-party SwapClient)
const coordUrl = (p) => `${DEFAULT_COORD}${p}`;
const coordGet = async (p) => { const r = await fetch(coordUrl(p)); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };
const coordPost = async (p, body) => { const r = await fetch(coordUrl(p), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };

// ── entry ─────────────────────────────────────────────────────────────────────
async function init() {
  rerender = () => init();
  const q = parseHash();
  if (q.id) {
    // We already hold this swap's keys (either party) → resume it, so a page refresh on the live status
    // page returns to the swap instead of the landing. This covers both the creator's #id permalink and
    // a re-opened invite link. Don't re-join with fresh keys — the coordinator rejects that as taken.
    const known = (await vault.list().catch(() => [])).includes(q.id);
    if (known) { try { return resumeSwap(await vault.load(q.id)); } catch { /* fall through to fresh join */ } }
    // Not ours yet: a full invite link (coord+id+token) means we're the invited participant → join fresh.
    if (q.coord && q.token) return startParticipant({ coordinator: decodeURIComponent(q.coord), id: q.id, token: q.token });
  }
  // Deep-link / reload on a header page (/api, /info, /activity, or their #hash forms) → open that page.
  // rerender is set to a home-reset first, so its Back goes to the hero (not back into this same page).
  const pg = pageFromLocation();
  if (pg) { rerender = homeFromNav; return NAV_PAGES[pg](); }
  // The root URL always opens on the hero landing — even for a returning user. Any in-progress swaps
  // are still one click away: "Start a swap" → the chooser lists them, and the backup-recover card is there too.
  stepWelcome();
}
function homeFromNav() { try { history.replaceState({ pos: histPos }, "", "/" + location.search); } catch {} stepWelcome(); }

// Qbit orbit emblem — the brand mark with its dot + ring as a spinning "orbit" group around the core.
// Centered spinning orbit emblem — the loading indicator while a swap view / backup loads.
const spinnerEl = (label) => h("div", { style: "display:flex;flex-direction:column;align-items:center;gap:14px;padding:44px 0 36px" },
  h("div", { class: "hero-emblem boot", style: "margin:0;width:60px", html: EMBLEM_SVG }),
  label ? h("span", { class: "muted", style: "font-size:14px" }, label) : null);
const EMBLEM_BIP110 = `<svg viewBox="0 0 128 84" aria-hidden="true"><circle cx="44" cy="42" r="34" fill="#f7931a"/><text x="44" y="55" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="40" fill="#0b0a08">\u20BF</text><g class="orbit" style="transform-origin:86px 42px"><circle cx="86" cy="42" r="31" fill="#0b0a08" stroke="#f7931a" stroke-width="4"/><circle cx="86" cy="42" r="23" fill="none" stroke="#f7931a" stroke-width="3.4" stroke-dasharray="8.4 5.9"/></g><text x="86" y="54" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="34" fill="#f7931a">\u20BF</text></svg>`;
const EMBLEM_QBIT = `<svg viewBox="0 0 320 320" aria-hidden="true"><path class="core" d="m159.745 75.5137c46.2 0 83.652 37.4503 83.652 83.6483 0 46.197-37.452 83.648-83.652 83.648-46.199 0-83.6516-37.451-83.6516-83.648 0-46.198 37.4526-83.6483 83.6516-83.6483z"/><g class="orbit"><path d="m264.882 234.338c16.044 0 29.049 13.005 29.049 29.048 0 16.042-13.005 29.048-29.049 29.048-16.043 0-29.049-13.006-29.049-29.048 0-16.043 13.006-29.048 29.049-29.048z"/><path d="m46.1611 46.159c62.0959-62.0934 163.4069-61.4602 226.2849 1.4142 41.915 41.9136 56.167 100.9048 42.618 153.9748l-.026-.007c-1.478 5.001-6.104 8.652-11.584 8.652-6.672-.001-12.081-5.409-12.081-12.081 0-1.328.217-2.605.613-3.8 11.713-45.226-.14-95.2914-35.565-130.715-53.246-53.2434-139.575-53.2434-192.821 0-53.2456 53.243-53.2452 139.568.0007 192.812 35.4457 35.444 85.5513 47.29 130.7993 35.543 1.17-.377 2.416-.582 3.711-.582 6.672 0 12.081 5.408 12.081 12.08 0 5.477-3.645 10.099-8.642 11.58l.006.02c-53.071 13.548-112.0653-.704-153.9806-42.617-62.8774-62.874-63.5106-164.181-1.4143-226.274z"/></g></svg>`;
const EMBLEM_SVG = BRAND === "bip110" ? EMBLEM_BIP110 : EMBLEM_QBIT;
// Direction-chooser icons. On the fork pair a bare "₿"/"Q" is wrong for both slots — use the
// same mini coins as the emblem (orange = SHA256, dark knot-ring = Blake2b) so they're distinguishable.
const coinGlyph = (leg) => {
  if (BRAND !== "bip110") return leg === "btc" ? "₿" : "Q";
  return h("span", { style: "display:inline-flex", html: leg === "btc"
    ? `<svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#f7931a"/><text x="20" y="27" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="20" fill="#0b0a08">₿</text></svg>`
    : `<svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true"><circle cx="20" cy="20" r="16" fill="#0b0a08" stroke="#f7931a" stroke-width="2.5"/><circle cx="20" cy="20" r="12" fill="none" stroke="#f7931a" stroke-width="2" stroke-dasharray="4.4 3.1"/><text x="20" y="26" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="17" fill="#f7931a">₿</text></svg>` });
};

// ── instant swap widget (RFQ maker-bot liquidity; flag QBIT_RFQ) ──────────────
// A Uniswap-style two-panel card on the landing hero: pick a direction, type an amount on either side,
// and the best live market-maker price fills the other side. One click routes into the normal
// non-custodial swap flow with the winning maker as the counterparty — same HTLCs, same safety rails.
// Liquidity is whatever bots are actively pinging /rfq right now; a silent bot's quotes drop away, so
// the widget can never quote a price nobody stands behind. Amounts live in module state so a language
// re-render doesn't wipe a half-typed trade.
const inst = { dir: "btc2qbt", pay: "", recv: "", edited: "pay" };
// coordGet drops JSON error payloads; RFQ errors carry data (available size, fresh quote) we want.
const rfqGet = async (p) => { const r = await fetch(coordUrl(p)); const j = await r.json(); if (!r.ok) { const e = new Error(j.error || r.status); e.data = j; throw e; } return j; };
function instantWidget() {
  const box = h("div", { class: "inst", id: "inst" });
  buildInst(box);
  // One depth probe decides whether the widget shows at all (flag on but no makers configured → hide,
  // the hero falls back to the classic CTAs which are rendered regardless, right below).
  rfqGet("/rfq").then((d) => { if (!d.enabled) box.style.display = "none"; }).catch(() => { box.style.display = "none"; });
  clearInterval(window._instTimer);
  window._instTimer = setInterval(() => {   // keep a displayed price honest while the tab sits open
    if (!document.getElementById("inst")) return clearInterval(window._instTimer);
    if (box._requote) box._requote(true);
  }, 10000);
  return box;
}
function buildInst(box) {
  const side = () => (inst.dir === "btc2qbt" ? "buy" : "sell");   // buy = retail buys QBT with BTC
  const payCoin = () => (inst.dir === "btc2qbt" ? "BTC" : "QBT");
  const recvCoin = () => (inst.dir === "btc2qbt" ? "QBT" : "BTC");
  const amtIn = (v) => h("input", { class: "inst-amt", placeholder: "0", inputmode: "decimal", autocomplete: "off", value: v });
  const payIn = amtIn(inst.pay), recvIn = amtIn(inst.recv);
  const status = h("div", { class: "inst-status" }, "");
  const avail = h("div", { class: "inst-avail" }, "");
  const cta = h("button", { class: "primary btn-lg inst-cta", disabled: true }, t("instCta"));
  let quote = null, seq = 0;

  async function requote(silent = false) {
    const editedIn = inst.edited === "pay" ? payIn : recvIn;
    const editedCoin = inst.edited === "pay" ? payCoin() : recvCoin();
    const otherIn = inst.edited === "pay" ? recvIn : payIn;
    const amount = toSats(editedIn.value);
    quote = null; cta.disabled = true;
    if (!(amount > 0)) { status.textContent = ""; otherIn.value = ""; refreshAvail(); return; }
    const my = ++seq;
    if (!silent) status.textContent = t("instQuoting");
    try {
      const q = await rfqGet(`/rfq/quote?side=${side()}&${editedCoin === "BTC" ? "btcSats" : "qbtSats"}=${amount}`);
      if (my !== seq) return;
      quote = q;
      const otherCoin = inst.edited === "pay" ? recvCoin() : payCoin();
      otherIn.value = amtStr(otherCoin === "BTC" ? q.btcSats : q.qbtSats);
      inst[inst.edited === "pay" ? "recv" : "pay"] = otherIn.value;
      status.textContent = t("instPriceLine", { price: trimZeros(q.price.toFixed(8)) });
      cta.disabled = false;
    } catch (e) {
      if (my !== seq) return;
      otherIn.value = ""; inst[inst.edited === "pay" ? "recv" : "pay"] = "";
      status.textContent = /not enough liquidity/.test(e.message) ? t("instTooBig", { qbt: sats(e.data?.available || 0) })
        : /no liquidity/.test(e.message) ? t("instNoLiq") : e.message;
    }
    refreshAvail();
  }
  // "N QBT available" for the active side — how deep the one-click pool goes right now.
  async function refreshAvail() {
    try { const d = await rfqGet("/rfq"); const q = d[side()].qbtSats; avail.textContent = q > 0 ? t("instAvail", { qbt: sats(q) }) : t("instNoLiq"); } catch { avail.textContent = ""; }
  }
  let deb;
  const onEdit = (which) => () => { inst.edited = which; inst[which] = (which === "pay" ? payIn : recvIn).value; clearTimeout(deb); deb = setTimeout(() => requote(), 350); };
  payIn.oninput = onEdit("pay"); recvIn.oninput = onEdit("recv");

  const panel = (labelKey, input, coin, feeNote) => h("div", { class: "inst-panel" },
    h("div", { class: "inst-label" }, t(labelKey)),
    h("div", { class: "inst-row" }, input, h("span", { class: "inst-coin" }, L(coin))),
    feeNote ? h("div", { class: "inst-fee" }, feeNote) : null);
  const payFee = (payCoin() === "BTC" && FEE_BPS > 0) ? t("instFeeNote", { pct: feePct() }) : null;
  // Taker-pays on sells too: the quoted BTC proceeds arrive NET of the platform fee — say so.
  const recvFee = (recvCoin() === "BTC" && FEE_BPS > 0) ? t("instFeeNoteSell", { pct: feePct() }) : null;
  const switchBtn = h("button", { class: "inst-switch", "aria-label": t("instSwitch"), title: t("instSwitch"), onclick: () => {
    inst.dir = inst.dir === "btc2qbt" ? "qbt2btc" : "btc2qbt";
    [inst.pay, inst.recv] = [inst.recv, inst.pay];   // flip the trade: what you received becomes what you pay
    inst.edited = "pay";
    buildInst(box);
  } }, "↓");
  cta.onclick = () => {
    if (!quote) return;
    clearInterval(window._instTimer);
    flow.mode = "rfq"; flow.rfqSide = quote.side; flow.rfqPrice = quote.price;
    flow.role = quote.side === "buy" ? "alice" : "bob"; flow.direction = dirForRole(flow.role);
    flow.btcSats = quote.btcSats; flow.qbtSats = quote.qbtSats;
    flow.receiveAddr = ""; flow.refundAddr = ""; flow.fee = null; flow.verified = false;
    stepRfqConfirm();
  };
  while (box.firstChild) box.removeChild(box.firstChild);
  box.append(
    panel("instPay", payIn, payCoin(), payFee),
    switchBtn,
    panel("instRecv", recvIn, recvCoin(), recvFee),
    h("div", { class: "inst-meta" }, status, avail),
    cta);
  box._requote = requote;
  if (toSats(inst.pay) > 0 || toSats(inst.recv) > 0) requote(true); else refreshAvail();
}
// Confirm screen for an instant swap: the deal + the price, the fee gross-up for the BTC payer, and
// the same custody/timing ground rules as the peer flow (minus "go find a counterparty" — the maker
// bot IS the counterparty).
function stepRfqConfirm() {
  rerender = stepRfqConfirm;
  const summary = flow.rfqSide === "buy"
    ? t("buyingSummary", { qbt: sats(flow.qbtSats), btc: sats(flow.btcSats) })
    : t("sellingSummary", { qbt: sats(flow.qbtSats), btc: sats(flow.btcSats) });
  render(screen({
    title: t("rfqConfirmTitle"), subtitle: t("rfqConfirmSub"),
    body: [
      h("div", { class: "fund" },
        h("div", { style: "font-size:16px;font-weight:600" }, summary),
        h("div", { class: "note", style: "margin-top:4px" }, t("rfqQuoteLine", { price: trimZeros(flow.rfqPrice.toFixed(8)) }))),
      feeBreakdown(),
      flow.rfqSide === "sell" && FEE_BPS > 0 ? h("p", { class: "note" }, t("instFeeNoteSell", { pct: feePct() })) : null,
      h("p", { class: "note" }, t("rfqConfirmP1")),
      h("p", { class: "note" }, t("confirmP2")),
      h("p", { class: "note" }, t("confirmP3")),
    ],
    cta: t("continue"), onCta: () => stepReceive(),
    back: () => stepWelcome(),
  }));
}
// Take the quote (LAST step, after addresses — so an abandoned setup never creates a swap the maker
// gets matched into) and enter the swap like any taker. Limit semantics: fills at flow.rfqPrice or
// better; on "price moved" we re-quote, update the held limit, and ask the user to press again.
async function doRfqTake() {
  let take;
  try {
    take = await coordPost("/rfq/take", { side: flow.rfqSide, qbtSats: flow.qbtSats, price: flow.rfqPrice });
  } catch (e) {
    if (/price moved|liquidity/i.test(e.message)) {
      try {
        const q = await rfqGet(`/rfq/quote?side=${flow.rfqSide}&qbtSats=${flow.qbtSats}`);
        flow.rfqPrice = q.price; flow.btcSats = q.btcSats;
        const err = new Error(t("instPriceMoved", { price: trimZeros(q.price.toFixed(8)) })); err.repriced = true; throw err;
      } catch (e2) { throw e2.repriced ? e2 : e; }
    }
    throw e;
  }
  flow.btcSats = take.terms.btcSats; flow.qbtSats = take.terms.qbtSats;
  flow.client = mkClient({ coordinator: flow.coordinator || DEFAULT_COORD });
  await flow.client.enter({ id: take.swapId, token: take.token, direction: "btc2qbt", role: take.role, ...destsForClient() });
  await vault.save(flow.client.secrets());
  markEnteredAddrs(flow.client.id);
  stepBackup(() => startLive());
}

// Landing page — hero + call-to-action + value props.
function stepWelcome() {
  rerender = stepWelcome;
  markScreen(null);   // root screen — Back off the landing leaves the app
  const feature = (n) => h("div", { class: "feature" },
    h("div", { class: "flabel" }, h("span", { class: "fdot" }), t("feat" + n)),
    h("p", {}, t("feat" + n + "d")));
  render(h("div", { class: "landing" },
    h("section", { class: "hero" },
      h("div", { class: "hero-emblem", html: EMBLEM_SVG }),
      h("div", { class: "hero-kicker" }, t("heroKicker")),
      h("h1", {}, t("heroTitle")),
      h("p", { class: "hero-sub" }, t("heroSub")),
      RFQ ? instantWidget() : null,
      h("div", { class: "hero-cta" },
        h("button", { class: "primary btn-lg", onclick: () => stepChoose() }, t("heroStart")),
        h("button", { class: "btn-lg btn-ghost", onclick: () => stepInfo() }, t("heroLearn"))),
    ),
    h("section", { class: "features" },
      h("h2", {}, t("featTitle")),
      h("div", { class: "feature-grid" }, feature(1), feature(2), feature(3), feature(4), feature(5), feature(6))),
    h("section", { class: "steps-section" },
      h("h2", {}, t("stepsTitle")),
      h("div", { class: "steps" },
        stepRow(1, h("p", {}, t("step1dPre"),
          h("a", { href: DISCORD_URL, target: "_blank", rel: "noopener" }, t("confirmDiscordLink")),
          t("step1dPost"))),
        stepRow(2), stepRow(3), stepRow(4), stepRow(5), stepRow(6), stepRow(7))),
    h("section", { class: "about" },
      h("h2", {}, t(bk("aboutQbitTitle"))),
      h("p", { class: "about-body" }, t(bk("aboutQbitBody")), " ",
        h("a", { href: PROJECT_LINK.href, target: "_blank", rel: "noopener" }, PROJECT_LINK.text))),
  ));
}
const stepRow = (n, detail) => h("div", { class: "step" },
  h("div", { class: "step-num" }, n),
  h("div", { class: "step-body" }, h("b", {}, t("step" + n + "t")), detail || h("p", {}, t("step" + n + "d"))));

// Direction chooser + resume/recover.
async function stepChoose(resumable) {
  rerender = () => stepChoose(resumable);
  const list = resumable || (await vault.list().catch(() => []));
  render(h("div", {},
    screen({
      title: t("swapWhichWay"), subtitle: t("nonCustodial"),
      body: [
        bigChoice(coinGlyph("btc"), t("haveBtc"), t("haveBtcSub"), () => chooseDirection("btc2qbt")),
        bigChoice(coinGlyph("qbit"), t("haveQbt"), t("haveQbtSub"), () => chooseDirection("qbt2btc")),
      ],
      back: () => stepWelcome(),
    }),
    await recoverCard(list),
  ));
}

// Header for a full-width content page (Info / Activity): big title + a Back link that drives history.
const pageHead = (title, back) => h("div", { class: "page-head" },
  h("h1", {}, title),
  back ? h("a", { class: "page-back", href: "#", onclick: (e) => { e.preventDefault(); history.back(); } }, t("back")) : null);

// Info / how-it-works + FAQ + technical details — a wide, landing-style page (reached from the header
// tab; Back returns to where you were).
let _prevView = null;
function stepInfo() {
  if (rerender !== stepInfo) _prevView = rerender;
  rerender = stepInfo;
  const back = () => { rerender = _prevView || (() => init()); rerender(); };
  markScreen(back, "/info");
  const infoStep = (n, k) => h("div", { class: "info-step" }, h("span", { class: "n" }, n), h("p", {}, t(k)));
  const qa = (q, a, link) => h("div", { class: "qa" },
    h("div", { class: "q" }, t(q)),
    h("p", { class: "a" }, t(a), ...(link ? [" ", h("a", { href: link.href, target: "_blank", rel: "noopener" }, link.text)] : [])));
  const techQa = (n) => h("div", { class: "qa" }, h("div", { class: "q" }, t("tech" + n + "l")), h("p", { class: "a" }, t("tech" + n + "d")));
  render(h("div", { class: "page" },
    pageHead(t("infoHowTitle"), back),
    h("p", { class: "page-intro" }, t("infoIntro")),
    h("div", { class: "info-steps" }, infoStep(1, "infoStep1"), infoStep(2, "infoStep2"), infoStep(3, "infoStep3"), infoStep(4, "infoStep4")),
    h("section", { class: "page-section" },
      h("h2", {}, t("infoFaqTitle")),
      h("div", { class: "qa-grid" },
        qa(bk("faqWhatQ"), bk("faqWhatA"), PROJECT_LINK),
        qa("faqCustodialQ", "faqCustodialA"), qa("faqStallQ", "faqStallA"), qa("faqHowLongQ", "faqHowLongA"),
        qa("faqFindQ", "faqFindA"), qa("faqFeesQ", "faqFeesA"), qa("faqWalletQ", "faqWalletA"), qa("faqBackupQ", "faqBackupA"))),
    h("section", { class: "page-section" },
      h("h2", {}, t("techTitle")),
      h("div", { class: "qa-grid" }, techQa(1), techQa(2), techQa(3), techQa(4), techQa(5), techQa(6), techQa(7), techQa(8))),
  ));
}

// Activity — a public feed of successfully settled swaps (feature-flagged, header tab).
async function stepTrades() {
  if (rerender !== stepTrades) _prevView = rerender;
  rerender = stepTrades;
  const back = () => { rerender = _prevView || (() => init()); rerender(); };
  markScreen(back, "/activity");
  let trades = null;
  try { trades = await coordGet("/trades"); } catch { trades = []; }
  let btcUsd = 0;
  try { btcUsd = await btcUsdPrice(); } catch { /* CoinGecko unavailable → USD column shows — */ }   // cached 2 min
  let content;
  if (!trades.length) {
    content = h("p", { class: "muted", style: "margin-top:24px" }, t("tradesEmpty"));
  } else {
    const usdCell = (tr) => (btcUsd ? `$${trimZeros((tr.price * btcUsd).toFixed(4))}` : "—");   // USD per QBT = (BTC/QBT) × BTCUSD
    const rows = trades.map((tr) => h("tr", {},
      h("td", {}, `${sats(tr.qbtSats)} ${tickers().qbt}`),
      h("td", {}, `${sats(tr.btcSats)} ${tickers().btc}`),
      h("td", {}, trimZeros(tr.price.toFixed(8))),
      h("td", {}, usdCell(tr)),
      h("td", { class: "when" }, tr.settledAt ? ago(tr.settledAt) : "—")));
    content = h("div", { class: "trades-card" }, h("table", { class: "trades" },
      h("thead", {}, h("tr", {}, h("th", {}, tickers().qbt), h("th", {}, tickers().btc), h("th", {}, t("tradesPriceBtc")), h("th", {}, t("tradesPriceUsd")), h("th", {}, t("tradesWhen")))),
      h("tbody", {}, ...rows)));
  }
  render(h("div", { class: "page" },
    pageHead(t("tradesTitle"), back),
    h("p", { class: "page-intro" }, t("tradesNote")),
    content,
  ));
}

function chooseDirection(direction) {
  flow.direction = direction;
  // The creator's own role: buying QBT (btc2qbt) → initiator (alice); selling QBT (qbt2btc) →
  // participant (bob). The QBT buyer is always the initiator, so a seller-creator shares the alice link.
  flow.role = direction === "btc2qbt" ? "alice" : "bob";
  if (ORDERBOOK) return showMarket(direction);   // order book (flagged); otherwise go straight to peer-to-peer
  flow.mode = "create"; stepConfirm();
}

// ── market view: the order-book side relevant to the chosen direction + a peer option ─────────
// btc->qbt = buy QBT (take asks); qbt->btc = sell QBT (take bids).
async function showMarket(direction) {
  rerender = () => showMarket(direction);
  const action = direction === "btc2qbt" ? "buy" : "sell";
  render(h("div", {},
    marketCard(direction, action, { asks: [], bids: [] }),
    h("div", { class: "card", style: "text-align:center" }, h("button", { class: "primary", style: "width:100%", onclick: () => startPeer() }, t("tradePeer")))));
  refreshMarket(direction, action);
  scheduleMarketRefresh(direction, action);
}
function marketCard(direction, action, book) {
  const offers = action === "buy" ? book.asks : book.bids;
  return h("div", { class: "card", id: "market" },
    h("div", { style: "display:flex;justify-content:space-between;align-items:center" },
      h("h2", { style: "margin:0" }, action === "buy" ? t("buyQbt") : t("sellQbt")),
      h("button", { class: "copy", onclick: () => refreshMarket(direction, action) }, t("refreshBook"))),
    ...(offers && offers.length ? offers.map((o) => offerRow(o, action)) : [h("p", { class: "note", style: "margin-top:10px" }, t("noOffers"))]),
    h("div", { style: "margin-top:14px" }, h("a", { href: "#", style: "color:var(--mut)", onclick: (e) => { e.preventDefault(); init(); } }, t("back"))));
}
async function refreshMarket(direction, action) {
  try { const book = await coordGet("/offers"); const el = document.getElementById("market"); if (el) el.replaceWith(marketCard(direction, action, book)); } catch {}
}
function scheduleMarketRefresh(direction, action) {
  clearInterval(window._bookTimer);
  window._bookTimer = setInterval(() => { if (!document.getElementById("market")) return clearInterval(window._bookTimer); refreshMarket(direction, action); }, 6000);
}
function offerRow(o, action) {
  const btn = h("button", { class: "primary", style: "padding:6px 16px", onclick: () => takeAndStart(o, action) }, action === "buy" ? t("buyBtn") : t("sellBtn"));
  return h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid var(--line)" },
    h("div", {}, h("span", { style: "font-weight:600" }, `${sats(o.qbtSats)} ${tickers().qbt}`), h("span", { class: "note", style: "margin-left:10px" }, `${o.price.toFixed(4)} ${t("perQbt")}`)),
    h("div", { style: "display:flex;align-items:center;gap:14px" }, h("span", { class: "note" }, `${sats(o.btcSats)} ${tickers().btc}`), btn));
}
async function takeAndStart(o, action) {
  try {
    const take = await coordPost(`/offers/${o.id}/take`);       // { swapId, takerToken, role, terms }
    clearInterval(window._bookTimer);
    flow.mode = "take"; flow.takeAction = action; flow.role = take.role; flow.direction = dirForRole(take.role);
    flow.btcSats = take.terms.btcSats; flow.qbtSats = take.terms.qbtSats;
    flow.takeSwapId = take.swapId; flow.takeToken = take.takerToken; flow.receiveAddr = ""; flow.refundAddr = "";
    stepTakeConfirm();
  } catch (e) { alert(e.message); refreshMarket(flow.direction, action); }   // e.g. someone else took it
}
function stepTakeConfirm() {
  rerender = stepTakeConfirm;
  const summary = flow.takeAction === "buy" ? t("buyingSummary", { qbt: sats(flow.qbtSats), btc: sats(flow.btcSats) }) : t("sellingSummary", { qbt: sats(flow.qbtSats), btc: sats(flow.btcSats) });
  render(screen({
    title: flow.takeAction === "buy" ? t("buyQbt") : t("sellQbt"),
    body: [h("div", { class: "fund" }, h("div", { style: "font-size:16px;font-weight:600" }, summary)), h("p", { class: "note" }, t("confirmP3"))],
    cta: t("continue"), onCta: () => stepReceive(),
    back: () => showMarket(flow.direction),
  }));
}
async function doTake() {
  flow.client = mkClient({ coordinator: flow.coordinator || DEFAULT_COORD });
  await flow.client.enter({ id: flow.takeSwapId, token: flow.takeToken, direction: "btc2qbt", role: flow.role, ...destsForClient() });
  await vault.save(flow.client.secrets());
  markEnteredAddrs(flow.client.id);
  stepBackup(() => startLive());
}
// Trade directly with a peer (create a private swap + share a link) for the chosen direction.
function startPeer() {
  clearInterval(window._bookTimer);
  flow.mode = "create";
  stepConfirm();
}

async function recoverCard(ids) {
  const card = h("div", { class: "card secondary" }, h("h2", {}, t("recoverTitle")), h("p", { class: "note" }, t("recoverBody")));
  const active = [];
  for (const id of ids) { const s = await vault.load(id).catch(() => null); if (s && !s.done) active.push([id, s]); }   // hide finished swaps
  for (const [id, s] of active) {
    // Lead with WHEN it was started (easiest to recognize), then the trade in smaller type below.
    const amounts = (s.qbtSats != null && s.btcSats != null)
      ? t(s.role === "alice" ? "resumeBuy" : "resumeSell", { qbt: sats(s.qbtSats), btc: sats(s.btcSats) })
      : t("resumeBtn", { from: DIR[dirForRole(s.role)]?.from, to: DIR[dirForRole(s.role)]?.to, id: shorten(id, 6) });
    card.append(s.createdAt
      ? h("button", { class: "primary resume-btn", style: "width:100%;margin-top:8px", onclick: () => resumeSwap(s) },
          h("div", { class: "resume-when" }, t("resumeStarted", { when: fmtWhen(s.createdAt) })),
          h("div", { class: "resume-amt" }, amounts))
      : h("button", { class: "primary", style: "width:100%;margin-top:8px", onclick: () => resumeSwap(s) }, amounts));
  }
  const fileInput = h("input", { type: "file", accept: "application/json", style: "display:none", onchange: async (e) => { const f = e.target.files?.[0]; if (!f) return; try { resumeSwap(importBackup(await f.text())); } catch (err) { alert(t("errReadBackup", { msg: err.message })); } } });
  card.append(fileInput, h("div", { class: "btns", style: "margin-top:10px" }, h("button", { style: "font-size:12.5px; padding:7px 12px", onclick: () => fileInput.click() }, active.length ? t("uploadInstead") : t("uploadBackup"))));
  return card;
}

function stepConfirm() {
  rerender = stepConfirm;
  const d = DIR[flow.direction];
  render(screen({
    title: t("beforeBegin"), subtitle: t("confirmSub"),
    body: [
      h("p", { class: "note" }, t("confirmP1", { from: d.from, to: d.to })),
      h("p", { style: "font-size:19px;font-weight:660;letter-spacing:-.015em;line-height:1.3;color:var(--ink);margin:14px 0 4px" }, t("confirmKey")),
      h("p", { class: "note", style: "margin-top:2px" }, t("confirmP1b")),
      h("p", { class: "note" }, t("confirmP2")),
      h("p", { class: "note" }, t("confirmP3")),
      h("p", { class: "note" }, t("confirmDiscordPre"),
        h("a", { href: DISCORD_URL, target: "_blank", rel: "noopener" }, t("confirmDiscordLink")),
        t("confirmDiscordPost")),
    ],
    cta: t("confirmCta"), onCta: () => stepAmount(), back: () => (ORDERBOOK ? showMarket(flow.direction) : stepChoose()),
  }));
}

// BTC/USD from CoinGecko, cached ~2 min (for the optional price helper on the amounts step).
let _btcUsd = { v: 0, at: 0 };
async function btcUsdPrice() {
  if (_btcUsd.v && Date.now() - _btcUsd.at < 120000) return _btcUsd.v;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    const v = (await r.json())?.bitcoin?.usd;
    if (v > 0) _btcUsd = { v, at: Date.now() };
  } catch { /* offline / rate-limited → $ mode just stays blank; ₿ mode still works */ }
  return _btcUsd.v;
}
// On the fork pair the natural quote is coin-per-coin ("BTC-SHA256 per BTC-Blake2b"), not USD.
let priceMode = BRAND === "bip110" ? "btc" : "usd";   // "usd" | "btc", persists across re-renders

function stepAmount() {
  rerender = stepAmount;
  const { send, recv } = roleCoins();
  const sendIn = field(t("amountPlaceholder", { coin: send }), coinSats(send) ? amtStr(coinSats(send)) : "");
  const recvIn = field(t("amountPlaceholder", { coin: recv }), coinSats(recv) ? amtStr(coinSats(recv)) : "");
  const btcIn = send === "BTC" ? sendIn : recvIn;   // which input holds BTC / QBT (direction-independent)
  const qbtIn = send === "BTC" ? recvIn : sendIn;

  // Price helper: shows $ (or ₿) per QBT. QBT, BTC and price are three linked fields; whichever you
  // edited least recently is the one we recompute, so editing any two keeps them and the third follows
  // (a standard 3-field calculator). A toggle switches the unit; BTCUSD is the cached CoinGecko rate.
  const unitKey = () => (priceMode === "usd" ? "priceUsd" : "priceBtc");
  const priceIn = field(t(unitKey()));
  const num = (el) => { const n = parseFloat(el.value.replace(/,/g, "")); return isFinite(n) && n > 0 ? n : 0; };
  const trim = (n) => n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  let usd = 0;
  const bpqFromPrice = () => { const p = num(priceIn); return priceMode === "usd" ? (usd ? p / usd : 0) : p; };  // price field → BTC-per-QBT
  let order = ["qbt", "btc", "price"];   // most-recently-edited first; order[2] (price, initially) is recomputed
  function recompute() {
    const target = order[2];
    if (target === "price") {
      const b = num(btcIn), q = num(qbtIn);
      priceIn.value = (!b || !q) ? "" : (priceMode === "usd" ? (usd ? (b / q * usd).toFixed(4) : "") : trim(b / q));
    } else if (target === "btc") {
      const q = num(qbtIn), bpq = bpqFromPrice();
      if (q && bpq) btcIn.value = trim(bpq * q);
    } else {   // qbt
      const b = num(btcIn), bpq = bpqFromPrice();
      if (b && bpq) qbtIn.value = trim(b / bpq);
    }
  }
  const touch = (fieldId) => { order = [fieldId, ...order.filter((x) => x !== fieldId)]; recompute(); };
  const unitBtn = h("button", { type: "button", class: "copy", onclick: () => {
    priceMode = priceMode === "usd" ? "btc" : "usd"; unitBtn.textContent = t(unitKey()); priceIn.placeholder = t(unitKey());
    order = [...order.filter((x) => x !== "price"), "price"]; recompute();   // re-derive the shown price from the amounts in the new unit
  } }, t(unitKey()));
  // Below-minimum guard: surface it immediately on the amount screen (not later, after addresses). Only
  // once BOTH amounts are filled — no nagging mid-type — but then live on every keystroke. Flags the
  // offending input(s) red, explains the minimum, and disables Continue. MIN_SATS comes from the
  // coordinator's own config (injected), so this check and the server's stay in lockstep.
  const errMsg = h("p", { class: "note", style: "color:var(--bad);font-weight:600;margin-top:10px;display:none" });
  let ctaBtn = null;
  function validate() {
    const clear = () => { for (const el of [btcIn, qbtIn]) el.classList.remove("field-err", "flash"); errMsg.style.display = "none"; if (ctaBtn) ctaBtn.disabled = false; };
    if (!MIN_SATS || btcIn.value.trim() === "" || qbtIn.value.trim() === "") return clear();   // wait for both fields
    const btcLow = toSats(btcIn.value) < MIN_SATS.btc, qbtLow = toSats(qbtIn.value) < MIN_SATS.qbit;
    if (!btcLow && !qbtLow) return clear();
    btcIn.classList.toggle("field-err", btcLow); qbtIn.classList.toggle("field-err", qbtLow);
    errMsg.textContent = t("amtTooSmall", { btc: sats(MIN_SATS.btc), qbt: sats(MIN_SATS.qbit) });
    errMsg.style.display = "";
    if (ctaBtn) ctaBtn.disabled = true;
    for (const el of [btcLow && btcIn, qbtLow && qbtIn].filter(Boolean)) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }   // re-trigger the flash
  }
  qbtIn.oninput = () => { touch("qbt"); validate(); };
  btcIn.oninput = () => { touch("btc"); validate(); };
  priceIn.oninput = () => { touch("price"); validate(); };
  btcUsdPrice().then((u) => { usd = u; recompute(); validate(); });
  recompute();

  // Per-box fee notes, sitting directly under the input each concerns:
  //  · the BTC box carries the 2% platform-fee note (the buyer pays it; the seller sees who bears it).
  //  · the QBT-RECEIVE box (buyer) carries the on-chain claim fee, with a LIVE estimate fetched from the
  //    coordinator's feerates and sized with the same dynFee the real claim uses.
  const sendNote = (send === "BTC" && FEE_BPS > 0) ? h("p", { class: "note fee-note" }, t("feeAdded", { pct: feePct() })) : null;
  const recvNote = recv === "QBT"
    ? h("p", { class: "note fee-note" }, t("qbtRecvFeeNote", { amt: "…" }))
    : (recv === "BTC" && FEE_BPS > 0 ? h("p", { class: "note fee-note" }, t("feeAddedCounterparty", { pct: feePct() })) : null);
  if (recv === "QBT") fetchFeerates()
    .then((fr) => { recvNote.textContent = t("qbtRecvFeeNote", { amt: amtStr(dynFee("qbit", "claim", fr, 0)) }); })
    .catch(() => {});

  render(screen({
    title: t("howMuch"),
    body: [
      h("label", {}, t("youSendCoin", { coin: send })), sendIn, sendNote,
      h("label", {}, t("youReceiveCoin", { coin: recv })), recvIn, recvNote,
      h("div", { style: "display:flex;align-items:center;gap:9px;margin:14px 0 5px" },
        h("span", { style: "font-size:12.5px;font-weight:550;color:var(--mut)" }, t("priceLabel")), unitBtn),
      priceIn,
      errMsg,
    ],
    cta: t("continue"),
    onCta: () => {
      flow[send === "BTC" ? "btcSats" : "qbtSats"] = toSats(sendIn.value);
      flow[recv === "BTC" ? "btcSats" : "qbtSats"] = toSats(recvIn.value);
      stepReceive();
    },
    back: () => stepConfirm(),
  }));
  ctaBtn = appEl.querySelector(".card > button.primary");   // the Continue button screen() built — gate it on validity
  validate();
}

function stepReceive() {
  rerender = stepReceive;
  const { recv } = roleCoins();
  const inp = field(t("receivePlaceholder", { coin: recv }));
  if (flow.receiveAddr) inp.value = flow.receiveAddr; else prefill(inp, recv);
  render(screen({
    title: t("receiveTitle", { coin: recv }),
    body: [inp, h("p", { class: "note" }, t("feeNote"))], cta: t("continue"),
    onCta: () => { flow.receiveAddr = validAddr(inp.value, recv); stepRefund(); },
    back: flow.mode === "create" ? () => stepAmount() : flow.mode === "take" ? () => stepTakeConfirm() : flow.mode === "rfq" ? () => stepRfqConfirm() : () => stepInvited(),
  }));
}

function stepRefund() {
  rerender = stepRefund;
  const { send } = roleCoins();
  const inp = field(t("refundPlaceholder", { coin: send }));
  if (flow.refundAddr) inp.value = flow.refundAddr; else prefill(inp, send);
  const cta = flow.mode === "create" ? t("createSwap")
    : flow.mode === "take" ? (flow.takeAction === "buy" ? t("buyNow") : t("sellNow"))
    : flow.mode === "rfq" ? (flow.rfqSide === "buy" ? t("buyNow") : t("sellNow"))
    : t("joinSwap");
  render(screen({
    title: t("refundTitle", { coin: send }),
    body: [h("p", { class: "note", style: "margin:18px 0 22px" }, t("refundSub")), inp], cta,
    onCta: async () => {
      flow.refundAddr = validAddr(inp.value, send);
      flow.mode === "create" ? await doCreate() : flow.mode === "take" ? await doTake() : flow.mode === "rfq" ? await doRfqTake() : await doJoin();
    },
    back: () => stepReceive(),
  }));
}

function destsForClient() {
  const { recv } = roleCoins();
  const addrForCoin = (coin) => (coin === recv ? flow.receiveAddr : flow.refundAddr);
  return { btcDest: addrForCoin("BTC"), qbitDest: addrForCoin("QBT") };
}
async function doCreate() {
  flow.client = mkClient({ coordinator: flow.coordinator });
  const res = await flow.client.create({ role: flow.role, btcSats: flow.btcSats, qbtSats: flow.qbtSats, securityLevel: "high", ...destsForClient() });
  flow.inviteLink = res.inviteLink;
  await vault.save(flow.client.secrets());
  markEnteredAddrs(flow.client.id);   // this browser typed its own addresses → skip the verify gate here
  stepBackup(() => stepShare());
}
async function doJoin() {
  flow.client = mkClient({ coordinator: flow.coordinator });
  try {
    await flow.client.join({ id: flow.joinId, token: flow.joinToken, ...destsForClient() });
  } catch (e) {
    if (/already been joined|already joined/i.test(e.message || "")) throw new Error(t("errAlreadyJoined"));
    throw e;
  }
  await vault.save(flow.client.secrets());
  markEnteredAddrs(flow.client.id);
  stepBackup(() => startLive());
}

function stepBackup(next) {
  rerender = () => stepBackup(next);
  markScreen(null);
  let downloaded = false;
  const cont = h("button", { class: "primary", style: "width:100%;margin-top:16px", disabled: true, onclick: () => next() }, t("continue"));
  const chk = h("input", { type: "checkbox", style: "width:auto;margin:2px 9px 0 0;flex:0 0 auto", onchange: () => { cont.disabled = !(downloaded && chk.checked); } });
  const confirmRow = h("label", { style: "display:none;margin-top:16px;align-items:flex-start;gap:2px;font-size:13px;color:var(--fg);cursor:pointer" }, chk, h("span", {}, t("confirmSavedBackup")));
  const dl = h("button", { onclick: () => { saveFile(`${BRAND === "bip110" ? "shaswap" : "qbit-swap"}-${flow.client.id.slice(0, 8)}.json`, exportBackup(flow.client.secrets())); downloaded = true; dl.textContent = t("backupDownloaded"); confirmRow.style.display = "flex"; } }, t("downloadBackupBtn"));
  render(h("div", { class: "card" },
    h("h2", {}, t("saveBackup")),
    h("p", { class: "note", style: "margin-top:-4px" }, t("backupSub")),
    h("p", { class: "note" }, t("backupNote")),
    h("div", { class: "btns", style: "margin-top:14px" }, dl),
    confirmRow, cont));
}

const linkBox = () => h("div", { class: "mono", style: "background:var(--panel2);padding:10px;border-radius:8px" }, flow.inviteLink);
function stepShare() {
  rerender = stepShare;
  // Copy reveals the Continue button (which goes straight live) — no intermediate confirm slide.
  const cont = h("button", { class: "primary", style: "width:100%;margin-top:12px;display:none", onclick: () => startLive() }, t("continue"));
  const copyBtn = h("button", { class: "primary", style: "width:100%;margin-top:16px", onclick: async () => {
    try { await navigator.clipboard?.writeText(flow.inviteLink); } catch {}
    copyBtn.textContent = t("copiedCheck");
    cont.style.display = "block";
  } }, t("copyLink"));
  render(screen({
    title: t("shareTitle"), subtitle: t("shareSub"),
    body: [linkBox(), copyBtn, cont],
  }));
}

// ── participant entry (opened via link) ───────────────────────────────────────
// While the participant is filling in their details (pre-join, no swap client yet), ping the coordinator
// so it keeps seeing them as online — otherwise their presence expires and the creator sees "offline"
// even though they're actively entering info. The live client's SSE takes over once they join.
function startJoinHeartbeat(coordinator, id, token) {
  stopJoinHeartbeat();
  const ping = () => fetch(`${coordinator}/swaps/${id}`, { headers: { "x-swap-token": token } }).catch(() => {});
  ping();
  flow._joinHeartbeat = setInterval(ping, 8000);   // < the coordinator's 15s presence window
}
function stopJoinHeartbeat() { if (flow._joinHeartbeat) { clearInterval(flow._joinHeartbeat); flow._joinHeartbeat = null; } }

async function startParticipant({ coordinator, id, token }) {
  flow.mode = "join"; flow.coordinator = coordinator; flow.joinId = id; flow.joinToken = token;
  render(screen({ title: t("loadingSwap"), body: [spinnerEl(t("fetchingTerms"))] }));
  const v = await (await fetch(`${coordinator}/swaps/${id}`, { headers: { "x-swap-token": token } })).json();
  if (v.state === "CANCELED") {   // creator called it off before it started — don't send them through the join flow
    markScreen(null);
    return render(screen({ title: t("swapCanceled"), body: [h("p", { class: "note" }, v.canceled?.byYou ? t("cancelByYou") : t("cancelByCp"))] }));
  }
  if (v.state === "COMPLETE" || v.state === "REFUNDED") {
    // Reopened the invite link after the swap finished (in a browser without the saved keys) — show the
    // final status read-only from the coordinator view, not the "you've been invited" join flow.
    flow.client?.stop?.(); flow.client = null;
    flow.role = v.role; flow.direction = dirForRole(v.role); flow.fee = v.fee || null;
    flow.btcSats = v.terms?.btcSats || 0; flow.qbtSats = v.terms?.qbtSats || 0; flow.feerates = v.feerates;
    const card = h("div", { class: "card" });
    markScreen(null); render(card); return renderLive(card, v);
  }
  startJoinHeartbeat(coordinator, id, token);   // keep presence alive through the entering-info screens
  // Our role comes from the token (the coordinator knows which side it controls); our send/receive
  // orientation follows from it. A joiner may be the initiator (alice) if the creator was selling QBT.
  flow.role = v.role; flow.direction = dirForRole(v.role); flow.fee = v.fee || null;
  flow.btcSats = v.terms.btcSats; flow.qbtSats = v.terms.qbtSats;
  flow.feerates = v.feerates;
  stepInvited();
}
function stepInvited() {
  rerender = stepInvited;
  const { send, recv } = roleCoins();
  const nr = netReceive(recv, flow.feerates, feeSats() > 0);
  render(screen({
    title: t("invitedTitle"), subtitle: t("invitedSub"),
    body: [
      h("div", { class: "fund" },
        h("div", {}, `${t("youSend")}  `, h("b", {}, `${sats(sendSats())} ${L(send)}`)),
        feeBreakdown(),
        h("div", { style: "margin-top:4px" }, `${t("youReceive")}  `, h("b", {}, `${sats(nr.net)} ${L(recv)}`),
          nr.fee > 0 ? h("span", { class: "note", style: "margin-left:6px" }, t("afterFeeShort", { fee: feeStr(recv, nr.fee) })) : null)),
      h("p", { class: "note" }, t("invitedNote")),
    ],
    cta: t("continue"), onCta: () => stepReceive(),
  }));
}

// ── live: fund + progress (one screen that morphs) ────────────────────────────
let liveCard = null;
function startLive() {
  stopJoinHeartbeat();   // the live client's SSE now maintains presence
  flow.client.stop();   // idempotent: safe if we came back from the share screen and re-enter
  liveCard = h("div", { class: "card" }, spinnerEl());
  render(liveCard);
  markScreen(null);   // swap is committed here — no Back handler, so the browser Back button won't drop you out of a live swap
  // Stamp a token-free permalink (#id=…) so a refresh resumes from the vault instead of the landing —
  // works for the creator too, who otherwise has a bare URL. replaceState doesn't fire hashchange.
  if (flow.client?.id) history.replaceState(history.state, "", location.pathname + location.search + "#id=" + flow.client.id);
  rerender = () => { if (flow.client?.view) renderLive(liveCard, flow.client.view); };
  flow.client.onUpdate = (v) => renderLive(liveCard, v);
  flow.client.start();
  // Re-render on a slow tick so the funding countdown advances even when the coordinator sends no update
  // (SSE only pushes on changes). Skipped while the verification screen is up so it isn't clobbered.
  clearInterval(flow._tick);
  flow._tick = setInterval(() => { if (!flow._verifying && flow.client?.view) renderLive(liveCard, flow.client.view); }, 15000);
}
const STATE_CLASS = { COMPLETE: "good", REFUNDED: "warn", CLAIMABLE: "info", CLAIMED: "info", ABORTED: "bad", CANCELED: "warn" };
// Public block explorers for the tx links in the timeline. Derived from the injected chain config
// (QBIT_CHAINS): on the bip110 fork pair the BTC explorer is the pair's own instance (mempool.guide),
// not a Qbit-branded one; the qbit pair uses mempool.space / the Qbit mempool.
const _CFG = globalThis.QBIT_CHAINS || {};
const _btcExplorer = _CFG.btc?.explorer || "https://mempool.space/tx/";
const _qbitExplorer = _CFG.qbit?.explorer || "https://qbitmempool.robertclarke.com/tx/";
const EXPLORER = { btc: _btcExplorer, qbit: _qbitExplorer };
const txLink = (leg, txid) => h("a", { href: EXPLORER[leg] + txid, target: "_blank", rel: "noopener" }, shorten(txid, 8));
// Confirmation progress under a deposit: "X / Y confirmations · ~Zm" for the reorg-safe-gated leg,
// or just "X confirmations" for the other. ETA uses average mainnet block times.
const AVG_BLOCK = { btc: 600, qbit: 60 };
const etaCompact = (secs) => secs <= 0 ? "" : secs < 60 ? " · <1m" : secs < 3600 ? ` · ~${Math.round(secs / 60)}m` : ` · ~${Math.round(secs / 3600 * 10) / 10}h`;
// The reorg-safe confirmation target for a leg: the claimed coin (toLeg) vs the funding coin (fromLeg,
// which must bury before the preimage is revealed). 0 if this view carries no target for it.
const legTarget = (v, leg) => ((leg === v.roles?.toLeg ? v.confsTarget?.confs : leg === v.roles?.fromLeg ? v.fromConfsTarget?.confs : 0) || 0);
// A funding deposit is "buried" — safe to check off — only once it reaches that target (or is already
// spent), not merely when it's detected in the mempool.
function fundBuried(v, leg, fund) {
  if (!fund) return false;
  if (fund.spent) return true;
  if (fund.unconfirmed || fund.height == null) return false;
  const confs = Math.max(0, (v.heights?.[leg] || 0) - fund.height + 1);
  return confs >= (legTarget(v, leg) || 1);
}
function confSub(v, leg, fund) {
  if (!fund || fund.unconfirmed || fund.height == null) return null;
  const confs = Math.max(0, (v.heights?.[leg] || 0) - fund.height + 1);
  const target = legTarget(v, leg);
  if (!(target > 0)) return t("confCount", { confs });
  const remaining = Math.max(0, target - confs);
  return t("confLine", { confs, target }) + (remaining > 0 ? etaCompact(remaining * (AVG_BLOCK[leg] || 60)) : "");
}

// Context-aware "waiting for confirmation" line under a sent-but-unconfirmed deposit — says WHY this
// confirmation gates the next step (staggered funding), keyed by leg + whose deposit it is.
function fundWaitEl(s) {
  const key = s.leg === "btc" ? (s.mine ? "tlWaitBtcMine" : "tlWaitBtcCp") : (s.mine ? "tlWaitQbtMine" : "tlWaitQbtCp");
  const el = h("span", { class: "tl-conf" }, t(key));
  // Live BTC ETA (mainnet only): size the tx's fee rate against the pair's BTC explorer feerate API.
  if (s.mem && s.leg === "btc" && EXPLORER.btc && s.txid)
    btcConfEta(s.txid).then((eta) => { if (eta) el.textContent = `${t(key)} · ${t("tlEstConf", { eta })}`; }).catch(() => {});
  return el;
}
const _etaCache = new Map();   // per-txid, so re-renders don't refetch
async function btcConfEta(txid) {
  if (_etaCache.has(txid)) return _etaCache.get(txid);
  const base = EXPLORER.btc.replace(/\/tx\/$/, "/api");   // https://mempool.space/api
  const [tx, rec] = await Promise.all([
    fetch(`${base}/tx/${txid}`).then((r) => r.ok ? r.json() : Promise.reject()),
    fetch(`${base}/v1/fees/recommended`).then((r) => r.ok ? r.json() : Promise.reject()),
  ]);
  const vsize = tx.weight ? tx.weight / 4 : (tx.vsize || tx.size);
  const rate = tx.fee && vsize ? tx.fee / vsize : 0;
  const mins = rate >= rec.fastestFee ? 10 : rate >= rec.halfHourFee ? 30 : rate >= rec.hourFee ? 60 : 120;
  const eta = mins < 60 ? `~${mins} min` : `~${Math.round(mins / 60)} hr`;
  _etaCache.set(txid, eta);
  return eta;
}

// A persistent progress timeline for the swap: every step stays visible (matched → you sent →
// counterparty sent → you received / refunded), each with a checkmark and a link to the transaction
// on a public explorer, so the whole history — including the final txid — remains on the page.
function swapTimeline(v, send, recv, action, paused) {
  const fundLeg = coinLeg(send), claimLeg = coinLeg(recv);
  const myFund = v.funding?.[fundLeg], cpFund = v.funding?.[claimLeg];
  const myClaim = v.broadcasts?.[`${claimLeg}:claim`];      // the tx that delivers your received coin
  const myRefund = v.broadcasts?.[`${fundLeg}:refund`];     // your refund tx on abort
  const complete = v.state === "COMPLETE", refunded = v.state === "REFUNDED";
  // Labels are tense-aware: they flip to past tense once the deposit is SENT (`reached`), but the
  // checkmark only fills once that deposit is BURIED to its required depth (`done`) — not merely seen in
  // the mempool. So a funding step reads "You sent BTC · in mempool · 0 / 1 confirmations" with a hollow
  // ring until it confirms, then fills. (`reached` defaults to `done` for steps without a funding tx.)
  // The two funding steps, ordered by the actual funding SEQUENCE — fromLeg (BTC) is deposited first,
  // then toLeg (QBT) — not self-first. So the QBT seller sees "Counterparty sends BTC" BEFORE "You send
  // QBT", matching the staggered flow (they can't deposit until the BTC confirms anyway).
  const fromLeg = v.roles?.fromLeg || "btc", toLeg = v.roles?.toLeg || "qbit";
  const fundStep = (leg) => {
    const mine = leg === fundLeg, coin = mine ? send : recv, fund = v.funding?.[leg];
    return { label: (d) => t(mine ? (d ? "tlYouSent" : "tlYouSend") : (d ? "tlCpSent" : "tlCpSend"), { coin }),
             done: fundBuried(v, leg, fund), reached: !!fund, leg, mine, txid: fund?.txid, mem: fund?.unconfirmed, fund };
  };
  const steps = [
    { label: () => t("tlMatched"), done: !!v.htlc },
    fundStep(fromLeg),
    fundStep(toLeg),
  ];
  if (refunded) steps.push({ label: () => t("tlRefunded", { coin: send }), done: !!myRefund, leg: fundLeg, txid: myRefund });
  else steps.push({ label: (d) => t(d ? "tlYouReceived" : "tlYouReceive", { coin: recv }), done: complete || !!myClaim, leg: claimLeg, txid: myClaim });
  let activeSet = false;
  return h("div", { class: "timeline" }, ...steps.map((s) => {
    const state = s.done ? "done" : (!activeSet && (activeSet = true) ? "active" : "todo");
    // Paused (underfunded) → strike the steps that can no longer proceed (everything not already done).
    return h("div", { class: "tl-step " + state + (paused && !s.done ? " paused" : "") },
      h("span", { class: "tl-icon " + state }, s.done ? "✓" : ""),   // upcoming steps: a hollow ring (the border), no inner dot
      h("div", { class: "tl-body" },
        h("span", { class: "tl-label" }, s.label(s.reached ?? s.done)),
        s.txid ? h("span", { class: "tl-tx" }, s.mem ? h("span", { class: "tl-mem" }, t("tlMempool") + " · ") : null, txLink(s.leg, s.txid)) : null,
        s.fund ? ((c) => c ? h("span", { class: "tl-conf" }, c) : null)(confSub(v, s.leg, s.fund)) : null,
        // While a deposit is sent-but-not-buried, explain WHY the confirmation is being awaited (staggered
        // funding) — plus a live BTC ETA from mempool.space sized on the tx's own fee rate.
        (s.fund && s.reached && !s.done) ? fundWaitEl(s) : null,
        // The "do this now" box sits INLINE on the step we're currently on.
        (state === "active" && action) ? action : null));
  }));
}

// Fork-pair replay acknowledgment: on bip110 the deposit prompt stays hidden behind a blocking modal
// until the sender checks "I understand replay protection" and clicks OK — once per swap, persisted
// so a reload doesn't re-ask. (The modal is rebuilt on every live update, so the in-progress checkbox
// state lives on `flow` to survive re-renders.)
const replayAckKey = (id) => `replay-ack-${id}`;
const replayAcked = (id) => { try { return localStorage.getItem(replayAckKey(id)) === "1"; } catch { return false; } };
const replayAckPending = (v, funded) => BRAND === "bip110" && !funded && !replayAcked(v.id);
function buildReplayAckModal(v, fundLeg) {
  const ok = h("button", { class: "primary", style: "width:100%;margin-top:16px", disabled: !flow._replayChk,
    onclick: () => { try { localStorage.setItem(replayAckKey(v.id), "1"); } catch {} flow._replayChk = false; rerender(); } }, t("replayAckOk"));
  const chk = h("input", { type: "checkbox", checked: !!flow._replayChk, style: "width:auto;margin:2px 9px 0 0;flex:0 0 auto",
    onchange: () => { flow._replayChk = chk.checked; ok.disabled = !chk.checked; } });
  return h("div", { class: "modal-back" },
    h("div", { class: "modal" },
      h("div", { style: "font-weight:640;color:var(--warn);font-size:15px" }, "⚠️ " + t("replayWarnTitle")),
      h("p", { class: "note", style: "margin-top:10px" }, t(fundLeg === "btc" ? "replayWarnSha" : "replayWarnBlake")),
      h("p", { class: "note dim", style: "margin-top:8px" }, t("replayWarnSplit")),
      h("label", { style: "display:flex;margin-top:16px;align-items:flex-start;gap:2px;font-size:13px;color:var(--fg);cursor:pointer" },
        chk, h("span", {}, t("replayAckLabel"))),
      ok));
}
function renderLive(card, v) {
  while (card.firstChild) card.removeChild(card.firstChild);
  // Backfill deal details from the coordinator view (authoritative) — on a resume from a backup file
  // the amount screen was skipped, so flow.role/btcSats/qbtSats would otherwise be unset (→ "0 BTC").
  if (v.role && !flow.role) flow.role = v.role;
  if (flow.role && !flow.direction) flow.direction = dirForRole(flow.role);
  if (v.terms) { flow.btcSats = flow.btcSats || v.terms.btcSats || 0; flow.qbtSats = flow.qbtSats || v.terms.qbtSats || 0; }
  const { send, recv } = roleCoins();
  const fundLeg = coinLeg(send), funded = v.funding?.[fundLeg];
  const addr = v.htlc?.[fundLeg]?.address;
  const canceled = v.state === "CANCELED";
  const terminal = v.state === "COMPLETE" || v.state === "REFUNDED" || canceled;
  const shorted = !terminal && !!v.shortFunded;   // a deposit came in below the agreed amount → swap dead (but the deposit is refundable)

  const headline = canceled ? t("swapCanceled")
    : v.state === "COMPLETE" ? t("swapComplete") : v.state === "REFUNDED" ? t("swapRefunded")
    : shorted ? t("underfundTitle")
    : !addr ? t("waitingCounterparty")
    : funded ? t(funded.unconfirmed ? "coinPending" : "coinLocked", { coin: send })
    : (v.fundGate && !v.fundGate.cleared) ? t("awaitingBtc")   // seller: sequenced funding holds them until BTC is sent — don't tell them to send yet
    : t("sendToLock", { coin: send });
  card.append(h("div", { style: "display:flex;justify-content:space-between;align-items:center" },
    h("h2", { style: "margin:0" }, headline),
    h("span", { class: "badge " + (shorted ? "bad" : STATE_CLASS[v.state] || "") }, shorted ? t("badgeCanceled") : v.state)));

  // Swap called off before anyone funded — show who cancelled and stop.
  if (canceled) {
    liveGuard = { risky: false };
    card.append(h("p", { class: "note", style: "margin-top:12px" }, v.canceled?.byYou ? t("cancelByYou") : t("cancelByCp")));
    return;
  }

  // While waiting for the counterparty, show the deal prominently.
  if (!terminal && !addr) {
    card.append(h("div", { style: "font-size:19px;font-weight:640;letter-spacing:-.01em;margin-top:14px;line-height:1.4" },
      t("sendingReceiving", { outAmt: `${sats(sendSats(v))} ${L(send)}`, inAmt: `${sats(coinSats(recv))} ${L(recv)}` }),
      " ",
      h("span", { class: "note", style: "font-weight:400;font-size:13px" }, t("minusFees"))));
    const fb = feeBreakdown(v); if (fb) card.append(fb);
  }

  if (v.securityError) { liveGuard = { risky: false }; card.append(h("p", { class: "note", style: "color:var(--bad);font-weight:600;margin-top:12px" }, t("securityErr"))); return; }

  if (!terminal) {
    // Three states: offline · online but still entering their details (present, no party data yet) · fully joined.
    const online = v.counterpartyOnline, joined = !!v.counterparty;
    card.append(h("div", { class: "note statusline", style: "margin-top:8px" },
      h("span", { class: `dot ${online ? "live" : "idle"}` }),
      !online ? t("cpOffline") : joined ? t("cpOnline") : t("cpEntering")));
  }
  // Safety net: once both legs are funded, the client pre-signs a fee-ladder claim + refund and the
  // coordinator (watchtower) finishes even if this tab closes. Until armed, warn against leaving.
  const bothFunded = v.funding?.btc && v.funding?.qbit, armed = v.safetyNet?.self;
  liveGuard = { risky: !terminal && !!v.funding?.[fundLeg] && !armed };
  if (!terminal && bothFunded) {
    card.append(h("div", { class: "note statusline", style: `margin-top:6px;color:${armed ? "var(--good)" : "var(--warn)"}` },
      h("span", {}, armed ? "🛡️" : "⏳"), armed ? t("armedNet") : t("armingNet")));
  }
  // Fork-pair replay twin: the coordinator spotted a replayed copy of OUR deposit on the other chain
  // (the send skipped replay protection). No user action — the watchtower sweeps it back automatically.
  const myTwin = v.twin?.[fundLeg];
  if (myTwin) card.append(h("p", { class: "note", style: "margin-top:8px;color:var(--warn)" },
    myTwin.resolved === "swept" ? t("twinSwept", { coin: L(send) }) : t("twinDetected", { coin: L(send) })));
  // Once armed, silently fold the pre-signed recovery ladder into the local vault. No SECOND download is
  // offered: the single backup taken at setup already holds the private keys, and the app regenerates the
  // claim/refund txs from those keys on resume — so one download is all the user ever needs.
  if (!terminal && armed && flow.client?.recovery && !flow._recoverySaved) { vault.save(flow.client.secrets()).catch(() => {}); flow._recoverySaved = true; }
  // Funding window: countdown anchored to the SERVER clock (v.now) so it's immune to a wrong client clock.
  if (v.now) flow._clockOffset = v.now - Date.now();
  const msLeft = (!funded && v.fundBy) ? v.fundBy - (Date.now() + (flow._clockOffset || 0)) : null;
  const expired = msLeft != null && msLeft <= 0;

  // The "do this now" box (expired · address-verification gate · sequenced-funding wait · deposit prompt).
  // It renders INLINE on the active timeline step below — not as a banner above the timeline — so the page
  // reads top-to-bottom and the action sits on the step we're actually on. It's null once there's nothing
  // to do (our own deposit is buried, or we're only waiting on the counterparty — the timeline says so).
  let action = null, replayAckModal = null;
  if (!terminal && addr && expired) {
    // The funding window elapsed — the timelocks were fixed at setup, so funding this late is no longer
    // safe. Refuse to show the deposit address; send them to make a fresh swap.
    action = h("div", { class: "fund" },
      h("div", { style: "font-size:16px;font-weight:600;color:var(--bad)" }, t("fundExpiredTitle")),
      h("p", { class: "note", style: "margin-top:6px" }, t("fundExpiredBody")),
      h("div", { class: "btns", style: "margin-top:14px" }, h("button", { class: "primary", style: "width:100%", onclick: () => goHome() }, t("verifyLeave"))));
  } else if (!terminal && addr && !funded && !flow.verified && !enteredAddrsHere(v.id)) {
    // Gate the deposit address behind an explicit address check — but ONLY when this browser didn't type
    // its own addresses (a resumed/forwarded link on a different device could carry tampered addresses).
    // The session that just entered its addresses already knows they're its own, so it skips the gate.
    action = h("div", { class: "fund" },
      h("div", { style: "font-size:16px;font-weight:600" }, t("verifyGateTitle")),
      h("p", { class: "note", style: "margin-top:6px" }, t("verifyGateSub")),
      h("div", { class: "btns", style: "margin-top:14px" }, h("button", { class: "primary", style: "width:100%", onclick: () => startVerify(v) }, t("beginVerify"))));
  } else if (!terminal && addr && !funded && v.fundGate && !v.fundGate.cleared) {
    // Sequenced funding: the QBT seller must not deposit until the buyer's BTC deposit is buried &
    // irreversible — otherwise the buyer could RBF-cancel the BTC after the QBT confirms, claim the QBT
    // (revealing the preimage), and leave this deposit's counterparty-claim spending a replaced-away UTXO.
    // Hold the deposit address; show progress toward clearance. (The buyer/alice is always cleared.)
    const g = v.fundGate;
    const status = !g.funded ? t("seqWaitNoBtc") : g.unconfirmed ? t("seqWaitMempool") : t("seqWaitConfs", { confs: g.confs, need: g.need });
    action = h("div", { class: "fund" },
      h("div", { style: "font-size:16px;font-weight:600" }, t("seqGateTitle")),
      // Body reflects reality: once the counterparty's deposit is SEEN (mempool or confirming), stop
      // saying "waiting for them to send" — it's sent, we're waiting on confirmations.
      h("p", { class: "note", style: "margin-top:6px" }, t(g.funded ? "seqGateBodySeen" : "seqGateBody")),
      h("p", { class: "note", style: "margin-top:10px;font-weight:600;color:var(--warn)" }, status));
  } else if (!terminal && addr && !fundBuried(v, fundLeg, funded) && replayAckPending(v, funded)) {
    // Fork-pair replay warning as its OWN blocking modal, BEFORE the deposit prompt: the swap's
    // settlement txs are replay-protected by the app, but the DEPOSIT comes from the user's wallet.
    // The "send exactly…" box stays hidden until they check "I understand" and click OK.
    replayAckModal = buildReplayAckModal(v, fundLeg);
  } else if (!terminal && addr && !fundBuried(v, fundLeg, funded)) {
    // Deposit prompt — shown while our leg is not yet buried (still to send, or sent and confirming).
    const feerate = Math.max(1, Math.round(v.feerates?.[fundLeg]?.fastestFee || 0));
    const minsLeft = msLeft != null ? Math.max(0, Math.ceil(msLeft / 60000)) : null;
    action = h("div", { class: "fund" },
      h("div", { class: "muted" }, funded ? t(funded.unconfirmed ? "coinPendingCheck" : "coinLockedCheck", { coin: send }) : t("sendExactly", { coin: send })),
      h("div", { style: "display:flex;align-items:center;gap:12px;flex-wrap:wrap" },
        h("div", { class: "amt" }, `${sats(sendSats(v))} ${L(send)}`),
        funded ? null : copyButton("copyAmount", "copiedCheck", () => amtStr(sendSats(v)))),   // copy button sits right next to the amount (not pushed to the far edge)
      feeBreakdown(v),
      // Deposit fee-rate guidance: the swap can't progress until this deposit confirms, so nudge the
      // sender to at least mempool's High-priority rate (BTC only — QBT is uncongested).
      (!funded && send === "BTC" && feerate > 1) ? h("p", { class: "note", style: "margin-top:6px" }, t("feeRateHint", { rate: feerate })) : null,
      // Staggered-funding expectation for the BTC buyer (who funds first): the seller deposits only after this confirms.
      send === "BTC" ? h("p", { class: "note", style: "margin-top:6px;color:var(--mut)" }, t(funded ? "seqBuyerFundedNote" : "seqBuyerNote")) : null,
      funded ? null : h("div", { class: "mono", style: "margin-top:6px" }, addr),
      funded ? null : h("div", { class: "btns" }, copyButton("copyAddress", "copiedCheck", () => addr)),
      (!funded && minsLeft != null) ? h("p", { class: "note", style: `margin-top:10px;color:${minsLeft <= 10 ? "var(--warn)" : "var(--mut)"}` }, t("fundCountdown", { mins: minsLeft })) : null);
  }

  // Persistent progress timeline — the primary structure — with the action box inlined on the current
  // step, so it's always clear which step we're on. Each step keeps its explorer tx link, incl. after
  // completion; its per-step "in mempool" tag surfaces 0-conf deposit detection on both legs.
  if (shorted) action = null;   // the "send exactly X" prompt is moot once an underfunded deposit exists — cross out the flow instead
  if (v.htlc) card.append(swapTimeline(v, send, recv, action, shorted));
  else if (action) card.append(action);   // pre-HTLC edge (addr implies htlc, so rare) — keep the action visible
  if (replayAckModal && !shorted) card.append(replayAckModal);   // blocking replay-protection ack (fixed overlay; sits above everything)
  // Bottom status line only when there's NO inline action box — otherwise it just repeats the prominent
  // in-timeline status (e.g. "waiting for the BTC deposit to confirm"). With an action shown, it's noise.
  if (!action && !shorted) card.append(h("p", { class: "note" }, statusLine(v, send, recv)));   // paused → the warning below is the status

  // A deposit confirmed so slowly that it's now unsafe to complete — the swap will refund on its own.
  if (!terminal && v.tooLate) card.append(h("p", { class: "note", style: "color:var(--warn);font-weight:600;margin-top:10px" }, t("tooLateRefund")));
  // Below the timeline: what the receiver nets after the claim fee, the invite-copy, and the back link.
  // All moot once paused (underfunded), so skip them then.
  if (!terminal && !shorted && v.feerates && v.htlc) {
    const { net, fee } = netReceive(recv, v.feerates, feeSats(v) > 0);
    card.append(h("p", { class: "note" }, fee > 0 ? t("netReceive", { net: sats(net), coin: recv, fee: feeStr(recv, fee) }) : t("netReceiveFull", { net: sats(net), coin: recv })));
  }
  if (!terminal && !shorted && flow.mode === "create" && flow.inviteLink) {
    card.append(h("div", { class: "btns", style: "margin-top:8px" }, copyButton("copyInvite", "inviteCopied", () => flow.inviteLink)));
  }
  if (!terminal && !addr && flow.mode === "create") {
    card.append(h("div", { style: "margin-top:14px" },
      h("a", { href: "#", style: "color:var(--mut)", onclick: (e) => { e.preventDefault(); stepShare(); } }, t("back"))));
  }
  if (shorted) {
    const legs = Object.keys(v.shortFunded);
    const rl = legs.find((leg) => v.refund?.[leg]?.short), r = rl ? v.refund[rl] : null;
    const mine = rl === fundLeg;   // the underfunded deposit is on MY funding leg → I'm the one who recovers it
    // The swap is dead for both sides. Say so plainly, then split: the underfunder gets a recovery counter,
    // the counterparty (nothing locked) just gets a "safe to leave".
    card.append(h("p", { class: "note", style: "color:var(--bad);font-weight:600;margin-top:12px" },
      mine ? t("underfundMine") : t("underfundCp"),
      mine ? ["  ", ...legs.map((leg) => v.shortFunded[leg]?.txid ? h("a", { href: EXPLORER[leg] + v.shortFunded[leg].txid, target: "_blank", rel: "noopener", style: "color:var(--accent);white-space:nowrap" }, t("viewDeposit")) : null)] : null));
    if (mine && r) {
      const coin = rl === "btc" ? "BTC" : "QBT";
      if (r.available) {
        card.append(h("p", { class: "note", style: "margin-top:10px;font-weight:600;color:var(--good)" }, t("shortRefunding", { coin })));
      } else {
        // Recovery is BLOCK-HEIGHT gated, so give a rough estimate (blocks remaining × the chain's block
        // time) rather than a false-precision ticking countdown — the real time depends on when blocks land.
        const blocks = Math.max(1, r.at - (v.heights?.[rl] || 0));
        const mins = blocks * (AVG_BLOCK[rl] || 600) / 60;
        const eta = mins < 90 ? `~${Math.round(mins / 5) * 5} min` : `~${Math.round(mins / 60 * 10) / 10} h`;
        card.append(h("p", { class: "note", style: "margin-top:10px" }, t("shortRecoverIn", { coin, eta, blocks })));
        // If the watchtower already holds his signed refund, he's covered even if he closes the tab; if not,
        // he must come back with his recovery file.
        card.append(v.safetyNet?.self
          ? h("p", { class: "note", style: "margin-top:4px;color:var(--good)" }, t("shortRecoverArmed", { coin }))
          : h("p", { class: "note", style: "margin-top:4px" }, t("shortRecoverReturn")));
      }
    }
    if (!mine) card.append(h("div", { class: "btns", style: "margin-top:14px" }, h("button", { class: "btn-ghost", style: "width:100%", onclick: () => goHome() }, t("startNewSwap"))));
  }
  if (v.actionError) card.append(h("p", { class: "note", style: "color:var(--bad)" }, "⚠ " + v.actionError));
  // Cancel only when NOTHING is on-chain (unfunded) — it clears a stale swap and the counterparty sees it.
  // An underfunded deposit can't be cancelled away (real funds are locked); it's refunded automatically above.
  if (!terminal && !v.funding?.btc && !v.funding?.qbit && !shorted) {
    card.append(h("div", { style: "margin-top:16px;text-align:center" },
      h("a", { href: "#", style: "color:var(--mut);font-size:13px", onclick: async (e) => {
        e.preventDefault(); if (!confirm(t("cancelConfirm"))) return;
        try { await flow.client.cancel(); } catch (err) { alert(err.message); }
      } }, t("cancelSwap"))));
  }
  // Keep the finished swap in the vault (marked done) rather than purging it, so reopening its link or
  // permalink resumes straight to this final status instead of the join flow. It's filtered out of the
  // "resume in-progress" list on the chooser.
  if (terminal && flow.client && !flow._doneSaved) { flow._doneSaved = true; vault.save({ ...flow.client.secrets(), done: true }).catch(() => {}); }
}

// ── address verification (defends a naive user handed a tampered link) ─────────
// Before the deposit address is ever shown, walk the user through confirming that the coins they will
// RECEIVE and any REFUND both land at addresses THEY control. Live re-renders are paused while verifying
// (the client keeps running; we just hold its onUpdate) and resumed on success.
function verifyAddr(v, which) {
  const { send, recv } = roleCoins(), self = flow.client?.view?.self || v.self || {};
  const coin = which === "receive" ? recv : send;
  const addr = which === "receive" ? (recv === "QBT" ? self.qbitDest : self.btcDest) : (send === "QBT" ? self.qbitDest : self.btcDest);
  return { coin, addr };
}
function startVerify(v) {
  flow._verifying = true;
  if (flow.client) flow.client.onUpdate = () => {};   // hold live re-renders during the steps
  renderVerify(v, "receive");
}
function renderVerify(v, which) {
  const { coin, addr } = verifyAddr(v, which);
  while (liveCard.firstChild) liveCard.removeChild(liveCard.firstChild);
  liveCard.append(
    h("div", { style: "font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)" }, t("verifyStep", { n: which === "receive" ? "1" : "2" })),
    h("h2", { style: "margin:6px 0 4px" }, which === "receive" ? t("verifyRecvTitle") : t("verifyRefundTitle")),
    h("p", { class: "note" }, which === "receive" ? t("verifyRecvSub", { coin }) : t("verifyRefundSub", { coin })),
    h("div", { class: "mono", style: "background:var(--panel2);padding:12px;border-radius:8px;word-break:break-all;font-size:13px;margin:14px 0;border:1px solid var(--line)" }, addr || "—"),
    h("p", { style: "font-weight:640;font-size:16px" }, which === "receive" ? t("verifyRecvQ", { coin }) : t("verifyRefundQ", { coin })),
    h("div", { style: "display:flex;gap:10px;margin-top:12px" },
      h("button", { class: "primary", style: "flex:1", onclick: () => (which === "receive" ? renderVerify(v, "refund") : verifyDone(v)) }, t("verifyYes")),
      h("button", { style: "flex:1", onclick: () => verifyFail() }, t("verifyNo"))));
}
function verifyDone(v) {
  flow.verified = true; flow._verifying = false;
  if (flow.client) flow.client.onUpdate = (vv) => renderLive(liveCard, vv);   // resume live updates
  renderLive(liveCard, flow.client?.view || v);
}
function verifyFail() {
  flow._verifying = false; liveGuard = { risky: false };
  while (liveCard.firstChild) liveCard.removeChild(liveCard.firstChild);
  liveCard.append(
    h("h2", { style: "color:var(--bad)" }, t("verifyFailTitle")),
    h("p", { class: "note", style: "margin-top:4px" }, t("verifyFailBody")),
    h("div", { class: "btns", style: "margin-top:14px" }, h("button", { class: "primary", style: "width:100%", onclick: () => goHome() }, t("verifyLeave"))));
}
function statusLine(v, send, recv) {
  const amCreator = flow.mode !== "join";     // I created/shared the swap (drives the "waiting to be joined" copy)
  const amInitiator = flow.role === "alice";  // I hold the secret and claim first (the QBT buyer)
  if (!v.htlc) return amCreator ? t("stWaitJoin") : t("stSetup");
  switch (v.state) {
    case "COMPLETE": return t("stReceived", { amt: sats(netReceive(recv, v.feerates, feeSats(v) > 0).net), coin: recv });   // net of the on-chain claim fee (the gross was never what landed)
    case "REFUNDED": return t("stReturned", { coin: send });
    case "CLAIMABLE": return amInitiator ? t("stBothFunded") : t("stWaitClaim");
    case "MATURING": return t("stMaturing");
    case "CLAIMED": return amInitiator ? t("stClaimed") : t("stPreimage");
    default: {
      // Staggered funding: reflect what we're actually waiting on, not a generic prompt. BTC (fromLeg)
      // must bury before the seller can fund QBT, so neither "send your deposit" nor "waiting for your
      // counterparty to fund" is right until that happens.
      const myFund = v.funding?.[coinLeg(send)];
      const btcBuried = fundBuried(v, v.roles?.fromLeg || "btc", v.funding?.[v.roles?.fromLeg || "btc"]);
      if (amInitiator) return !myFund ? t("stWaitDeposit") : !btcBuried ? t("stConfirmingBtc") : t("stWaitFund");
      return !btcBuried ? t("stAwaitCpBtc") : !myFund ? t("stWaitDeposit") : t("stWaitSettle");
    }
  }
}

// ── resume from vault / backup ────────────────────────────────────────────────
function resumeSwap(secrets) {
  flow.role = secrets.role;                      // alice = QBT buyer/initiator, bob = QBT seller
  flow.direction = dirForRole(secrets.role);
  flow.mode = "join";                            // resume never re-shares (the invite link isn't in the backup)
  flow.coordinator = secrets.coordinator;
  flow.client = mkClient({ coordinator: secrets.coordinator }).restore(secrets);
  startLive();
}

// ── files + drag/drop restore ─────────────────────────────────────────────────
function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0]; if (!file) return;
  try { resumeSwap(importBackup(await file.text())); } catch (err) { alert(t("errRestore", { msg: err.message })); }
});

// ── API reference page (linked from the header) ───────────────────────────────
// Each endpoint: [method, path, descKey, auth?] — auth is "" (public), "tok" (per-swap X-Swap-Token),
// "mtok" (order-book makerToken), or "key" (RFQ X-Maker-Key). The chip on the right mirrors it.
const API_AUTH = { "": ["apiAuthPublic", ""], tok: ["apiAuthToken", "tok"], mtok: ["apiAuthMakerTok", "tok"], key: ["apiAuthMakerKey", "key"] };
const API_GROUPS = [
  { head: "apiSecPublic", eps: [["GET", "/health", "apiHealth"], ["GET", "/feerates", "apiFeerates"], ["GET", "/trades", "apiTrades"]] },
  { head: "apiSecRfq", eps: [["GET", "/rfq", "apiRfqDepth"], ["GET", "/rfq/quote", "apiRfqQuote"], ["POST", "/rfq/take", "apiRfqTake"], ["GET", "/rfq/plan", "apiRfqPlan"], ["POST", "/rfq/order", "apiRfqOrder"], ["POST", "/rfq/maker", "apiRfqMaker", "key"]] },
  { head: "apiSecBook", eps: [["GET", "/offers", "apiBook"], ["POST", "/offers", "apiPostOffer"], ["POST", "/offers/:id/take", "apiTake"], ["GET", "/offers/:id", "apiMakerView", "mtok"], ["POST", "/offers/:id/cancel", "apiCancelOffer", "mtok"]] },
  { head: "apiSecSwap", eps: [["POST", "/swaps", "apiCreateSwap"], ["GET", "/swaps/:id", "apiView", "tok"], ["GET", "/swaps/:id/events", "apiEvents", "tok"], ["POST", "/swaps/:id/party", "apiParty", "tok"], ["POST", "/swaps/:id/broadcast", "apiBroadcast", "tok"], ["POST", "/swaps/:id/finish", "apiFinish", "tok"], ["POST", "/swaps/:id/cancel", "apiCancelSwap", "tok"], ["GET", "/swaps/:id/beat", "apiBeat", "tok"]] },
];
const LOCK_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
function stepApi() {
  if (rerender !== stepApi) _prevView = rerender;
  rerender = stepApi;
  const back = () => { rerender = _prevView || (() => init()); rerender(); };
  markScreen(back, "/api");
  const ep = ([m, path, dk, auth = ""]) => {
    const [chipKey, chipClass] = API_AUTH[auth] || API_AUTH[""];
    return h("div", { class: "api-ep" },
      h("span", { class: "api-m " + m.toLowerCase() }, m),
      h("div", { class: "row1" }, h("code", { class: "api-path" }, path), h("span", { class: "api-auth " + chipClass }, t(chipKey))),
      h("div", { class: "api-desc" }, t(dk)));
  };
  render(h("div", { class: "page" },
    pageHead(t("apiTitle"), back),
    h("p", { class: "page-intro" }, t("apiIntro")),
    h("div", { class: "api-base" }, h("span", { class: "lbl" }, "Base URL"), h("span", { class: "url" }, DEFAULT_COORD)),
    h("div", { class: "api-authbox" }, h("span", { class: "ico", html: LOCK_SVG }), h("p", { html: t("apiAuthNote") })),
    h("div", { class: "api-groups" }, ...API_GROUPS.map((g) => h("section", { class: "api-card" },
      h("div", { class: "api-card-head" }, h("h3", {}, t(g.head)), h("span", { class: "count" }, t("apiEpCount", { n: g.eps.length }))),
      ...g.eps.map(ep)))),
  ));
}

// ── language switcher (header) ────────────────────────────────────────────────
function renderChrome() {
  const info = document.getElementById("info-link"); if (info) info.textContent = t("infoTab");
  const apiL = document.getElementById("api-link"); if (apiL) apiL.textContent = t("apiTab");
  const trades = document.getElementById("trades-link"); if (trades) trades.textContent = t("tradesTab");
  const el = document.getElementById("lang"); if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const [code, label] of LANGS) {
    el.append(h("a", { href: "#", "aria-current": getLang() === code ? "true" : "false",
      onclick: (e) => { e.preventDefault(); if (getLang() !== code) { setLang(code); syncLangUrl(); renderChrome(); histSuppress = true; try { rerender(); } finally { histSuppress = false; } } } }, label));
  }
}

// Clicking the Qbit logo clears the current flow and returns to the home screen.
function goHome() {
  flow.client?.stop?.(); stopJoinHeartbeat(); clearInterval(flow._tick);
  Object.assign(flow, { mode: null, role: null, direction: null, btcSats: 0, qbtSats: 0, receiveAddr: "", refundAddr: "", client: null, inviteLink: null, fee: null, verified: false, _recoverySaved: false });
  liveGuard = { risky: false };
  if (location.hash || location.pathname !== "/") history.replaceState(null, "", "/" + location.search);   // drop any #hash or /page permalink
  stepWelcome();   // always return to the hero landing, not the direction chooser
}
for (const sel of ["header .mark", "header h1"]) document.querySelector(sel)?.addEventListener("click", goHome);
document.querySelector("#info-link")?.addEventListener("click", (e) => { e.preventDefault(); stepInfo(); });
document.querySelector("#api-link")?.addEventListener("click", (e) => { e.preventDefault(); stepApi(); });
if (RECENT_TRADES) {
  const tl = document.getElementById("trades-link"), il = document.getElementById("info-link");
  if (tl) { tl.style.display = ""; tl.style.marginLeft = "auto"; if (il) il.style.marginLeft = "0"; tl.addEventListener("click", (e) => { e.preventDefault(); stepTrades(); }); }
}

// Reflect the active language in the address bar so a copied/shared link carries it (zh → ?lang=zh;
// English stays a clean URL). Preserves the nav-history state and the invite hash.
function syncLangUrl() {
  const u = new URL(location.href);
  if (getLang() === "en") u.searchParams.delete("lang"); else u.searchParams.set("lang", getLang());
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}

// A fresh invite link pasted into an ALREADY-OPEN tab only changes the URL hash (no page reload), so
// the initial init() never sees it. Re-enter the flow on hashchange when the new hash is an invite.
window.addEventListener("hashchange", () => { const q = parseHash(); if (q.coord && q.id && q.token) init(); });
renderChrome();
init();
syncLangUrl();
