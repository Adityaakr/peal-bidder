# Spikes and testnet findings

QoreChain's testnet changes quickly and its docs disagree with each other in places, so details the Bidder depends on are settled by experiment and recorded here, dated. Throwaway accounts only; never the drill account or the drill contracts.

## What the Bidder depends on

| # | Question | Who runs it | Status | Effect on the Bidder |
|---|---|---|---|---|
| S2 | Can a secp256k1 key linked to the owner's smart account execute an EVM call (`MsgExecuteEVM`) under a spending rule? Over-limit and off-target calls? Nonce? | qore-pq-kit worker | **Settled, 16 Nov** ([qore-pq-kit#7](https://github.com/Adityaakr/qore-pq-kit/pull/7)): yes. The call runs as the owner's 0x address; over the per-execution limit and off the allowlist come back `success=false` in a code-0 transaction and spend the key's nonce; a replay is refused at delivery and the relayer still pays. **Not yet exercised:** ERC-20 `denomLimits` (the Bidder's fUSD limits) and the key's expiry | The Bidder bids through the owner's smart account (`--executor smart-account`), with qore-pq-kit `v0.4.0`'s `smart-account` module. Design R1 (the window fallback) is retired; `--executor window` stays for comparison |
| R2 | Does `MsgExecuteEVM` also need the owner account's live EVM window? | qore-pq-kit worker (S2) | **Settled, 16 Nov**: no | The owner opens no window; the spending rule and the fUSD allowance bound the agent |
| S1/R3 | Is the fourth word of `pqcKeyStatus` "possession proven"? | qore-pq-kit worker | **Settled, 16 Nov**: yes; a registration without a proof reads `false` | `agent/keysource.ts` requires it to be true, as written |
| S5 | Does faucet fUSD arrive as the ERC-20 balance or as the bank coin `erc20:0x9714…`? | qore-pq-kit worker | **Partly settled, 16 Nov**: as bank coins; ERC-20 `balanceOf` reads 0 until `MsgConvertCoin`. A claim to a scripted address failed on the faucet side | `pnpm owner convert --amount 500` before `approve` |

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

### 2026-11-16: the auction's interface

Peal Sealed Auction's contracts were merged (read at `f502616`). The agent's copy of the interface (`agent/auction-abi.ts`) is checked against them by hand. One correction followed: `commitBid` takes `uint32 seq`, not the `uint64` the design sketched, so the spending rule's allowed call is `commitBid(uint32,bytes32,bytes32,bytes32[],bytes[],uint256)`. No testnet deployment of the auction exists yet, so the bid path is tested against a fake chain only.

### 2026-11-16 (UTC): live setup of the Bidder's accounts

The owner funded the accounts (owner 115 QOR + 1,400 fUSD as bank coins; agent account and relayer 10 QOR each). Then, from this repository:

| Step | Command | Transaction |
|---|---|---|
| Owner's ML-DSA-87 key | `pnpm owner register` | `41A99E6D4121FCCBCFCB35EE723E8C51316164168DC9E84A9DB23CDC090AE5F8` |
| Agent account's ML-DSA-87 key | `pnpm owner register` | `DC3E3F913EBFCD2EBFF19A9619A41A63793121B0597E6A657B24B163681B4DE5` |
| Relayer's ML-DSA-87 key | `pnpm owner register` | `1C13DC5BB36044B91A41938391784AE7EC24FF7E50BD382152C8A0301D9D79B8` |
| Agent's ML-KEM-1024 key (hybrid-signed with the agent account's keys, held by the owner) and its signed recipient card | `pnpm owner register-agent` | `69839690D23D28D74DDC1569E8038AF15FD986C25FF881C04207F4C89B7EC325` |
| 400 fUSD from bank coins to ERC-20 on the owner | `pnpm owner convert --amount 400` | `3D32143F1F45CE7E1BB06ED361BB3B176E00939FDB521C6438027AA379FD8520` |

Read back afterwards with `eth_call` to `pqcKeyStatus`: the owner and the agent account each report registered, algorithm 1 (ML-DSA-87), possession proven, a 2,752-byte reply. `balanceOf` on fUSD reads 400 for the owner; 1,000 fUSD stays as bank coins. The owner spent 0.3 QOR on these steps (0.15 QOR per hybrid transaction, as the kit's fee).

### 2026-11-16 (UTC): the planner through OpenRouter

One live request to `anthropic/claude-opus-5.5` on OpenRouter, for the "injection-resisted" scenario (`pnpm record:openrouter injection-resisted`): HTTP 200, `finish_reason: stop`, a schema-valid proposal (tick 15, inside the mandate), a rationale saying the issuer text tried to override the mandate, 1,961 tokens in and 182 out, $0.011. Recorded in `test/fixtures/openrouter-recorded/`.
