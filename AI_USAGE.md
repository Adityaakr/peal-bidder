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

**What is synthetic, stated plainly**: the Claude response fixtures in `test/fixtures/claude/` are hand-written in the shape of API responses; each says so in its `provenance` field. One answer recorded from the real model through OpenRouter is in `test/fixtures/openrouter-recorded/`, and the live run's five planning rounds, with Claude's own words, are in the published receipts.

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

### 2026-11-16: the live demo (tenth pull request onwards)

**Human decisions in this step**: the owner funded the accounts. The orchestrator chose option (a): the auction worker opened a demo auction for the Bidder and ran the committee's releases and finalize. The owner asked for every case of the design on chain.

**What the worker agent did**

- Approved, linked, checked all preconditions, and ran the demo: a landed bid; an over-limit commit and an off-allowlist call, both refused by the chain; a forged mandate refused by the agent; an injected instruction that Claude disregarded; and, after finalize, both claims. Every hash is in `docs/spikes.md`.
- Fixed three problems the live chain exposed before they cost anything:
  - the public RPC's 10,000-block log limit (PR 10);
  - a relay fee too small for a sealed commit, now sized to the call, with stale nonces refused before broadcasting;
  - claims that looked for bids in logs a `MsgExecuteEVM` call never writes to, now read from storage.
- Reported two findings honestly instead of hiding them. First, the agent's key can transfer the listed token (fUSD) within the limits; the agent first misread a 1 fUSD transfer as an expected refusal, then read the chain's reason and the SDK text that explain it. Second, `MsgExecuteEVM` events are missing from `eth_getLogs`.
- Hit a local hook that blocks force-pushes. Rather than bypass it, it moved the branch forward with a merge that adds no content.

### 2026-11-16: the transfer finding, tested (twelfth pull request)

**Human decisions in this step**: the owner asked that the finding be tightened if the chain allows, and otherwise stated plainly. A second demo auction was opened for the test.

**What the worker agent did**: tried the most promising tightening live (leaving fUSD out of the rule). The chain then refused the plain transfer, but also the bid, with a reason that settles it. The agent restored the listed rule, recorded that the day's spend counter survives rule updates (found when the restored rule refused a bid), and wrote the residual bound and mitigations into the threat model. It removed the temporary rule option from the code rather than ship an option the chain makes useless for bidding.

### 2026-11-16: the web app (thirteenth pull request)

**Human decisions in this step**: the owner asked for wallet connect so the public can try all three Peal products, one shared design language and a landing page in each, hosted on Vercel's free tier, and asked for the landing pages to be designed "better and deeply". The owner chose the wallet paths: a guest account made in the visitor's browser and funded by the visitor from the faucet, plus QoreX and MetaMask. This replaces design decision D8 (no public try-it). The orchestrator added the limits: small mandates only, the owner's OpenRouter key never public (rule-based planner for visitors, or a strictly capped server-side planner), no new contract deploys, no Vercel account made by an agent.

**What the worker agent did**

- Read Peal Tender's shipped web app (its wallet modules, Vercel proxy and `docs/design.md`) and the deeper landing-page rules that the Tender worker landed while this was being built (relayed by the orchestrator through three steering messages), and Peal's own landing page, read-only, for the look.
- Built `apps/web`: a landing page to those rules (hero with three real receipts, a proof bar computed from the live receipts, a step rail synced to a hand-drawn mechanism with a separate phone drawing, the security evidence on the dark band, roles, try it, the Peal family), a live-agent page, and a playground. The wallet drawer, guest account, QoreX and MetaMask modules are adapted from Peal Tender, each file saying so; nothing was shared through qore-pq-kit, because the code is page code, not toolkit code.
- Chose the rule-based planner for visitors, in the browser, so there is no server endpoint and nothing that could spend the owner's OpenRouter credit.
- Made the agent's own code run in the browser rather than writing a demo version: moved the receipts file sink and `decide` into their own files so the browser can import `receipts.ts`, the planner and `agent.ts` without Node modules. Every existing test stayed green.
- Published the live agent's receipts log to the site with a script that checks it first, and added a test that only public material is published.
- Wrote a headless-Chromium smoke run (14 checks). It caught three real bugs before the PR: the element builder ignored `#id` (the dark band and every section anchor were silently missing), the header overflowed a 390px screen, and the forged-mandate scene tried to sign in the owner's name, which QoreSign refuses; it now forges the way the CLI demo does.

**What is not done, stated plainly**: the visitor's agent does not bid on chain yet. It seals a real bid and stops. No Peal auction was open while this was built, and testing the on-chain path needs a funded guest account; both are named as the next step in the README roadmap.

### 2026-11-16: the landing page, redesigned (fifteenth pull request)

