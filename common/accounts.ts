/**
 * Accounts and the key split.
 *
 * Every account is a QoreChain unified account (eth_secp256k1 + ML-DSA-87,
 * both from one BIP-39 mnemonic). The ML-DSA-87 key is derived from the
 * mnemonic and the address, so it cannot be computed from the classical
 * private key: handing the agent only its classical key gives it no way to
 * produce the post-quantum half of a signature, and so no way to open its
 * own windows or change its own limits.
 */
import { classicalKeyFromPrivate, type ClassicalKey, type PqKeyPair } from "@qorechain/qoresign";
import { deriveUnifiedAccount, generateMnemonic, type UnifiedAccount } from "@qorechain/sdk";
import { loadSecrets, writeSecrets } from "qore-pq-kit";
import { hexToBytes, type Hex } from "viem";

export interface AccountInfo {
  cosmos: string;
  evm: string;
}

/** Make a fresh account and write its mnemonic to `path` (0600, never overwritten). Returns the addresses only. */
export async function createAccount(path: string, label: string): Promise<AccountInfo> {
  const mnemonic = generateMnemonic(256);
  const acc = await deriveUnifiedAccount(mnemonic, 0);
  writeSecrets(
    path,
    { QORE_MNEMONIC: mnemonic, QOR_ADDRESS: acc.cosmos, EVM_ADDRESS: acc.evm },
    [
      `Peal Bidder: ${label}, QoreChain testnet (qorechain-diana), created ${new Date().toISOString()}.`,
      "QORE_MNEMONIC restores both the classical and the ML-DSA-87 key. Never commit or share this file.",
    ].join("\n"),
  );
  return { cosmos: acc.cosmos, evm: acc.evm };
}

/** Load a unified account from a mnemonic file. */
export async function loadAccount(path: string): Promise<UnifiedAccount> {
  const s = loadSecrets(path);
  if (!s.QORE_MNEMONIC) throw new Error(`QORE_MNEMONIC missing in ${path}`);
  const acc = await deriveUnifiedAccount(s.QORE_MNEMONIC, 0);
  if (s.QOR_ADDRESS && s.QOR_ADDRESS !== acc.cosmos) throw new Error(`${path}: the mnemonic does not give ${s.QOR_ADDRESS}`);
  return acc;
}

/** The address of an account file, without deriving any key. */
export function accountAddress(path: string): AccountInfo {
  const s = loadSecrets(path);
  if (!s.QOR_ADDRESS || !s.EVM_ADDRESS) throw new Error(`QOR_ADDRESS or EVM_ADDRESS missing in ${path}`);
  return { cosmos: s.QOR_ADDRESS, evm: s.EVM_ADDRESS };
}

/** The same account's keys in QoreSign's shape (for message signatures and cards). */
export function qoreSignKeys(acc: UnifiedAccount): { address: string; classicalKey: ClassicalKey; pqKey: PqKeyPair } {
  return {
    address: acc.cosmos,
    classicalKey: classicalKeyFromPrivate(hexToBytes(acc.privateKey as Hex), "eth_secp256k1"),
    pqKey: { algorithmId: 1, publicKey: acc.pqc.publicKey, secretKey: acc.pqc.secretKey },
  };
}

/** What the agent process gets: its account's classical key, and whom it serves. */
export interface AgentAccountFile {
  privateKey: Hex;
  cosmos: string;
  evm: string;
  owner: string;
}

/**
 * Owner side: give the agent its account's classical private key, and nothing
 * else of the account. The mnemonic (and with it the ML-DSA-87 key) stays in
 * the owner's folder.
 */
export async function exportAgentAccount(agentAccountPath: string, agentFile: string, owner: string): Promise<AccountInfo> {
  const acc = await loadAccount(agentAccountPath);
  writeSecrets(
    agentFile,
    { PRIVATE_KEY: acc.privateKey, QOR_ADDRESS: acc.cosmos, EVM_ADDRESS: acc.evm, OWNER: owner },
    [
      `Peal Bidder agent account, QoreChain testnet, exported ${new Date().toISOString()}.`,
      "PRIVATE_KEY is the classical secp256k1 key ONLY. The ML-DSA-87 key stays with the owner,",
      "so this key cannot open EVM windows, register keys or change spending rules. Never commit this file.",
    ].join("\n"),
  );
  return { cosmos: acc.cosmos, evm: acc.evm };
}

export function loadAgentAccount(path: string): AgentAccountFile {
  const s = loadSecrets(path);
  if (s.QORE_MNEMONIC) throw new Error(`${path} holds a mnemonic; the agent must hold its classical key only`);
  if (!s.PRIVATE_KEY || !s.QOR_ADDRESS || !s.EVM_ADDRESS || !s.OWNER) {
    throw new Error(`${path} must set PRIVATE_KEY, QOR_ADDRESS, EVM_ADDRESS and OWNER`);
  }
  return { privateKey: s.PRIVATE_KEY as Hex, cosmos: s.QOR_ADDRESS, evm: s.EVM_ADDRESS, owner: s.OWNER };
}
