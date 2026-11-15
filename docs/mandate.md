# PealMandate v1

A mandate is what an owner allows its agent to do. It travels signed by the owner and sealed to the agent.

## Fields

All fields are required; no others are allowed.

| Field | Type | Meaning |
|---|---|---|
| `type` | `"PealMandate"` | |
| `version` | `1` | |
| `chainId` | string | Cosmos chain id; must be the agent's network (`qorechain-diana`) |
| `evmChainId` | integer | EVM chain id; must be the agent's network (`9800`) |
| `owner` | `qor1…` (lower case) | The signer. The agent serves exactly one owner |
| `agent` | `qor1…` (lower case) | The only agent that may act on it; differs from `owner` |
| `quoteToken` | `0x…` (lower case) | The token budgets are counted in (fUSD) |
| `auctions` | 1 to 16 distinct `0x…` (lower case) | The only auctions the agent may bid in |
| `budget` | decimal string, > 0 | Total quote-token outflow (escrow plus bond, base units) across all bids |
| `maxPerBid` | decimal string, > 0, ≤ `budget` | Largest outflow of one bid |
| `maxTick` | integer 0 to 65,535 | Highest price tick |
| `maxBids` | integer 1 to 1,000 | Most bids under this mandate |
| `notBefore` | integer, Unix seconds | Refused before this time |
| `expiresAt` | integer, Unix seconds | Refused from this time on; after `notBefore`, at most 30 days later |
| `nonce` | integer ≥ 1 | Strictly increasing per owner; a mandate replaces every one with a lower nonce |
| `receiptKey` | 64 lower-case hex digits | SHA3-256 of the agent's ML-DSA-87 receipt public key |
| `instructions` | string, ≤ 2,000 characters | Plain-English preferences. Advisory: they cannot widen any limit |

Amounts are decimal strings because they can exceed 2^53.

## Encoding

Canonical JSON (`common/canonical.ts`): keys sorted, printable ASCII keys, no whitespace, safe integers only, `JSON.stringify` string escaping. The verifier re-encodes what it parsed and refuses the mandate unless the result is byte-identical (which also refuses duplicate keys).

`mandateHash` = hex SHA3-256 of the canonical text.

## Signature

The owner signs `"peal-bidder/mandate/v1\n" + canonicalText` with QoreSign `signMessage` (secp256k1 ADR-36 + ML-DSA-87 over `"qorechain-msg-v1|" + chainId + "|" + data`). The agent verifies with `verifyMessage({ requirePq: true })` against the ML-DSA-87 key the chain reports for `owner` through the `pqcKeyStatus` precompile.

## Envelope

The envelope plaintext is `{"v":1,"mandate":<canonical text>,"signature":<QoreSign MessageSignature>}`. It is sealed with QoreSeal (hybrid ML-KEM-1024 + X25519 by default) under:

- purpose `peal-bidder/mandate/v1`;
- AAD `"peal-bidder/mandate/v1|" + owner + "|" + agent`;

and delivered as `qoreseal:` text.

## Refusals

The agent checks, in order, and stops at the first failure:

| Code | When |
|---|---|
| `ENVELOPE_MALFORMED` | Not `qoreseal:` text |
| `SEAL_OPEN_FAILED` | Does not open with the agent's keys under this purpose, chain and AAD |
| `PAYLOAD_MALFORMED` | The plaintext is not a signed mandate |
| `NOT_CANONICAL` | The mandate text is not canonical JSON |
| `SCHEMA_INVALID` | A field is missing, extra, of the wrong type or inconsistent |
| `WRONG_CHAIN` | `chainId` or `evmChainId` is not the agent's network |
| `WRONG_AGENT` | `agent` is not this agent |
| `WRONG_OWNER` | `owner` is not this agent's owner |
| `SIGNATURE_NOT_PQ` | The signature has no ML-DSA-87 part |
| `OWNER_KEY_UNAVAILABLE` | The owner's key cannot be read from the chain (fails closed) |
| `SIGNATURE_INVALID` | The hybrid signature does not verify |
| `NOT_YET_VALID` / `EXPIRED` | Outside `[notBefore, expiresAt)` |
| `RECEIPT_KEY_MISMATCH` | `receiptKey` is not this agent's receipt key |
| `REPLAYED` | `nonce` is not above the last accepted nonce |

Fields are compared before the signature is checked only to refuse; nothing is acted on until every check passes. A refused mandate does not consume its nonce.
