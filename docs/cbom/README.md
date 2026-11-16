# Cryptographic inventory

Written by `pnpm cbom` with QoreScan (`@qorechain/qorescan`) on 2026-11-16T21:41:39Z; the full CycloneDX 1.6 CBOM is [peal-bidder.cdx.json](peal-bidder.cdx.json). QoreScan's output is an inventory aid, not a certification. What it means for the Bidder is in [THREAT_MODEL.md](../../THREAT_MODEL.md#cryptographic-inventory).

Chain: `qorechain-diana`. Protocol features reported: `pqc-sign-bytes-v2`, `evm-pqc-authorisation-window`, `pqc-ecdsa-pubkey-validation`, `pqc-keyed-account-maintenance-hybrid`, `pqc-registration-integrity`, `pqc-rotation-replay-guard`, `pqc-algorithm-governance-guards`, `pqc-hybrid-single-extension`, `pqc-keyless-extension-closed`, `evm-pqc-window-targets`, `pqc-possession-flag`, `pqc-kem-registry`, `pqc-rotate-key-size-check`, `pqc-verify-once-per-signer`, `pqc-multisig`, `pqc-verify-gas-calibrated`, `pqc-consent-authz-limiter`, `pqc-consent-outer-signer`, `pqc-rotation-ends-evm-consent`, `pqc-degenerate-key-refused`, `svm-pqc-key-lane-gated`, `pqc-registration-ends-evm-consent`, `pqc-consent-own-message`, `svm-pqc-key-for-wallets`.

## The Bidder's accounts

| Role | Address | ML-DSA-87 key | ML-KEM-1024 key |
|---|---|---|---|
| Owner | `qor14ndj6q3zp7hku9a4hkjnmhvsk3kegf46g002j5` | registered (hybrid) | — |
| Relayer | `qor16tsewlj6jpt4v2esmrhuk7z2xems6e09z5rpzc` | registered (hybrid) | — |
| Agent account | `qor1k7at260yd632szpqt8fguukwuf3l52fpfz8lur` | registered (hybrid) | registered |

## The endpoints the agent, relayer and owner talk to

| Endpoint | TLS key exchange | Class |
|---|---|---|
| `api-testnet.qore.host:443` | X25519MLKEM768 | hybrid |
| `evm-testnet.qore.host:443` | X25519MLKEM768 | hybrid |
| `rpc-testnet.qore.host:443` | X25519MLKEM768 | hybrid |

Certificate keys on those endpoints: ECDSA P-256 (quantum-vulnerable), ECDSA P-384 (quantum-vulnerable).

Validator consensus keys: 4 × Ed25519.

## Algorithms found

| Algorithm | Class | NIST PQ level |
|---|---|---|
| AES-128-GCM | symmetric | 1 |
| ECDSA P-256 | quantum-vulnerable | 0 |
| ECDSA P-384 | quantum-vulnerable | 0 |
| ECDSA secp256k1 | quantum-vulnerable | 0 |
| ECDSA with SHA-256 | quantum-vulnerable | 0 |
| ECDSA with SHA-384 | quantum-vulnerable | 0 |
| Ed25519 | quantum-vulnerable | 0 |
| HKDF-SHA256 | symmetric | — |
| Keccak-256 | symmetric | — |
| ML-DSA-87 | post-quantum | 5 |
| ML-KEM-1024 | post-quantum | 5 |
| RSA PKCS#1 v1.5 with SHA-256 | quantum-vulnerable | 0 |
| SHA-256 | symmetric | 2 |
| X25519MLKEM768 | hybrid | 3 |
