# QoreChain kits and network features in Peal Bidder

The fest's project page has two checklists, "Kits" and "Network features". This file is the Bidder's plan for both: for every item, whether the Bidder uses it and the product reason, or why not. An item earns a place only if it does a job the Bidder needs; nothing is added to tick a box.

Researched 16 November 2026 (UTC, evening) from the npm registry, the packages' READMEs and typings, the QoreChain docs repository, and the fest site itself.

## How the fest site verifies

Found by reading the project pages of all 63 entries on build.qorechain.io on 16 November (UTC) and the dependency files of the repositories whose items show as verified ([spikes.md](spikes.md#2026-11-16-utc-how-the-fest-site-verifies-kits-and-features)):

- **A kit is VERIFIED when its npm package is in any `package.json` in the repository**, including nested ones (`packages/*/package.json`, `web/package.json`), in `dependencies` or `devDependencies`. The packages that turn each kit green, as observed:

  | Kit | Package seen to verify it |
  |---|---|
  | QoreChain SDK | `@qorechain/sdk` |
  | create-qorechain-dapp | `create-qorechain-dapp` |
  | qorechain-pqc | `@qorechain/pqc` |
  | QoreSign | `@qorechain/qoresign` |
  | QoreSeal | `@qorechain/qoreseal` |
  | QoreX integrations | `@qorechain/qorex-types` (or another `@qorechain/qorex-*`) |
  | Wallet adapter | `@qorechain/wallet-adapter` |
  | RDK | `@qorechain/rdk` |
  | MCP + qore CLI | `@qorechain/mcp` (also turns the "MCP server or qore CLI" feature green) |
  | QoreScan | `@qorechain/qorescan` (also turns the "QoreScan" feature green) |
  | Handles | `@qorechain/handles` |

  The custody kit is not published to any registry (`git clone`), and no entry shows it verified; PQ light client, Asset Kit and Chain bridge have packages (`@qorechain/pq-light-client`, `@qorechain/asset-kit`, `@qorechain/chain-bridge`) but no entry uses them yet.
- **A network feature is VERIFIED when the chain shows it for one of the testnet addresses listed on the project page** (hybrid transactions, key registration, an EVM window, a KEM key registration, spending rules and authenticators, fest tokens, AMM swaps). Two features are verified from dependencies instead (MCP, QoreScan). "Solidity PQC key status" and "Solidity PQC signature check" are verified on no entry, and "Sign In With QoreChain" leaves no trace on chain, so those stay DECLARED for everyone.
- **DECLARED** is simply what the team ticked.

## Kits

| Kit | Use | Product reason | Status |
|---|---|---|---|
| **QoreChain SDK** (`@qorechain/sdk`, `@qorechain/evm`) | yes | Accounts, hybrid transactions, the smart-account messages (spending rule, linked key, `MsgExecuteEVM`), windows, chain reads | in use since the first PR |
| **qorechain-pqc** (`@qorechain/pqc`) | yes | The receipts log's ML-DSA-87 signatures: signing, checking one line, and checking a whole log in one `batchVerify` (the agent on restart, the browser on the live page). Byte-identical to before: QoreSign's `pqSign` is this package's `mldsa87` | this PR |
| **QoreSign** (`@qorechain/qoresign`) | **in use** | Hybrid signing of every native transaction, the mandate's signature; plus **Sign In With QoreChain**: the owner pauses or resumes a running agent (`pnpm run owner pause`), checked against the owner's on-chain ML-DSA-87 key | in use; SIWQ in `agent/control.ts` |
| **QoreSeal** (`@qorechain/qoreseal`) | yes | Mandates sealed to the agent's ML-KEM-1024 key; the agent's key in the on-chain encryption key registry | in use |
| **QoreX integrations** (`@qorechain/qorex-types`) | yes | The web app's QoreX connection: the kit's provider types, EIP-6963 discovery by QoreX's rdns, the capability check and `qorexSignAndBroadcast`, in place of hand-written types | this PR |
| **MCP + qore CLI** (`@qorechain/mcp`, `@qorechain/qore-cli`) | **in use** | An AI agent should audit itself with the chain's own AI tooling: `pnpm agent audit` replays the receipts against the chain through the QoreChain MCP server (each transaction's status and its hybrid ML-DSA-87 layer verified against the signer's registered key, the owner's key and proof of possession). A project `.mcp.json` lets the owner's own assistant ask the same questions; `qore` covers the runbook's one-off checks | `agent/audit.ts`, `agent/qorechain-mcp.ts`, `.mcp.json`; audit of the live log: 8 of 8 transactions agree, all hybrid-verified ([spikes.md](spikes.md)) |
| **QoreScan** (`@qorechain/qorescan`) | **in use** | A cryptographic inventory (CycloneDX CBOM) of what the Bidder depends on: the testnet and the TLS endpoints the agent and relayer talk to. It backs the threat model's "what is post-quantum and what is not" with a machine-readable inventory, and found what the threat model had missed: the endpoints' TLS key exchange is hybrid ML-KEM, but their certificates are ECDSA | `pnpm cbom`, `docs/cbom/`, `test/cbom.test.ts` |
| **Handles** (`@qorechain/handles`) | no | Handles turn a name a person types into an address. In the Bidder nobody types a counterparty's address: the owner and the agent are bound by keys at setup (the agent's file names its owner, the mandate is checked against that owner's on-chain key, the card against the agent account's), and the auctions are contracts. Resolving a name there would add the registry as a new party to trust on a path that has none today. The owner's handle is also bound to a QoreX wallet, not to the CLI owner account | — |
| **Custody kit** | no | Its core rule is to verify a hybrid transaction against the signer's registered key before broadcasting it. The relayer signs and broadcasts in one call (qore-pq-kit's `broadcast`), and the agent's audit already verifies every relayed transaction's layer afterwards through the MCP server. Splitting signing from broadcasting just to check the relayer's own signature would add code with nothing to catch. The kit is also unpublished, so it could only be declared | — |
| **Wallet adapter** | no | It makes Keplr or Leap sign QoreChain transactions by holding the account's ML-DSA-87 key in the page. The owner's ML-DSA key is the one thing that must never leave the owner's machine (it alone can raise the agent's limits); QoreX already signs hybrid transactions without exposing it | — |
| **create-qorechain-dapp** | no | The repository was not scaffolded from it; listing it would be untrue | — |
| **RDK** | no | No rollup: the Bidder's job is one bid on the main chain | — |
| **Asset Kit** | no | Regulated-asset modules (ERC-3643, vaults) that need a chain upgrade; the Bidder holds fUSD, not a regulated asset | — |
| **Chain bridge** | no | Licences, contract deployment on three VMs, light-node registration: none is a Bidder job. Its relayer needs one message type, already built with the SDK | — |
| **PQ light client** | no | QoreChain does not produce the checkpoints yet (`fetchCheckpoint` always rejects `REQUIRES_CHAIN_SUPPORT`), so it cannot check any state the agent acts on. Worth adopting the day the chain signs checkpoints | — |

