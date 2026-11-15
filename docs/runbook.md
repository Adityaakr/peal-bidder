# Runbook: Peal Bidder on the testnet

Every step, in order, with what it costs and who runs it. Commands print addresses and hashes only, never a key.

**Status (16 November 2026):** steps 1, 2, 8, 9 and 12 are tested offline (`--offline`), and step 10's bid path (sealing, encoding, signing, relaying) against a fake chain. The steps that send transactions are written but not yet run: they wait for faucet funds, and steps 6 and 11 also wait for spike S2 ([spikes.md](spikes.md)).

Keys live in `~/.qore-peal-bidder/` (set `QORE_BIDDER_HOME` to move it): `owner/` (the owner's, the agent account's and the relayer's mnemonics) and `agent/` (the agent account's classical key, the agent's own keys, inbox, receipts, nonces).

| # | Who | Command | Sends | Needs |
|---|---|---|---|---|
| 1 | Owner | `pnpm owner init` | nothing | — |
| 2 | Agent | `pnpm agent init` | nothing | `agent/agent.env` from step 1 |
| 3 | Owner | Claim the faucet for the owner, agent-account and relayer addresses step 1 printed (the owner also gets fUSD) | — | the owner's dashboard sign-in |
| 4 | Owner | `pnpm owner register` | one classical `MsgRegisterPQCKeyV2` per account that has none (reads first; a repeat still costs its fee) | QOR on each account |
| 5 | Owner | `pnpm owner register-agent` | hybrid `MsgRegisterKEMKey` signed with the agent account's keys; writes `agent/card.json` (QoreSeal recipient card, signed by the agent account) | step 4 |
| 6 | Owner | `pnpm owner link --auctions 0x<auction> --budget 500 --max-per-bid 100 --max-tick 40 [--daily-limit 500] [--commit-bid-signature '<sig>'] [--dry-run]` | one hybrid tx: `MsgUpdateSpendingRules` + `MsgRegisterAuthenticator` (agent key, `evm` permission, expiry = the limits' end) | step 4; **S2** |
| 7 | Owner | `pnpm owner approve --spender 0x<auction> --amount 500` | opens a window scoped to fUSD for one tx, `approve`, closes the window | fUSD and QOR on the owner |
| 8 | Owner | `pnpm owner mandate --auctions 0x<auction> --budget 500 --max-per-bid 100 --max-tick 40 --max-bids 5 --hours 24 --instructions "..." --deliver` | nothing (writes `owner/outbox/<nonce>.qoreseal`, and with `--deliver` copies it to `agent/inbox/`) | step 5 (the card), or `--offline` |
| 9 | Agent | `pnpm agent receive` | nothing (reads the owner's key with `eth_call` to `pqcKeyStatus`) | step 4 for the owner, or `--offline` |
| 10 | Agent | `pnpm agent run --executor smart-account --rounds 3 --interval 30` (auctions read from the chain; `--factory 0x…` adds the issuer's text; `--auctions file.json` reads a file instead) | `MsgExecuteEVM` through the relayer. `--executor dry-run` (default) sends nothing | steps 6, 7, 11; **S2** |
| 11 | Ops | `pnpm relayer --targets 0x<auction>` | relays the agent's `MsgExecuteEVM` (fee from the relayer) | relayer QOR; **S2** |
| 12 | Anyone | `pnpm dashboard` | nothing | — |
| — | Owner | `pnpm owner window open --targets 0x<auction>,0x<factory> --blocks 3600 --max-txs 5` / `window close` | hybrid `MsgOpenEVMWindow` / `MsgCloseEVMWindow` for the agent account | step 4. Only on the fallback path (design R1), or for permissionless calls (open, finalize, claim) |
| — | Owner | Fallback path (design R1), if S2 fails: `pnpm owner fund-agent --amount 500`, `pnpm owner approve --from agent --spender 0x<auction> --amount 500`, `pnpm owner window open --targets 0x<auction> --max-txs 5`, then `pnpm agent run --executor window` | an fUSD transfer, an approval from the agent account, a window | QOR on owner and agent account |
| — | Owner | `pnpm owner rules ...` (same flags as `link`) | `MsgUpdateSpendingRules` only | step 6 |
| — | Owner | `pnpm owner revoke` | `MsgRevokeAuthenticator`: the agent's key stops working at once | step 6 |
| — | Anyone | `pnpm owner status`, `pnpm agent status`, `pnpm agent receipts` | nothing | — |

## Costs (estimates)

- A hybrid native transaction: the kit's fee of 0.15 QOR (1,000,000 gas).
- An EVM transaction: about 0.01 to 0.04 QOR at the testnet's 112.5 gwei.
- So one faucet claim (100 QOR) per account covers the demo many times over.

## Things that are easy to get wrong

- `MsgUpdateSpendingRules` replaces the owner account's rules wholesale, and the first enabled rule bounds every linked key without a rule of its own. `link` and `rules` write exactly one rule; an account with other linked keys needs their rules passed too.
- The agent's window must always be scoped (`--targets`); the CLI refuses an unscoped one. A scoped window cannot deploy contracts.
- Opening a window advances the account's EVM nonce (kit finding); the kit's `sendEvm` reads the nonce after opening.
- `link` and `rules` allow `commitBid(uint32,bytes32,bytes32,bytes32[],bytes[],uint256)`, the signature in Peal Sealed Auction's contract; `--commit-bid-signature` or `--commit-bid-selector` override it if the contract changes.
