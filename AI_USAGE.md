# AI usage

This repository is built by AI coding agents under one human's direction. This file records how, what the agents produced, and what the human decided. It is a dated log: newest entries at the bottom.

## The workflow

- **The human (the repository owner)** sets the goals, makes the product and security decisions, holds every key and every secret (testnet accounts, the Anthropic API key), claims faucet funds, and approves every merge.
- **An orchestrator agent (Firstmate)** turns those decisions into written task briefs and dispatches one worker agent per repository. It does not write the code.
- **Worker agents** (Claude Code, running Claude Opus 5.5) each work in an isolated copy of one repository (a disposable git worktree on its own branch), follow the brief, write the code, tests and docs, and open pull requests. Workers report status to the orchestrator; they never push to `main` and never merge.
- **Before the build**, a design agent wrote a combined design for the three linked entries (Tender, Sealed Auction, Bidder). The human approved it with nine decisions (D1 to D9) on 15 to 16 November 2026.

Secrets never pass through the agents' prompts or the repository: the API key is read from the environment at run time, and testnet mnemonics live outside the repository with 0600 permissions.

## The agent inside the product

Peal Bidder is itself an AI agent: its planner asks Claude Opus 5.5 (`claude-opus-5-5`) for a bid proposal with structured output, and a deterministic policy clamps the answer. That use of AI is described in the [README](README.md) and [THREAT_MODEL.md](THREAT_MODEL.md); this file is about how the code was written.

## Human decisions that shaped this repository

From the approved design (decisions of 15 to 16 November 2026):

- **D1**: build to the combined design (section 6 for the Bidder: key split, layered chain limits, authenticated mandates, the AI planner).
- **D4**: the fest's fUSD as the budget token, plus a PEAL-T demo token.
- **D5**: Claude Opus 5.5 with the owner's API key, with a rule-based fallback.
- **D6**: shared code from qore-pq-kit by git tag, nothing on npm.
- **D7**: Apache-2.0.
- **D8**: no public try-it bidding; video plus scripted demo.

## Log

### 2026-11-16: the offline core (first pull request)