## Network features

The addresses to list on the project page are the Bidder's three accounts (owner, agent account, relayer); see [the final list](#what-to-tick-on-the-project-page).

| Feature | Use | Evidence | Status |
|---|---|---|---|
| **Hybrid ML-DSA-87 transactions** | yes | every native transaction of the three accounts | verifies today |
| **PQC key registration with proof of possession** | yes | the three `MsgRegisterPQCKeyV2` ([spikes.md](spikes.md)) | verifies today |
| **EVM window (incl. scoped)** | yes | the agent account's own windows (`pnpm demo:window`, 24 November: one call landed, the chain refused calls off target, over the count, over the value and after expiry) and the owner's window scoped to fUSD for the approval | verifies today |
| **QoreSeal and the encryption key registry** | yes | the agent account's `MsgRegisterKEMKey` | verifies today |
| **Smart accounts and spending rules** | yes | the owner's spending rule and the agent's linked key; every bid is a `MsgExecuteEVM` under it | verifies today |
| **Test tokens fUSD, fETH, fBTC** | yes | fUSD is the budget: `MsgConvertCoin`, `approve`, escrow, claims | verifies today |
| **AMM pools** | yes | The owner tops up the fUSD budget from QOR on the fUSD/QOR pool, priced by the chain's own quote with a minimum out, and converts the minimum to ERC-20 in the same transaction: `pnpm run owner topup` (`owner-cli/topup.ts`). Live: `3FF7C996…150D` | in use; verifies on the owner's address |
| **MCP server or qore CLI** | yes | `@qorechain/mcp` in `package.json`; the agent's audit | in use |
| **QoreScan** | yes | `@qorechain/qorescan` in `package.json`; the CBOM in `docs/cbom/` | in use |
| **Sign In With QoreChain** | yes | The owner pauses or resumes a running agent with a SIWQ message the agent verifies against the owner's on-chain key (`agent/control.ts`). Off chain by design, so DECLARED | in use |
| **Solidity PQC key status** | no | The agent reads `pqcKeyStatus` with `eth_call` from TypeScript; the Bidder has no contract of its own. Peal Tender and Peal Sealed Auction use it from Solidity | — |
| **Solidity PQC signature check** | no | As above | — |
| **Cross-VM EVM to Native** | no | The Bidder goes the other way (a native `MsgExecuteEVM` runs an EVM call); nothing calls native from the EVM | — |
| Staking tiers, IBC via QORel, RDK rollup, sidechain or paychain, light node, approved Native contracts, Asset Kit | no | none is part of placing a bid for an owner | — |

