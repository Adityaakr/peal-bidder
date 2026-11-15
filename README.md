# Peal Bidder

An AI agent that bids in Peal sealed auctions for its owner, inside limits that QoreChain itself enforces. It acts only on mandates the owner has signed with a post-quantum key (ML-DSA-87) and sealed to the agent (ML-KEM-1024).

Entry in the **Post-Quantum AI Agents** category of QoreChain's *Build Before Q-Day* developer fest. It is one of three linked entries: [Peal Sealed Auction](https://github.com/Adityaakr/peal-sealed-auction) is the venue, [Peal Tender](https://github.com/Adityaakr/peal-tender) is the treasury that runs buybacks through it, and this repository is the participant. All three use [qore-pq-kit](https://github.com/Adityaakr/qore-pq-kit).

> **Status (16 November 2026):** the offline core is built and tested: the mandate format, owner-side signing and sealing, agent-side verification against the owner's on-chain key, the policy clamp, the planner (Claude Opus 5.5 with a rule-based fallback) and the signed receipts log. The chain side (linked key, spending rules, scoped window, relayer) and the dashboard come next; see [Roadmap](#roadmap). Nothing is deployed yet.

## How it stays inside its mandate

```
 Owner ── PealMandate v1 ──▶ signed: QoreSign hybrid (secp256k1 + ML-DSA-87)
                             sealed: QoreSeal to the agent's ML-KEM-1024 key
                                          │
                                          ▼
 Agent ── open ─▶ verify against the owner's ML-DSA-87 key read on chain (pqcKeyStatus)
          │       refuse: forged, altered, expired, replayed, other chain, other agent …
          ▼
          plan ─▶ Claude Opus 5.5 (structured output)  ── or ──  rule-based fallback
          │       auction text is untrusted data, never instructions
          ▼
          clamp ─▶ deterministic policy: auction in mandate, tick ≤ max, escrow + bond ≤ per-bid
          │        and remaining budget, bid count, validity window
          ▼
          submit ─▶ the chain enforces again: spending rule on the owner's smart account,
          │         scoped EVM window, fUSD allowance                              (next PR)
          ▼
          receipt ─▶ hash-chained, ML-DSA-87-signed log of every decision
```

Layers, from the outside in:

1. **The chain** (next PR): a spending rule on the owner's account that bounds the agent's linked key (fUSD only, per-transaction and daily limits, only `commitBid` on the auction, an expiry); a scoped EVM window with target, transaction-count, value and duration limits; an fUSD allowance equal to the budget.
2. **The key split**: the agent holds only its classical key and its decryption key. The owner holds the agent account's ML-DSA-87 key, so only the owner can open the agent's windows, link its key or change its rules. The agent cannot raise its own limits.
3. **The mandate**: authenticated instructions. The agent refuses anything not signed by its owner's on-chain key.
4. **The policy**: whatever the planner says, the bid fits the mandate.

## What is in this repository

| Path | What it does |
|---|---|
| `common/mandate.ts` | PealMandate v1: fields, validation, canonical encoding, hash, sign bytes, seal AAD ([format](docs/mandate.md)) |
| `common/canonical.ts` | Canonical JSON: one encoding per value, so a signature over bytes is a signature over the value |
| `owner-cli/mandate.ts` | Owner side: `signMandate` (QoreSign `signMessage`, hybrid) and `sealMandate` (QoreSeal, hybrid ML-KEM-1024 + X25519) |
| `agent/inbox.ts` | Agent side: `receiveMandate` opens, verifies and accepts or refuses with one of 15 stable codes |
| `agent/keysource.ts` | Reads the owner's ML-DSA-87 key from the `pqcKeyStatus` precompile by `eth_call`; fails closed |
| `agent/store.ts` | Highest accepted nonce per owner (refuses replays and rollbacks) |
| `agent/policy.ts`, `agent/auction.ts` | The deterministic clamp and the auction's price arithmetic |
| `agent/planner/` | Claude Opus 5.5 planner, rule-based planner, and `decide` (planner then policy) |
| `agent/receipts.ts` | The receipts log: hash-chained, signed with the agent's ML-DSA-87 receipt key |
| `agent/agent.ts` | The loop: receive, read auctions, plan, clamp, submit, receipt; rebuilds its ledger from the receipts after a restart |
| `scripts/demo-offline.ts` | The whole flow with throwaway keys in memory, no chain, no funds |
| `test/` | 119 offline tests and 3 live planner checks (Vitest and fast-check); see below |

## Running it

Needs Node 22 and pnpm 10.

```sh
pnpm install
pnpm test           # offline; no key, no network
pnpm typecheck
pnpm demo:offline   # the mandate channel and planner end to end, with throwaway keys
```

