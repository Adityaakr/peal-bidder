# Peal Bidder

An AI agent that bids in Peal sealed auctions for its owner, inside limits that QoreChain itself enforces. It acts only on mandates the owner has signed with a post-quantum key (ML-DSA-87) and sealed to the agent (ML-KEM-1024).

Entry in the **Post-Quantum AI Agents** category of QoreChain's *Build Before Q-Day* developer fest. It is one of three linked entries: [Peal Sealed Auction](https://github.com/Adityaakr/peal-sealed-auction) is the venue, [Peal Tender](https://github.com/Adityaakr/peal-tender) is the treasury that runs buybacks through it, and this repository is the participant. All three use [qore-pq-kit](https://github.com/Adityaakr/qore-pq-kit).

> **Status (16 November 2026):** built and tested offline: the mandate channel, the policy clamp, the planner (Claude Opus 5.5 with a rule-based fallback), the signed receipts log, the owner CLI, the relayer, the dashboard, and the bid itself: sealed to the auction's committee with qore-pq-kit's `threshold` module and encoded for Peal Sealed Auction's `commitBid`, then sent either through the owner's smart account or (the fallback) from the agent's own account inside an owner-opened window. The smart-account path is proven on the testnet by spike S2 in qore-pq-kit, and its mechanics now come from qore-pq-kit `v0.4.0`. This repository's own chain-side commands have **not yet run on the testnet**: the accounts are waiting for faucet funds and the auction is not deployed yet. The fUSD (ERC-20) spending limits are the one part S2 did not exercise ([docs/spikes.md](docs/spikes.md)). The default executor is dry-run.

## How it stays inside its mandate

```
 Owner ── PealMandate v1 ──▶ signed: QoreSign hybrid (secp256k1 + ML-DSA-87)   } qore-pq-kit
                             sealed: QoreSeal to the agent's ML-KEM-1024 key  } messaging
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
          │         fUSD allowance                           (proven by spike S2)
          ▼
          receipt ─▶ hash-chained, ML-DSA-87-signed log of every decision
```

Layers, from the outside in:

1. **The chain** (proven by spike S2; this repository's run waits for funds): a spending rule on the owner's account that bounds the agent's linked key (fUSD only, per-transaction and daily limits, only `commitBid` and `claim` on the mandate's auctions, an expiry) and an fUSD allowance equal to the budget. The owner's account needs no EVM window (S2). The agent's own account works only inside scoped windows the owner opens, for the permissionless calls.
2. **The key split**: the agent holds only its classical key and its decryption key. The owner holds the agent account's ML-DSA-87 key, so only the owner can open the agent's windows, link its key or change its rules. The agent cannot raise its own limits.
3. **The mandate**: authenticated instructions. The agent refuses anything not signed by its owner's on-chain key.
4. **The policy**: whatever the planner says, the bid fits the mandate.

## What is in this repository

