// Order book on top of the swap engine. A maker posts an offer (one lot): "I give X, I want Y". The
// book is public; a taker clicks an offer to take it, which instantiates a swap from the offer's terms.
// The initiator (alice, holds the secret) is ALWAYS the QBT buyer — so we hand the alice token to
// whichever side (taker or maker) is buying QBT, not automatically to the taker. The maker retrieves
// the take with its maker token and fulfills the other side. The coordinator stays keyless.
//
// Pair orientation: QBT priced in BTC (price = BTC per QBT).
//   ask = maker sells QBT for BTC (gives QBT, wants BTC)   — a taker "buys QBT"
//   bid = maker buys QBT with BTC (gives BTC, wants QBT)   — a taker "sells QBT"
import { randomBytes } from "node:crypto";
import { createSwap } from "./swap.js";

const offers = new Map();
const token = () => randomBytes(16).toString("hex");
const COINS = new Set(["BTC", "QBT"]);
const OFFER_TTL_MS = Number(process.env.OFFER_TTL_MS || 86_400_000);   // 24h: stale offers expire and are swept

export function createOffer({ giveCoin, giveSats, wantCoin, wantSats }) {
  if (!COINS.has(giveCoin) || !COINS.has(wantCoin) || giveCoin === wantCoin) throw new Error("pair must be one of BTC/QBT for each side");
  if (!(giveSats > 0) || !(wantSats > 0)) throw new Error("giveSats and wantSats required");
  const qbtSats = giveCoin === "QBT" ? giveSats : wantSats;
  const btcSats = giveCoin === "BTC" ? giveSats : wantSats;
  const o = {
    id: token(), makerToken: token(),
    side: giveCoin === "QBT" ? "ask" : "bid",
    giveCoin, giveSats, wantCoin, wantSats,
    qbtSats, btcSats, price: btcSats / qbtSats,   // BTC per QBT
    status: "open", createdAt: Date.now(), take: null,
  };
  offers.set(o.id, o);
  return o;
}
export const getOffer = (id) => offers.get(id);
export const allOffers = () => [...offers.values()];   // admin/monitoring: every offer, any status
export const isMaker = (o, tok) => tok && tok === o.makerToken;

// Expire stale open offers so an abandoned offer doesn't sit in the book (and in memory) forever.
// Called periodically from the server's watcher tick; safe to call any time.
export function sweepOffers() {
  const now = Date.now();
  for (const [id, o] of offers) if (o.status === "open" && now - o.createdAt > OFFER_TTL_MS) offers.delete(id);
}

const publicFields = (o) => ({ id: o.id, side: o.side, giveCoin: o.giveCoin, giveSats: o.giveSats, wantCoin: o.wantCoin, wantSats: o.wantSats, qbtSats: o.qbtSats, btcSats: o.btcSats, price: o.price, createdAt: o.createdAt });
// Public book: open offers, best price first (asks ascending, bids descending).
export function book() {
  const open = [...offers.values()].filter((o) => o.status === "open").map(publicFields);
  const asks = open.filter((o) => o.side === "ask").sort((a, b) => a.price - b.price);
  const bids = open.filter((o) => o.side === "bid").sort((a, b) => b.price - a.price);
  return { asks, bids };
}

// Take an open offer -> instantiate a swap (always btc2qbt). The QBT BUYER gets the alice/initiator
// token: an ask means the maker sells QBT, so the TAKER buys QBT (taker=alice); a bid means the maker
// buys QBT, so the MAKER is the buyer (maker=alice, taker=bob). Each side is told its role.
export function takeOffer(o) {
  if (o.status !== "open") throw new Error("offer is not open");
  const takerBuysQbt = o.side === "ask";                 // ask = maker sells QBT → taker buys QBT
  const takerRole = takerBuysQbt ? "alice" : "bob", makerRole = takerBuysQbt ? "bob" : "alice";
  const swap = createSwap({ btcSats: o.btcSats, qbtSats: o.qbtSats, securityLevel: "high" });
  o.status = "taken";
  o.take = { swapId: swap.id, makerSwapToken: swap.tokens[makerRole], makerRole, takenAt: Date.now() };
  return { swapId: swap.id, takerToken: swap.tokens[takerRole], role: takerRole, terms: swap.terms };
}
export function cancelOffer(o) { if (o.status === "open") o.status = "cancelled"; return o; }
// Maker view (auth'd): includes the take so the maker can fulfill (its swap token).
export const makerView = (o) => ({ id: o.id, side: o.side, status: o.status, giveCoin: o.giveCoin, giveSats: o.giveSats, wantCoin: o.wantCoin, wantSats: o.wantSats, price: o.price, take: o.take });
