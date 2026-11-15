# Spikes and testnet findings

QoreChain's testnet changes quickly and its docs disagree with each other in places, so details the Bidder depends on are settled by experiment and recorded here, dated. Throwaway accounts only; never the drill account or the drill contracts.

## What the Bidder depends on

| # | Question | Who runs it | Status | Effect on the Bidder |
|---|---|---|---|---|
| S2 | Can a secp256k1 key linked to the owner's smart account execute an EVM call (`MsgExecuteEVM`) under a spending rule with `allowedEvmCalls` and fUSD `denomLimits`? Does an over-limit call return `success=false`, and an off-target call get refused? Which nonce does it take? | qore-pq-kit worker | **Pending** (18 November) | If it works: bids go through the owner's smart account (`qore-pq-kit` `smart-account` module, used by tag). If not (design report section 9, R1): bids go from the agent's own account inside owner-opened scoped windows, with the fUSD allowance and the auction's caps; spending rules are shown on a plain fUSD transfer |
| R2 | Does `MsgExecuteEVM` also need the owner account's live EVM window? | qore-pq-kit worker (S2) | **Pending** | Only the demo narrative changes |
| S1/R3 | Is the fourth word of `pqcKeyStatus` "possession proven"? | qore-pq-kit worker | **Pending**; the design report observed the four-word reply live | `agent/keysource.ts` requires it to be true. If its meaning differs, possession is checked over REST at setup instead |
| S5 | Does faucet fUSD arrive as the ERC-20 balance or as the bank coin `erc20:0x9714…`? | qore-pq-kit worker | **Pending** | Whether the owner CLI must convert before approving |

## Findings

### 2026-11-16: offline only

No testnet calls yet from this repository. Facts relied on, from the approved design report (Appendix A, read-only probes on 15 November 2026):

- `pqcKeyStatus(address)` (selector `0x850dfe51`) at `0x…0a02` returned 2,752 bytes for a registered account: `(bool, uint8, bytes, bool)` with a 2,592-byte key. `test/keysource.test.ts` checks the decoder against exactly that layout.
- fUSD is `0x97143B771D34ddb9130b807b135Ae675A5a963CA`, 6 decimals, denom `erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA`.
- PQC params: `allow_classical_fallback: false`, `hybrid_signature_mode_name: required`.