**Human decisions in this step**: the owner asked for the landing pages to be "premium and professional and not ai slop", then that the three products must not look the same: each gets its own identity, sharing only a small Peal family layer. The orchestrator relayed both, the revised shared rules (Peal Tender's `docs/design.md`, PR 9) and a starting direction for the Bidder: the agent on a leash, an operator console.

**What the worker agent did**

- Loaded its design, diagramming and data-visualisation guidance and wrote a concept before designing. The visitor is a judge or builder deciding whether an AI agent can be trusted with money. The page has to land one idea in five seconds: this agent spends, but only inside lines it cannot cross, and you can watch it.
- Rebuilt the landing page around that idea:
  - an operator console replaying the live agent's own receipts, with the budget meter drawn against a red limit;
  - the headline's key phrase underlined by the same red limit line;
  - the signed mandate shown field by field, with what enforces each line;
  - the mechanism redrawn as a schematic where refusals are hard red stops;
  - the live run as a data table with block heights and hashes;
  - rule lists instead of rows of identical cards.
- Moved the type to IBM Plex (condensed display, sans text, mono data) and the palette to one instrument grey, one cyan-blue accent and red reserved for limits, distinct from Tender's serif ledger. It removed the sky gradient, the blurred navigation bar and the icon cards.
- Checked every hash and block height on the page against the chain before using it.
- Iterated in headless Chromium at 1440, 1280, 768 and 390 px over three rounds, fixing each round's faults:
  - a four-line headline;
  - a schematic with floating labels;
  - a run table whose result column hid off-screen on a phone;
  - misaligned family rows;
  - an em-dash in a table.
- The smoke run (14 checks) passes.

**Note**: the browser automation tool the brief names (chrome-devtools-axi) could not attach to a browser in this environment, so the screenshots and the smoke run use Playwright with the installed headless Chromium.

### 2026-11-16: diagrams as the backbone, and the family guide (sixteenth pull request)

**Human decisions in this step**: the owner approved the distinct-identity direction and asked for meaningful changes, with diagrams that make the product easy to understand and a landing page that covers everything a judge needs. The Peal family guide was cut down to the shared layer only (Peal Tender PR 10).

**What the worker agent did**

- Drew four diagrams, each answering one question a visitor has:
  - why not just give an agent a wallet: the same flow drawn twice;
  - who holds which key, and what a thief of each machine gets;
  - one bid message by message: a sequence across Owner, Agent, Claude, Relayer, QoreChain and the auction;
  - where each attack stops: a track per attacker across the four layers, each with its proof.
- Reordered the page into the order a judge asks: what it is, whether it is live, the problem, the keys, the mandate, how a bid happens, the attacks and the live run, then the category's requirements, how to try it and the family.
- Added a table of the category's four main requirements (scoped EVM window; transaction, value, duration and target limits; smart-account spending rules; authenticated messaging). Each row names the code and tests and a transaction, and the agent checked those transactions on chain first, including the window open and close and the agent's ML-KEM key registration.
- Removed the earlier four-checks schematic, which the sequence diagram and the hot-wallet comparison now cover, and the roles section.
- Applied the family guide: a family line in the footer with each product's mark and the current one marked, the credit line "Design language started from Peal", sibling marks drawn in plain ink, and the Bidder's identity written down in `apps/web/DESIGN.md`.
- Reviewed screenshots at 1440, 1280, 768 and 390 px over three rounds and fixed what they showed:
  - a cropped sequence diagram, now full width;
  - a clipped label and a self-message cut off at the right edge;
  - a non-refusal coloured as a refusal;
  - panels too small to read on a phone, now in their own scroller;
  - attack tracks without layer names on narrow screens;
  - stray cell borders in the phone run table.

### 2026-11-17: the new logo

- The human asked for professional logos for all three products. A design agent drew the Peal logo family (the parent mark and the Tender, Sealed Auction and Bidder marks, with lockups, favicons and a brand sheet) in Peal Tender's `docs/brand/`.
- A worker agent adopted it here without redrawing anything: copied the Bidder and Peal masters (and the sibling marks for the family line) into `apps/web/public/brand/`, replaced the hand-drawn marks with them, put the Bidder lockup in the header and footer, added the parent mark to the footer's family line, and replaced the inline favicon with the Bidder favicon set.
- Checked in a browser at 1440 and 390 px and at 16 and 32 px favicon size.

### 2026-11-17: more of QoreChain's kits, each for a job (kits pull requests)

**Human decision in this step**: the owner asked for more of QoreChain's kits and network features, used deeply rather than ticked, because the fest's project page shows which ones a repository really uses.

**What the worker agent did**

- Worked out how the fest site decides VERIFIED (read off the project pages of all 63 entries and the dependency files of the repositories behind them, recorded in `docs/spikes.md`), and read the README and typings of every listed kit.
- Wrote `docs/kits.md`: for each kit and network feature, use it or not and the product reason. Six kits and seven features are left out, each with the reason (for example the wallet adapter, which would put the owner's ML-DSA-87 key in a web page, and the PQ light client, which cannot check the live chain yet).
- First pull request: the receipts log signs and checks with qorechain-pqc's ML-DSA-87 directly, byte-identical to before (a test checks the published live log, signed earlier, still verifies), and the web app's QoreX connection uses QoreChain's QoreX integrations kit, which also reports whether QoreX committed a transaction without its ML-DSA-87 layer.
- Second pull request: the agent audits itself against the chain through the QoreChain MCP server (`pnpm agent audit`), run in process and spoken to over MCP. It checks each receipt's transaction (outcome, signer, hybrid ML-DSA-87 layer verified against the signer's key) and resolves unknown outcomes. The repository's `.mcp.json` gives the owner's own assistant the same read-only tools. The worker ran it against the live log, where all 8 transactions agree, and recorded the chain's answers so the tests replay the real server offline.
- Third pull request: the owner's brake. `pnpm owner pause` and `resume` sign in to the running agent with Sign In With QoreChain. The agent issues a single-use nonce and checks the message against the owner's ML-DSA-87 key read from the chain, the same fail-closed key source it uses for mandates; a classical-only sign-in is refused. A paused agent places no bid until resumed. The worker considered porting the custody kit's verify-before-broadcast rule into the relayer, then left it out: the MCP audit already verifies every relayed transaction, so the port would add code with nothing to catch.
- Fourth pull request: QoreScan inventories the cryptography the Bidder depends on (`pnpm cbom`: the testnet, the three accounts, the three endpoints' TLS), committed as a CycloneDX CBOM with a summary. The scan surfaced a point the threat model lacked: the endpoints use a hybrid ML-KEM key exchange but classical ECDSA certificates. The agent wrote down what an impersonated endpoint could and could not do, and a test keeps that section in line with the CBOM.
- Fifth pull request: the owner can top up the fUSD budget from QOR on the chain's AMM (`pnpm owner topup`). The swap is priced by the chain's own quote with a minimum out, and converts that minimum to ERC-20 fUSD in the same transaction. The worker ran one 2 QOR top-up from the owner's existing funds; the swap paid exactly the quote.

### 2026-11-21: the final check before the deadline

**Human decision in this step**: the owner asked for a final pass on all three entries before 2 December: every step a judge would take must work, the README must say what is true now, and each entry needs its video.

**What the worker agent did**

- Walked the production build as a first-time visitor, served under `vercel.json`'s headers and rewrites, at desktop and phone width. Found that the playground could no longer seal a bid to the committee and took about two minutes to load, because the committee's events had aged past the log reader's block budget, and that 8 tests had failed since 18 November on a fixed clock. Fixed both (`docs/spikes.md`, 2026-11-21).
- Rewrote the README's status from the published receipts and from on-chain lookups through the QoreChain MCP server (`pnpm agent audit --published`: 8 of 8), with the live run's full hashes, a five-minute path, the limits and the Vercel import steps.
- Made the 2:44 video with HyperFrames (`docs/video`): real screens captured from the live site, narration by a local Kokoro voice, every figure from the receipts, the chain or the audit. Made the project page's cover from its last frame.

### 2026-11-24: the second live run

**Human decision in this step**: the owner asked for a new fUSD auction on the existing factory and a live run in it, with at least two bids inside the mandate, one refusal for each enforced limit, settlement and claims, and only true statements published.

**What the worker agent did**

- Created two fUSD auctions with Peal Sealed Auction's own testnet scripts (one for the run, one left open for judges until 17 December), linked the agent's key again for two hours, signed the mandates and ran the Bidder's own commands against them. Claude Opus 5.5 planned four bids through OpenRouter (7,498 tokens in, 650 out).
- Showed one refusal for each limit, recorded the hashes in `docs/spikes.md`, published the receipts and updated the site, the README and the threat model from them.
- Found and fixed two errors on the way: scene 3b of the testnet demo sent a call the rule allows, and `pnpm owner` in the docs ran npm's own command. The settle script was stopped by the public RPC's rate limit before its last step; the worker sent that step on its own and said so.

### 2026-11-24 and 25: the vault

**Human decision in this step**: after comparing the entry with its rivals, the owner approved building a vault contract that holds the budget ("do it build the vault"), with checkpoints and a fallback, on the testnet with throwaway accounts only.

**What the worker agent did**

- A design spike (a separate agent) had shown locally that a contract can be the bidder, found that the committee's reader would miss its envelopes, and left three surviving mutants. The worker built the contract from that design: a config hash the owner signs, one-hour signatures, a separate `revoke`, an exit that also works before a first policy, bounded and sanity-checked policies.
- Wrote 54 Foundry tests and 4 invariants against a pinned copy of the auction's contracts, then 50 hand-made mutants. The first run left two alive (the counters a new policy resets); a test was added and both died. One test written for a spike mutant (the allowance reset) would not have killed it, because an ordinary token uses the allowance up anyway; it was rewritten with a token that does not.
- Adding that test made the compiler fail ("Tag too large for reserved space"); the suite was split in three.
- Wrote the agent's side, the owner's commands, the rule that lists no held token, and the site's reading of it, and corrected the threat model's sentence that said the transfer finding could not be tightened.
- Not audited. At the time of this entry nothing had been sent to the testnet.
