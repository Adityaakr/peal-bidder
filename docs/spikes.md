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

### 2026-11-15 (UTC): read-only checks from this repository

Run: `pnpm agent receive` (default, chain mode) and `pnpm owner status` against fresh, unfunded throwaway accounts made in a scratch folder; and one raw `eth_call`. No transaction was sent.

- **`pqcKeyStatus` for an account with no key** returns data, not an empty reply: 160 bytes at block 10,160,506, the words `(false, 0, offset 0x80, false)` and a zero-length key. `agent/keysource.ts` decodes it and refuses the mandate with `OWNER_KEY_UNAVAILABLE (KEY_NOT_REGISTERED)`, as intended. (Empty data is still refused, as `KEY_UNAVAILABLE`.)
- **The abstract-account routes answer 404 for an account the chain has never seen** (`/qorechain/abstractaccount/v1/accounts/{addr}/authenticators` and `/spending_rules`: "account … not found"). `owner status` reports the error instead of failing.
- **The SDK 0.14.0 has no explorer URL for the testnet** (`explorerTxUrl` throws). The dashboard links transactions to the REST route `/cosmos/tx/v1beta1/txs/{hash}`, or to `QORE_EXPLORER_TX_URL` when set.

### Waiting on funds

The owner, agent-account and relayer accounts (README, Network) are not funded yet. The request went to the owner on 15 November (UTC); funds come from the owner's faucet sign-in. Until then the commands that send transactions (`register`, `register-agent`, `window`, `approve`, `link`, `rules`, `revoke`, the relayer) are tested offline only.