| Path | What it does |
|---|---|
| `common/mandate.ts` | PealMandate v1: fields, validation, canonical encoding, hash ([format](docs/mandate.md)) |
| `common/canonical.ts` | Canonical JSON: one encoding per value, so a signature over bytes is a signature over the value |
| `owner-cli/mandate.ts` | Owner side: a mandate as the body of a qore-pq-kit `messaging` instruction, signed (`signInstruction`: QoreSign, secp256k1 + ML-DSA-87) and sealed (`sealInstruction`: QoreSeal, ML-KEM-1024 + X25519) |
| `agent/inbox.ts` | Agent side: `receiveMandate` opens (`openInstruction`), verifies (`verifyInstruction` against the owner's key from the chain) and the Bidder's own checks; accepts or refuses with one of 15 stable codes |
| `agent/keysource.ts` | Reads the owner's ML-DSA-87 key from the `pqcKeyStatus` precompile by `eth_call`; fails closed |
| `agent/store.ts` | Highest accepted nonce per owner (refuses replays and rollbacks) |
| `agent/policy.ts`, `agent/auction.ts` | The deterministic clamp and the auction's price arithmetic |
| `agent/planner/` | Claude Opus 5.5 planner, rule-based planner, and `decide` (planner then policy) |
| `agent/receipts.ts` | The receipts log: hash-chained, signed with the agent's ML-DSA-87 receipt key |
| `agent/agent.ts` | The loop: receive, read auctions, plan, clamp, submit, receipt; rebuilds its ledger from the receipts after a restart |
| `common/accounts.ts`, `common/home.ts` | Accounts and the key split: where each key lives, and the agent's file holding its classical key only |
| `owner-cli/` | The owner's command line: accounts, key registration, the agent's recipient card, mandates, the agent's window, the fUSD approval, and the smart-account link, rules and revoke |
| `owner-cli/smart-account.ts` | The spending rule derived from a mandate (fUSD only, per-bid and daily limits, only `commitBid` on the mandate's auctions) and the link, rules and revoke messages |
| `agent/cli.ts`, `agent/identity.ts` | The agent's command line, and its own QoreSeal and receipt keys |
| `agent/smart-account-executor.ts` | Signs a `MsgExecuteEVM` with the agent's linked key, for the relayer |
| `agent/bid-encoder.ts` | Verifies the auction's committee (qore-pq-kit `verifyMember`), checks the escrow with the contract, seals the bid (`sealSlot`) and encodes `commitBid` |
| `agent/chain-auction.ts`, `agent/auction-abi.ts` | Reads auctions from the chain; the small slice of Peal Sealed Auction's interface the agent uses, written out by hand |
| `agent/serve.ts`, `agent/lock.ts` | The long-running agent (`pnpm agent serve`): inbox, one planning round and claims per tick, one JSON line per tick; one writing process per agent folder |
| `agent/logs.ts` | Event logs in windows the public RPC accepts (it refuses ranges over 10,000 blocks) |
| `agent/claims.ts` | After the auction: the agent's bids read from the chain (`BidCommitted`, `getBid`, `allocationOf`), and `claim` for each unclaimed one, with a receipt per claim |
| `scripts/demo-testnet.ts` | The testnet demo: one landed bid and each refusal, with transaction hashes; `--check` lists what is in place and what is missing (read-only) |
| `agent/window-executor.ts`, `agent/executors.ts` | The fallback executor (the agent's own account inside an owner-opened window) and the `--executor` choice |
| `relayer/` | Broadcasts the agent's `MsgExecuteEVM`, refusing anything outside its policy, and reads `success=false` as a final refusal |
| `dashboard/` | A local, read-only page: the active mandate, what it has committed, and every receipt, verified |
| `scripts/demo-offline.ts` | The whole flow with throwaway keys in memory, no chain, no funds |
| `test/` | 215 offline tests, and 3 live planner checks that run only with `PEAL_BIDDER_LIVE=1` (Vitest and fast-check); see below |

## Running it

Needs Node 22 and pnpm 10.

```sh
pnpm install
pnpm test           # offline; no key, no network
pnpm typecheck
pnpm demo:offline   # the mandate channel and planner end to end, with throwaway keys
```

### The owner and the agent

Keys and state live outside the repository, in `~/.qore-peal-bidder/` (or `QORE_BIDDER_HOME`): `owner/` for the owner and `agent/` for the agent. In a real deployment those are two machines, and the agent is only given `agent/`. [docs/runbook.md](docs/runbook.md) walks through every step on the testnet. In short:

```sh
pnpm owner init                       # owner, agent-account and relayer accounts; the agent gets its classical key only
pnpm agent init                       # the agent makes its QoreSeal and receipt keys; writes agent/public.json
# fund the three accounts from the faucet, then:
pnpm owner register                   # ML-DSA-87 keys on chain
pnpm owner register-agent             # the agent's ML-KEM key on chain, and its signed recipient card
pnpm owner convert --amount 500       # the faucet pays fUSD as bank coins; the auction needs the ERC-20
pnpm owner approve --spender 0x<auction> --amount 500
pnpm owner link --auctions 0x<auction> --budget 500 --max-per-bid 100 --max-tick 40   # spending rule + linked key
pnpm owner mandate --auctions 0x<auction> --budget 500 --max-per-bid 100 --max-tick 40 \
  --instructions "Take part in the buyback at a fair price." --deliver
pnpm agent receive                    # verified against the owner's key on chain
pnpm agent serve --executor smart-account --interval 60 --claim   # the long-running agent; Ctrl-C stops it cleanly
# or one round at a time: pnpm agent run --executor smart-account (dry-run is the default executor)
pnpm agent bids                       # after the close: the agent's bids and what they won
pnpm agent claim --executor smart-account
pnpm dashboard                        # http://127.0.0.1:8788
pnpm demo:testnet --check --auction 0x<auction>   # what the testnet demo still needs (read-only)
```

`--offline` on `owner mandate` and `agent receive` runs the same flow with no chain: the agent then checks the owner's signature against `agent/owner-public.json` instead of the chain, and says so in its output.

The planner asks Claude Opus 5.5 only when a key is configured, in this order:
- **OpenRouter** (the owner's choice for the live run): model `anthropic/claude-opus-5.5`, read from `OPENROUTER_API_KEY` or `~/.qore-bidder/openrouter.env` (mode 0600). The request uses JSON-schema structured output, low reasoning effort and a 1,024-token cap, and goes only to providers that honour those parameters. A planning round costs about $0.01 (one recorded round: 1,961 tokens in, 182 out, $0.011).
- **Anthropic API:** `ANTHROPIC_API_KEY`.
- **No key:** the rule-based planner.

Keys are never read from or written to the repository. Tests and CI never call a model (`PEAL_BIDDER_PLANNER=rules` is set for every test run); they replay fixtures, including answers recorded from the real model in `test/fixtures/openrouter-recorded/` (`pnpm record:openrouter <scenario>`). The agent asks the model only when a bid is possible.

## Tests

- **Mandate verification** (`test/inbox.test.ts`, 35 cases): a valid mandate, and each refusal: forged signature, the owner's public key with someone else's signature, an ML-DSA key other than the one on chain, a right classical key with a wrong ML-DSA signature, tampered limits, tampered instructions, expired, not yet valid, replayed, rolled back, other chain, other EVM chain id, a signature made for another chain, an envelope sealed under another chain, sealed to another agent, another agent's mandate forwarded, an envelope bound to another owner, an owner the agent does not serve, classical-only signature, no key on chain, RPC failure, non-canonical text, duplicate keys, inconsistent limits, an extra field, a wrong receipt key, malformed envelopes and payloads, an envelope bound to another purpose, an instruction signed in the future, and instruction fields that disagree with the mandate inside.
- **On-chain key reading** (`test/keysource.test.ts`): selector, the 2,752-byte reply, and failing closed on no key, another algorithm, unproven possession, wrong length, empty or malformed data and RPC errors.
- **Policy** (`test/policy.test.ts`): every clamp and skip rule, junk proposals, and a fuzz property over 2,000 random planner outputs and ledgers that no bid ever leaves the mandate.
- **Planner** (`test/planner.test.ts`): the request (model, effort, structured output, fallbacks), the untrusted-text framing, and fixtures including **prompt-injection** cases: an "ignore your mandate" override that the model resists, one it obeys toward another auction (skipped, never redirected), one it obeys on size and tick (clamped), and a fake owner tag. Refusal, prose, schema-violating and truncated answers fall back to the rules.
- **Receipts** and **agent loop** (`test/receipts.test.ts`, `test/agent.test.ts`): tampering, deletion, reordering, a wrong key, file permissions, restart recovery, unknown outcomes counted as spent, and a bid submitted just before a crash counted on the next start.
- **Key split** (`test/accounts.test.ts`): the SDK and QoreSign derive the same keys; secret files are 0600 and never overwritten; the agent's file holds no mnemonic, and the agent refuses to run from one that does; `public.json` holds only public halves.
- **Smart account** (`test/smart-account.test.ts`): the rule a mandate produces passes the SDK's own validators; the link is one owner-signed `[MsgUpdateSpendingRules, MsgRegisterAuthenticator]` with an EIP-191 proof by the agent's key, linked by its EVM address with the `evm` permission only.
- **Relayer** (`test/relayer.test.ts`): the agent's signature over the v1 and v2 execution digests recovers to the agent's address; the relayer refuses other targets, accounts, relayers, native value and oversized gas without broadcasting; `success=false` is a final refusal with the chain's reason; a lost connection is "unknown" (counted as spent).
- **Bid encoding** (`test/bid-encoder.test.ts`): against a fake chain with real member keys and signed cards, a sealed bid opens with any 2 of the 3 members' shares and not with one; a member cannot open another's envelope; envelopes are bound to the bidder and seq; the calldata never holds the bid in clear; a substituted ML-KEM key over REST and an escrow the contract disagrees with are refused; issuer text is kept only when it matches the metadata hash.
- **Local end to end** (`test/e2e-local.test.ts`): mandate to landed bids through planner, policy, encoder, linked-key signature and relayer, with the chain-side rule **simulated**; with the policy bypassed, an over-limit bid is refused by the (simulated) rule, and the daily limit holds.
- **Fallback executor** (`test/window-executor.test.ts`): nothing is sent without a live window that admits the auction; reverted, refused and unknown outcomes are told apart.
- **Serve and lock** (`test/serve.test.ts`): a tick drains the inbox (junk refused, mandates accepted), plans once and logs one line with no secret in it; the planner is not asked once the limits are used up or no auction is open; claims land on the same receipts chain; a second process is refused the lock, a dead one's lock is taken over; two logs on one file extend one chain, and a truncated or foreign log stops the agent.
- **Claims** (`test/claims.test.ts`): only the bidder's own bids (a node returning someone else's is caught by `getBid`), each unclaimed bid claimed once with a receipt, nothing claimed before the auction is settled, failed or cancelled.
- **CLI and dashboard** (`test/cli.test.ts`, `test/dashboard.test.ts`): the owner-to-agent flow through the files, restart and replay; fUSD amounts parsed exactly; untrusted strings escaped on the page.

The planner fixtures in `test/fixtures/claude/` are hand-written in the shape of API responses (each says so in its `provenance` field), because the owner's API key is not available yet. Recorded responses will join them in `test/fixtures/claude-recorded/`.

## Network

QoreChain testnet `qorechain-diana`, EVM chain id 9800. Quote and budget token: the fest's fUSD (`0x97143B771D34ddb9130b807b135Ae675A5a963CA`, 6 decimals). Contract addresses will be listed here when deployed.

Testnet accounts (throwaway, created 16 November 2026, keys outside the repository; funded and registered 16 November, see [docs/spikes.md](docs/spikes.md)):

| Role | Address |
|---|---|
| Owner | `qor14ndj6q3zp7hku9a4hkjnmhvsk3kegf46g002j5` (`0xaCdB2d02220FAf6e17B5bdA53DDd90B46d9426BA`) |
| Agent account | `qor1k7at260yd632szpqt8fguukwuf3l52fpfz8lur` (`0xb7Bab569E46Ea2a8082059D28E72CeE263Fa2921`) |
| Relayer | `qor16tsewlj6jpt4v2esmrhuk7z2xems6e09z5rpzc` (`0xD2E1977E5A9057562b30D8EFCB784a36770D65E5`) |

**The live demo** (16 November 2026, on Peal Sealed Auction's demo auction `0x481FBb2C84582BF7c258c46BF523DEEbDe51E990`; every hash and message is in [docs/spikes.md](docs/spikes.md)):

| Case | Result |
|---|---|
| In-mandate bid, planned by Claude Opus 5.5, sealed to the committee, sent through the owner's smart account | landed `27CAB8D0…`, and again in the injection scene `D6F66BD9…` |
| Over the per-bid limit, with the agent's policy bypassed | refused by the chain's spending rule: `4012FE2E…`, "per-tx limit … exceeded" |
| A call to a contract off the allowlist | refused by the chain: `8FB22F76…` |
| A forged mandate | refused by the agent: `SIGNATURE_INVALID` |
| An injected "ignore your mandate" in the auction text | the model disregarded it and said so; the bid stayed in the mandate |
| Claims after settlement | both bids won 16.5 PEAL-T; claims `99000161…` and `47FB6C58…` |

Two findings came out of the run: a token listed in the spending rule can also be transferred by the agent's key within the limits (see the threat model), and events of `MsgExecuteEVM` calls do not reach `eth_getLogs`.

## Roadmap

1. ~~Mandate format, signing and sealing, verification, policy, planner, receipts~~ (PR 1).
2. ~~Owner CLI, relayer, dashboard~~ (PR 2), written and tested offline; first live run once the accounts are funded.
3. ~~Bid sealing and encoding for Peal Sealed Auction; chain reader; fallback window executor~~ (PR 3), tested offline against a fake chain.
4. ~~Claims after settlement; the testnet demo script~~ (PR 4); the demo's `--check` runs read-only today.
5. ~~The smart-account path: spike S2~~ settled in qore-pq-kit; the transport now comes from its `v0.4.0` `smart-account` module (PR 5). Design R1's fallback is retired.
6. `pnpm demo:testnet` against Peal Sealed Auction's deployed contracts (expected 22 to 23 November): one landed bid and each refusal, with transaction hashes.

## Prior work

The design comes from the author's own earlier project, **Peal** (private, started 6 July 2026, Apache-2.0). Everything in this repository was written during the fest. Rules ported from Peal, rewritten here:

- The auction price and escrow arithmetic in `agent/auction.ts` (`price(tick) = reservePrice + tick × tickSize`, escrow rounded up) follows Peal's `contracts/src/auctionkit/AuctionMath.sol`, so the agent computes the same escrow as the auction contract.

## Credits

- [@qorechain/qoresign](https://www.npmjs.com/package/@qorechain/qoresign) 0.2.0 (hybrid message signatures) and [@qorechain/qoreseal](https://www.npmjs.com/package/@qorechain/qoreseal) 0.1.0 (ML-KEM-1024 envelopes), QoreChain's kits.
- [qore-pq-kit](https://github.com/Adityaakr/qore-pq-kit) `v0.4.0`, by git tag: network settings, hybrid-signed broadcasts, EVM transactions, secret files, fUSD conversion, the `messaging` module (the mandate's signature and envelope), the `threshold` module (sealing a bid to a committee, checking members) and the `smart-account` module (linking the agent's key, signing its calls, relaying).
- [@qorechain/sdk](https://www.npmjs.com/package/@qorechain/sdk) and [@qorechain/evm](https://www.npmjs.com/package/@qorechain/evm) 0.14.0: windows, linked keys, spending rules, `MsgExecuteEVM`.
- [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) for Claude; [viem](https://viem.sh) for the EVM calls; [@noble/hashes](https://github.com/paulmillr/noble-hashes) and [@scure/bip39](https://github.com/paulmillr/scure-bip39); [Vitest](https://vitest.dev) and [fast-check](https://fast-check.dev) for tests.

How AI was used to build this: [AI_USAGE.md](AI_USAGE.md). Security assumptions and what is not protected: [THREAT_MODEL.md](THREAT_MODEL.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