## What to tick on the project page

The final list, after all five kits pull requests (#18 to #22) are merged. VERIFIED means the site should find it; DECLARED means the site cannot see it and the box is ticked on the strength of the code.

**Testnet addresses to list** (all three are the Bidder's own throwaway accounts; none is the drill account):

| Address | Role | What the chain shows for it |
|---|---|---|
| `qor14ndj6q3zp7hku9a4hkjnmhvsk3kegf46g002j5` | Owner | hybrid transactions; ML-DSA-87 key with proof of possession; a scoped EVM window (opened and closed for the fUSD approval); the spending rule and the agent's linked key; fUSD conversion and approval; the AMM top-up |
| `qor1k7at260yd632szpqt8fguukwuf3l52fpfz8lur` | Agent account | ML-DSA-87 key; its ML-KEM-1024 key in the encryption key registry (`MsgRegisterKEMKey`); its own scoped EVM windows and one call inside them (`pnpm demo:window`) |
| `qor16tsewlj6jpt4v2esmrhuk7z2xems6e09z5rpzc` | Relayer | ML-DSA-87 key; every bid and claim, as hybrid-signed `MsgExecuteEVM` under the owner's spending rule |

**Kits to tick**

| Kit | Expected | Evidence |
|---|---|---|
| QoreChain SDK | VERIFIED | `@qorechain/sdk`, `@qorechain/evm` in `package.json` |
| qorechain-pqc | VERIFIED | `@qorechain/pqc`: the receipts' ML-DSA-87 (`agent/receipts.ts`) |
| QoreSign | VERIFIED | `@qorechain/qoresign`: mandate signatures, hybrid transactions, Sign In With QoreChain |
| QoreSeal | VERIFIED | `@qorechain/qoreseal`: mandates sealed to the agent's ML-KEM-1024 key |
| QoreX integrations | VERIFIED | `@qorechain/qorex-types`: the web app's QoreX connection |
| MCP + qore CLI | VERIFIED | `@qorechain/mcp`, `@qorechain/qore-cli`: `pnpm agent audit`, `.mcp.json` |
| QoreScan | VERIFIED | `@qorechain/qorescan`: `pnpm cbom`, `docs/cbom/` |

Leave unticked: create-qorechain-dapp, Wallet adapter, RDK, Asset Kit, Custody kit, Chain bridge, Handles, PQ light client (reasons above).

**Network features to tick**

| Feature | Expected | Evidence |
|---|---|---|
| Hybrid ML-DSA-87 transactions | VERIFIED | every transaction of the three accounts, e.g. the bid `27CAB8D0…ED61`; the audit verified the layer on all 14 relayed ones |
| PQC key registration with proof of possession | VERIFIED | `41A99E6D…E5F8` (owner), `DC3E3F91…4DE5` (agent account), `1C13DC5B…79B8` (relayer) |
| EVM window (incl. scoped) | VERIFIED | the agent account's window scoped to fUSD, `53530E8D…C043`, its call inside `02C0C8E2…AB5E`, closed by `702BC899…1502` (`pnpm demo:window`); the owner's window scoped to fUSD, `F4AB3A44…4219`, closed by `2A42A368…B455` |
| QoreSeal and the encryption key registry | VERIFIED | the agent account's `MsgRegisterKEMKey`, `69839690…C325` |
| Smart accounts and spending rules | VERIFIED | the link with the spending rule, `249EC850…F8D2`; the chain's refusals `4012FE2E…C3A9` (per-bid limit) and `B1E1DAD2…A13C` (daily limit); again on 24 November: link `85424ED4…48B6`, refusals `E072DB5A…F0DD` (per-bid), `38D5FFC1…3D89` (daily), `E7BFB205…4E88` (contract), `77CA465A…35C8` (function), `4D659EE2…C34C` (token), `317F7D5D…F3A1` (key expiry) |
| Test tokens fUSD, fETH, fBTC | VERIFIED | fUSD: conversion `3D32143F…8520`, approval, escrow and claims |
| AMM pools | VERIFIED | the owner's top-up `3FF7C996…150D` (pool 2, fUSD/QOR) |
| MCP server or qore CLI | VERIFIED | `@qorechain/mcp` in `package.json` |
| QoreScan | VERIFIED | `@qorechain/qorescan` in `package.json` |
| Sign In With QoreChain | DECLARED | `agent/control.ts`: the owner's pause and resume, checked against the owner's on-chain key; live run in [spikes.md](spikes.md). It leaves no trace on chain, so the site cannot verify it |

Leave unticked: Solidity PQC signature check, Solidity PQC key status (the Bidder has no contract; it reads `pqcKeyStatus` with `eth_call`), Staking tiers, IBC via QORel, Cross-VM EVM to Native, RDK rollup, Sidechain or paychain, Light node, Approved Native contracts, Asset Kit.
