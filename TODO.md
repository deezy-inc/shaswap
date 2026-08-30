# TODO

## ✅ DECIDED (2026-07-23): RFQ fees are taker-pays; peer link swaps keep buyer-pays

Danny's call: charge the platform fee to the **taker** in the retail-vs-market-maker (RFQ) setup —
the standard model everywhere (takers buy immediacy; charging makers just widens quoted spreads) —
and keep the existing buyer-pays structure for mutually-agreed link swaps.

**Implemented** (rfq.js `derive()` + swap.js `takerNetOfGross`/`feeTotalOn`; engine mechanics — the
fee output riding the BTC leg — untouched):
- RFQ **buy**: taker is the BTC sender, so the normal gross-up (`terms + fee` on top) already charges
  the taker; the maker receives `terms.btcSats` in full. Unchanged.
- RFQ **sell**: the quote nets the fee out of the taker's BTC proceeds
  (`terms.btcSats = takerNetOfGross(size × bid)`), so the maker's all-in outlay (`terms + fee`)
  equals exactly its quoted price × size. The widget discloses the net under the receive panel.
- Peer link swaps (and the flagged order book): buyer-pays, exactly as before.

Locked by `coordinator/rfq_fee.test.mjs`.

## Follow-ups: fork-pair (CHAIN2=bip110) generalization — 2026-08-30

- **Fork-side replay protection**: implement the fork's opt-in `SIGHASH_UNIFIED` (Knots PRs 357-359)
  in the client lib once a released fork client stabilizes it. Until then the documented discipline is
  post-fork (split) coins on the fork leg; BTC-side sweeps are marker-protected + enforced.
- **Webapp cosmetics for non-qbit pairs**: the UI still displays "QBT" in i18n strings (the engine +
  signing are fully generalized; `view.chains.qbit.label` is available). Swap the display ticker
  through i18n interpolation before running the bip110 pair with real retail users. Same-hrp ("bc" on
  both legs) address validation in main.js `addressOnNetwork` also needs a pair-aware pass — with both
  legs on "bc" it can't tell the chains apart (funds sent to the right address on the wrong chain).
- **Maker-bot light mode** on a bip110 pair: the Core-RPC wallet path works as-is (fork node speaks
  Core RPC); light/lightwallet.js's second-slot branch is p2mr-only today — needs a p2wsh single-key
  variant for a node-less fork maker.
- **Live validation**: the e2e proves the protocol over mock chains; before real funds, run one
  small-value swap against a real Core node + fork node pair (regtest Knots build or mainnet-small),
  and verify a marked sweep is genuinely refused by a fork-policy node.
