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
| **QoreSign** (`@qorechain/qoresign`) | **in use** | Hybrid signing of every native transaction, the mandate's signature; plus **Sign In With QoreChain**: the owner pauses or resumes a running agent (`pnpm owner pause`), checked against the owner's on-chain ML-DSA-87 key | in use; SIWQ in `agent/control.ts` |
| **QoreSeal** (`@qorechain/qoreseal`) | yes | Mandates sealed to the agent's ML-KEM-1024 key; the agent's key in the on-chain encryption key registry | in use |
| **QoreX integrations** (`@qorechain/qorex-types`) | yes | The web app's QoreX connection: the kit's provider types, EIP-6963 discovery by QoreX's rdns, the capability check and `qorexSignAndBroadcast`, in place of hand-written types | this PR |
| **MCP + qore CLI** (`@qorechain/mcp`, `@qorechain/qore-cli`) | **in use** | An AI agent should audit itself with the chain's own AI tooling: `pnpm agent audit` replays the receipts against the chain through the QoreChain MCP server (each transaction's status and its hybrid ML-DSA-87 layer verified against the signer's registered key, the owner's key and proof of possession). A project `.mcp.json` lets the owner's own assistant ask the same questions; `qore` covers the runbook's one-off checks | `agent/audit.ts`, `agent/qorechain-mcp.ts`, `.mcp.json`; audit of the live log: 8 of 8 transactions agree, all hybrid-verified ([spikes.md](spikes.md)) |
| **QoreScan** (`@qorechain/qorescan`) | **in use** | A cryptographic inventory (CycloneDX CBOM) of what the Bidder depends on: the testnet and the TLS endpoints the agent and relayer talk to. It backs the threat model's "what is post-quantum and what is not" with a machine-readable inventory, and found what the threat model had missed: the endpoints' TLS key exchange is hybrid ML-KEM, but their certificates are ECDSA | `pnpm cbom`, `docs/cbom/`, `test/cbom.test.ts` |
| **Handles** (`@qorechain/handles`) | yes, small | The agent learns which owner it serves; an `@handle` resolved through the signature-checked registry and **pinned on the agent's machine** (trust on first use) makes a later registry change stop the agent instead of redirecting it | follow-up PR, if time allows |
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
| **EVM window (incl. scoped)** | yes | the owner's window scoped to fUSD for the approval | verifies today |
| **QoreSeal and the encryption key registry** | yes | the agent account's `MsgRegisterKEMKey` | verifies today |
| **Smart accounts and spending rules** | yes | the owner's spending rule and the agent's linked key; every bid is a `MsgExecuteEVM` under it | verifies today |
| **Test tokens fUSD, fETH, fBTC** | yes | fUSD is the budget: `MsgConvertCoin`, `approve`, escrow, claims | verifies today |
| **AMM pools** | yes | The owner tops up the fUSD budget from QOR on the fUSD/QOR pool (pool 2), with a minimum-out computed from the pool's reserves: `pnpm owner topup` | follow-up PR, one small swap |
| **MCP server or qore CLI** | yes | `@qorechain/mcp` in `package.json`; the agent's audit | in use |
| **QoreScan** | yes | `@qorechain/qorescan` in `package.json`; the CBOM in `docs/cbom/` | in use |
| **Sign In With QoreChain** | yes | The owner pauses or resumes a running agent with a SIWQ message the agent verifies against the owner's on-chain key (`agent/control.ts`). Off chain by design, so DECLARED | in use |
| **Solidity PQC key status** | no | The agent reads `pqcKeyStatus` with `eth_call` from TypeScript; the Bidder has no contract of its own. Peal Tender and Peal Sealed Auction use it from Solidity | — |
| **Solidity PQC signature check** | no | As above | — |
| **Cross-VM EVM to Native** | no | The Bidder goes the other way (a native `MsgExecuteEVM` runs an EVM call); nothing calls native from the EVM | — |
| Staking tiers, IBC via QORel, RDK rollup, sidechain or paychain, light node, approved Native contracts, Asset Kit | no | none is part of placing a bid for an owner | — |

## What to tick on the project page

Filled in as each PR lands; the final list is at the end of the last PR.