**Brief**: build the offline parts first (the PealMandate v1 format, owner-side signing and sealing, agent-side verification against the owner's on-chain ML-DSA key with every refusal case, the deterministic policy clamp, the receipts log, the planner with Claude Opus 5.5 and a rule-based fallback), test against the rule-based policy and recorded fixtures until the API key exists, and include prompt-injection fixtures.

**What the worker agent did**

- Read the approved design and the hackathon rules, the QoreSign 0.2.0 and QoreSeal 0.1.0 type definitions, the Anthropic SDK 1.8.0 types for structured output and server-side fallbacks, and Peal's `AuctionMath.sol` (read-only, for the price rule).
- Chose and wrote the mandate format: canonical JSON with a strict field set, a domain-separated sign prefix, strictly increasing nonces (one number per owner refuses both replays and rollbacks), and an envelope AAD that binds owner and agent.
- Added two things the design did not spell out: a pinned **receipt key** (a standalone ML-DSA-87 key that signs receipts; its hash is in each mandate, so receipts verify against a key the owner chose, while the agent still holds no key with power on chain), and **ledger recovery from the receipts** (a restart cannot reset the budget; an unknown submission outcome counts as spent).
- Wrote 119 offline tests and 3 live planner checks (skipped without the key), including a 2,000-run fuzz property that no planner output can produce a bid outside the mandate, and prompt-injection fixtures in which the model is assumed to *obey* the injection.

**What went wrong and was fixed**

- `npm install` crashed inside npm's dependency resolver when moving to Vitest 5 (needed because the Vitest 3 line carried a critical advisory in `tinypool`). The agent switched the repository to pnpm, which resolved cleanly with no known vulnerabilities.
- The first forged-signature test called QoreSign's `signMessage` with the owner's address and the attacker's key; QoreSign refuses to produce such a signature. The test now forges the way an attacker would: sign with its own keys, and separately with the owner's public key pasted into the signature.
- A first agent-loop test expected the "bid count used up" refusal but hit "budget used up" first, because five maximum-size bids exhaust the budget exactly. The test now uses a smaller bid count so the case it names is the one it checks.
- The agent first wrote a guessed Tendermint RPC URL into the network config; it removed it before committing, since nothing used it and it had not been checked.

**What is synthetic, stated plainly**: the Claude response fixtures are hand-written in the shape of API responses, because the API key is not available yet; each says so in its `provenance` field. `scripts/record-claude-fixtures.ts` will record real ones.

**Human decisions in this step**: none beyond the design decisions above; the pull request awaits the owner's review.

### 2026-11-16: owner CLI, relayer and dashboard (second pull request)

**Brief**: after the first pull request was merged, build the owner CLI (mandate, link and revoke the agent key, spending rules, the agent's window, the fUSD approval), the relayer and the dashboard on the same branch; use qore-pq-kit by git tag rather than duplicating it.

**What the worker agent did**

- Took qore-pq-kit `v0.1.0` as a git dependency and used its hybrid `broadcast`, `sendEvm`, network settings and 0600 secret files. The kit has no smart-account module yet (it follows spike S2), so the link, rules and revoke messages are built here on the QoreChain SDK, checked offline with the SDK's own validators, and marked unproven.
- Laid out the key split as files: the owner's folder holds the agent account's mnemonic; the agent's folder gets its classical key only, and the agent refuses to start from a file that holds a mnemonic.
- Wrote the relayer with a policy check before it pays gas, and an outcome mapping in which `success=false` is final and a lost connection is "unknown" (counted as spent).
- Wrote a local read-only dashboard over the verified receipts log, escaping every string and served with a no-script CSP.
- Ran read-only checks against the testnet (no transaction): the owner-key lookup on a fresh account, the abstract-account routes, the explorer URL. Findings are in `docs/spikes.md`.
- Created three throwaway testnet accounts (owner, agent account, relayer) under `~/.qore-peal-bidder/`, outside the repository, and asked for faucet funds through the orchestrator.

**What went wrong and was fixed**

- A fuzz property from the first pull request failed on a new random seed: at price zero there is no escrow bound, so "one more unit would not fit" is false. The code was right (the quantity is capped at uint128 and then by supply); the test now states the zero-price case.
- The agent assumed the SDK exported `SpendingRule` and the message codecs at its root; they live under `qorechainTypes.abstractaccount`. The compiler caught it.
- Writing a file with a new mode does not change the mode of an existing file, so one permissions test passed for the wrong reason until it used `chmod`.
- The browser automation bridge was not reachable, so the dashboard was checked through its HTML rather than with a screenshot.

**Human decisions in this step**: the owner (through the orchestrator) decided not to transfer QOR from the drill account before drill day, so the live runs wait for faucet funds; and the agent must not claim the faucet with scripted accounts.

### 2026-11-16: sealed bids for Peal Sealed Auction, chain reader, fallback executor (third pull request)

**Brief**: next slice after the second pull request was merged.

**What the worker agent did**

- Read Peal Sealed Auction's merged contracts and client (read-only, at `f502616`) and wrote out by hand the small interface the agent needs (`agent/auction-abi.ts`), instead of importing the other entry's repository, which the rules keep separate. The shared cryptography comes from qore-pq-kit `v0.2.0`'s `threshold` module, which both entries use by tag.
- Found that the `commitBid` signature it had assumed from the design (`uint64 seq`) differs from the contract (`uint32 seq`), and corrected the spending rule's allowed call to the contract's.
- Wrote the bid encoder (committee verification, an escrow cross-check with the contract, sealing, calldata), a chain auction reader that keeps issuer text only when it matches the auction's metadata hash, and the fallback executor for design R1.
- Built a fake chain for the tests with real member keys and cards, so the kit's own `verifyMember`, `sealSlot`, `openShare` and `openSlot` run unmodified; and a local end-to-end test with the chain-side spending rule *simulated* (labelled as such: the real rule is spike S2's subject).
- Added two privacy points to the threat model that the earlier slices had missed: the agent's own receipts show its bids in clear before the close, and with Claude enabled the planner's input goes to Anthropic's API.

**What went wrong and was fixed**

- A first draft of the end-to-end test file was left with placeholder blocks; the agent noticed before running it and rewrote the file.

**Human decisions in this step**: none new; the live runs stay parked on faucet funds, as decided.

### 2026-11-16: claims and the testnet demo script (fourth pull request)

**Brief**: next offline slice after the third pull request was merged.

**What the worker agent did**

- Gave both executors a generic `sendCall` and wrote the claims module: the agent's bids read from the chain, and `claim` for each unclaimed one once the auction is settled, failed or cancelled, with a receipt per claim. The spending rule now also allows `claim` (permissionless, pays the bidder).
- Wrote `scripts/demo-testnet.ts` for the video's scenes (a landed bid; over-limit, off-target and forged refusals; an injected instruction clamped), with a read-only `--check` that lists every precondition. It ran read-only against the testnet and reports, correctly, that nothing is funded or registered yet.

**What went wrong and was fixed**

- The first draft of the demo's forged-mandate scene signed the mandate twice and spliced the texts together; the agent rewrote it to sign the real owner's mandate text with another account's keys, which is the attack the scene is meant to show.

**Not tested**: the demo script's scenes need funded accounts, spike S2 and a deployed auction; only `--check` has run. The pieces it composes are tested on their own.

**Human decisions in this step**: none new.

### 2026-11-16: the smart-account path on qore-pq-kit v0.4.0 (fifth pull request)

**Brief**: the orchestrator relayed that spike S2 passed in qore-pq-kit ([qore-pq-kit#7](https://github.com/Adityaakr/qore-pq-kit/pull/7)): use the smart-account path, not the fallback, and the kit's `v0.4.0` tag.

**What the worker agent did**

- Read the kit's S2 report and its `smart-account` module, and found that the Bidder's earlier design matched what S2 proved (key linked by its 20-byte address with an EIP-191 proof, v2 digest, no window on the owner). It then removed its own copies of the transport: the link proof, link and revoke messages, call signing and relay now come from the kit. Only the rule derived from a mandate (Peal Bidder's policy) stays here.
- Took two further findings from the kit's spikes: the fourth word of `pqcKeyStatus` is "possession proven" (as the key reader assumed), and the faucet pays fUSD as bank coins, so it added `pnpm owner convert` (the kit's `convertCoinMsg`).
- Removed the "unproven" warnings, marked design R1's fallback retired (kept for comparison), and recorded what S2 did not exercise: the ERC-20 (fUSD) limits and the key's expiry.

**Noticed, not done here**: the kit also gained a `messaging` module written for Peal Bidder's mandates. Moving the mandate channel onto it changes the mandate's wire format, so it is the next slice rather than part of this one.

**Human decisions in this step**: use the smart-account path and the `v0.4.0` tag (relayed by the orchestrator).

### 2026-11-16: the mandate channel on qore-pq-kit `messaging` (sixth pull request)

**Brief**: the messaging slice: move the mandate's signature and envelope onto the kit's `messaging` module, which the kit worker wrote for Peal Bidder.

**What the worker agent did**

- Made a mandate the body of a kit instruction (purpose `peal-bidder/mandate/v1`), signed with `signInstruction` and sealed with `sealInstruction`; the agent opens with `openInstruction` and verifies with `verifyInstruction` against the owner's key from the chain. Its own wire format (`common/signed.ts`, the sign prefix, the owner-and-agent AAD) is gone.
- Kept the Bidder's checks the kit cannot make (the mandate's fields, the start time, the pinned receipt key, the strictly increasing nonce) and the same fifteen refusal codes, and added one rule the new format needs: the instruction's fields must agree with the mandate inside it. New tests cover a disagreeing nonce, expiry and chain, an envelope bound to another purpose, and an instruction signed in the future.
- Noticed one behaviour change and kept it: a validly signed mandate from an account the agent does not serve is now refused as `WRONG_OWNER` (before, the owner-bound AAD made it fail to open). The kit's AAD binds the recipient and the purpose instead.

**Human decisions in this step**: none new.

### 2026-11-16: the long-running agent (seventh pull request)

**What the worker agent did**

- Wrote `pnpm agent serve`: each tick reads new mandates, makes at most one planning round and (with `--claim`) claims finished auctions, printing one JSON line; Ctrl-C ends it after the current tick.
- Made the agent go idle, without asking the planner, once the mandate's bid count or budget is used up or no auction is taking bids, so a long-running agent does not pay for model calls that cannot lead to a bid.
- Added a single-instance lock: two processes sharing one receipts log and nonce store could each spend the remaining budget.

**What went wrong and was fixed**

- While wiring claims into the loop, the agent noticed that two `ReceiptLog` objects on one file (decisions and claims) would each keep their own position and fork the hash chain. The log now continues from the file's last line before each write, and refuses a log that was truncated or extended by anything else.

**Human decisions in this step**: none new.

### 2026-11-16: hardening (eighth pull request)

**What the worker agent did**

- Re-read its own spend accounting and found a gap: the ledger counted a bid only from its `result` receipt, so a crash after broadcasting and before that receipt would under-count the budget on restart. A `submission` receipt is now written before anything is sent; on restart a submission with no result is counted as spent and the agent writes an explicit `unknown` result.
- Bounded untrusted text: the issuer's text in the prompt (length is both an injection surface and a cost), planner output kept in receipts, and envelope size before decoding.
- Documented one fail-safe gap rather than closing it: a crash between accepting a mandate's nonce and recording the mandate leaves no active mandate; the owner re-sends.

**Human decisions in this step**: none new.

### 2026-11-16: the live setup and the planner on OpenRouter (ninth pull request)

**Human decisions in this step**: the owner funded the accounts, and provided an **OpenRouter** API key instead of an Anthropic key, asking for Claude Opus through OpenRouter's OpenAI-compatible API with structured output, low effort, capped tokens, the rule-based fallback kept, and no model call in CI or unit tests.

**What the worker agent did**

- Ran the live setup that needs no auction: ML-DSA-87 keys for the three accounts, the agent's ML-KEM key and recipient card, and the fUSD conversion (transaction hashes in `docs/spikes.md`); read the keys back from the chain.
- Looked up the OpenRouter model id (`anthropic/claude-opus-5.5`) and its supported parameters from OpenRouter's public model list, and wrote the OpenRouter planner with plain `fetch` (no new dependency). The Anthropic-SDK planner stays for an Anthropic key.
- Made the test runner force the rule-based planner (`PEAL_BIDDER_PLANNER=rules`), so no test can reach a paid model, and made the offline demo use the rules unless `--model` is given.
- Spent one live request ($0.011) to check the request shape and record a real answer for the tests, instead of a second hand-written fixture.
