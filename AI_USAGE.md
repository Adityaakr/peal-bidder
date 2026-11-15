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
