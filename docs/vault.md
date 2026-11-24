# The vault

**`contracts/src/BidderVault.sol`. Not audited. Testnet only.** State on 24 November 2026: built and tested locally; not deployed, and no bid has gone through it on the testnet.

## Why

In the live runs the budget sat on the owner's account. The chain counts the auction's escrow pull as a token transfer from that account, so the agent's spending rule had to list fUSD, and a rule that lists a token lets the linked key transfer it, within the limits, to anyone. With the budget in a contract, the bid is the contract's transfer, not the account's, and the rule need not list fUSD.

```
 agent's linked key ── MsgExecuteEVM ──▶ owner's 0x address ── vault.bid(auction, …) ──▶ BidderVault ── commitBid ──▶ SealedAuction
                      rule: vault.bid and claim only,              limits, approved       the bidder     escrow + bond
                      no token the account holds                   auctions, expiry       on chain
 owner's ML-DSA-87 key ── signature, carried by anyone ──▶ setPolicy · revoke · sweep (pays the owner)
 anyone ──▶ auction.claim(bidId) ──▶ pays the vault
```

## What each function allows

| Function | Who | What it checks |
|---|---|---|
| `bid` | the policy's `operator` | not expired; an approved auction; bid count; per bid (escrow + bond); per UTC day; budget; an exact allowance, taken back; exactly escrow + bond left |
| `setPolicy` | the owner's ML-DSA-87 signature, anyone carries it | `PqAuth` (chain, vault, action, nonce, deadline within an hour, arguments); factory-made auctions, each with the hash of its configuration; paid in the vault's token; a sale token that accepts the vault; at most 16 auctions and 30 days. Replaces everything but the day's spending |
| `revoke` | same | stops all bidding, starts the exit clock |
| `sweep` | same | pays the owner's account, whoever carries it |
| `sweepAfterExit` | anyone, 14 days after the expiry (or the deployment, before a first policy) | pays the owner's account; needs no precompile |
| claim | anyone, on the auction | pays the bidder, which is the vault |

The operator on the smart-account lane is the owner's own 0x address, because that is who the linked key acts as. So `msg.sender == owner` authorises nothing but a bid. On the EVM lane the operator is the agent account, inside a window that admits only the vault (`--operator agent`, `--executor window --vault 0x…`).

## The spending rule

`allowedDenoms` holds one token the owner does not hold (fBTC), with a limit of one base unit; `allowedEvmCalls` holds `vault.bid` and `claim` on the named auctions. **The list is never empty: an empty list means any token** (`test/vault.test.ts` holds that the SDK refuses it here). `owner link --vault` reads the owner's balance of that token, as ERC-20 and as bank coins, and refuses to write the rule unless both are zero.

## What is tested

`( cd contracts && forge test )`, after `pnpm install`:

- 54 tests and 4 invariants (money only in the vault, the approved auctions, burned bonds or the owner's account; no allowance left; policy limits; the daily limit across policies), against a pinned, unmodified copy of Peal Sealed Auction's contracts. The pinned implementation, built here, equals the deployed one at `0xd4A1…62B3` byte for byte, apart from the compiler's metadata trailer (compared on 24 November).
- 50 hand-made mutants of the contract: all 50 fail the tests. The three that survived the design spike (allowance reset, wrong quote token, outflow check) have their own tests.
- Local EVMs have no PQC precompiles: the tests use qore-pq-kit's mocks. The TypeScript side signs with real ML-DSA-87 and checks the same message.

## What it does not stop

Whoever steals the agent's key can, inside the limits, overpay in an approved auction, burn bonds and lock the budget until settlement. The full list is in [THREAT_MODEL.md](../THREAT_MODEL.md#the-vault-contractssrcbiddervaultsol-built-not-audited-not-yet-used-on-the-testnet).