The planner uses Claude only when `ANTHROPIC_API_KEY` is set in the environment. The key is never read from or written to a file in this repository. Without it, the rule-based planner runs. With it, `pnpm test` also runs three live planner checks (a few cents), and `pnpm record:claude` records real responses into `test/fixtures/claude-recorded/` for the replay tests.

## Tests

- **Mandate verification** (`test/inbox.test.ts`, 29 cases): a valid mandate, and each refusal: forged signature, the owner's public key with someone else's signature, an ML-DSA key other than the one on chain, a right classical key with a wrong ML-DSA signature, tampered limits, tampered instructions, expired, not yet valid, replayed, rolled back, other chain, other EVM chain id, a signature made for another chain, an envelope sealed under another chain, sealed to another agent, another agent's mandate forwarded, an envelope bound to another owner, an owner the agent does not serve, classical-only signature, no key on chain, RPC failure, non-canonical text, duplicate keys, inconsistent limits, an extra field, a wrong receipt key, and malformed envelopes and payloads.
- **On-chain key reading** (`test/keysource.test.ts`): selector, the 2,752-byte reply, and failing closed on no key, another algorithm, unproven possession, wrong length, empty or malformed data and RPC errors.
- **Policy** (`test/policy.test.ts`): every clamp and skip rule, junk proposals, and a fuzz property over 2,000 random planner outputs and ledgers that no bid ever leaves the mandate.
- **Planner** (`test/planner.test.ts`): the request (model, effort, structured output, fallbacks), the untrusted-text framing, and fixtures including **prompt-injection** cases: an "ignore your mandate" override that the model resists, one it obeys toward another auction (skipped, never redirected), one it obeys on size and tick (clamped), and a fake owner tag. Refusal, prose, schema-violating and truncated answers fall back to the rules.
- **Receipts** and **agent loop** (`test/receipts.test.ts`, `test/agent.test.ts`): tampering, deletion, reordering, a wrong key, file permissions, restart recovery, unknown outcomes counted as spent.

The planner fixtures in `test/fixtures/claude/` are hand-written in the shape of API responses (each says so in its `provenance` field), because the owner's API key is not available yet. Recorded responses will join them in `test/fixtures/claude-recorded/`.

## Network

QoreChain testnet `qorechain-diana`, EVM chain id 9800. Quote and budget token: the fest's fUSD (`0x97143B771D34ddb9130b807b135Ae675A5a963CA`, 6 decimals). Contract addresses will be listed here when deployed.

## Roadmap

1. ~~Mandate format, signing and sealing, verification, policy, planner, receipts~~ (this PR).
2. Owner CLI: create and seal a mandate from the owner's keys, link and revoke the agent key, set spending rules, open and close the agent's window, approve fUSD. Relayer for `MsgExecuteEVM`. Dashboard of mandates, decisions and refusals.
3. The smart-account path depends on spike S2 in qore-pq-kit (a linked key executing an EVM call under a spending rule has no recorded end-to-end run). If it fails, bids go from the agent's own account inside owner-opened scoped windows, with the allowance and the auction's caps ([docs/spikes.md](docs/spikes.md)).
4. Integration with Peal Sealed Auction's deployed contracts (expected 22 to 23 November): bid sealing to the committee with qore-pq-kit's `threshold` module, and a testnet run with one landed bid and each refusal.

## Prior work

The design comes from the author's own earlier project, **Peal** (private, started 6 July 2026, Apache-2.0). Everything in this repository was written during the fest. Rules ported from Peal, rewritten here:

- The auction price and escrow arithmetic in `agent/auction.ts` (`price(tick) = reservePrice + tick × tickSize`, escrow rounded up) follows Peal's `contracts/src/auctionkit/AuctionMath.sol`, so the agent computes the same escrow as the auction contract.

## Credits

- [@qorechain/qoresign](https://www.npmjs.com/package/@qorechain/qoresign) 0.2.0 (hybrid message signatures) and [@qorechain/qoreseal](https://www.npmjs.com/package/@qorechain/qoreseal) 0.1.0 (ML-KEM-1024 envelopes), QoreChain's kits.
- [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) for Claude; [viem](https://viem.sh) for the EVM calls; [@noble/hashes](https://github.com/paulmillr/noble-hashes) and [@scure/bip39](https://github.com/paulmillr/scure-bip39); [Vitest](https://vitest.dev) and [fast-check](https://fast-check.dev) for tests.

How AI was used to build this: [AI_USAGE.md](AI_USAGE.md). Security assumptions and what is not protected: [THREAT_MODEL.md](THREAT_MODEL.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
