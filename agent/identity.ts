/**
 * The agent's own keys: QoreSeal keys (to open mandates) and the ML-DSA-87
 * receipt key (to sign receipts). The agent makes them itself; the owner only
 * ever sees their public halves, in `public.json`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sealKeysFromSeed, type SealKeyPair } from "@qorechain/qoreseal";
import { loadSecrets, writeSecrets } from "qore-pq-kit";
import { loadAgentAccount, type AgentAccountFile } from "../common/accounts.ts";
import type { agentPaths } from "../common/home.ts";
import { generateReceiptKey, receiptKeyHash, type ReceiptKey } from "./receipts.ts";

type AgentPaths = ReturnType<typeof agentPaths>;

/** The public half of the agent's keys: what the owner needs to seal to it, register its KEM key and pin its receipt key. */
export interface AgentPublicInfo {
  v: 1;
  address: string;
  evm: string;
  owner: string;
  mlkemPublicKey: string;
  x25519PublicKey: string;
  receiptPublicKey: string;
  receiptKeyHash: string;
}

export interface AgentIdentity {
  account: AgentAccountFile;
  sealKeys: SealKeyPair;
  receiptKey: ReceiptKey;
  receiptKeyHash: string;
}

/** Make the agent's QoreSeal and receipt keys (once) and write `public.json`. */
export function initAgentKeys(paths: AgentPaths): AgentPublicInfo {
  const account = loadAgentAccount(paths.account);
  if (!existsSync(paths.keys)) {
    writeSecrets(
      paths.keys,
      { SEAL_SEED: bytesToHex(randomBytes(32)), RECEIPT_SEED: bytesToHex(randomBytes(32)) },
      [
        `Peal Bidder agent keys, created ${new Date().toISOString()}.`,
        "SEAL_SEED opens mandates sealed to this agent; RECEIPT_SEED signs its receipts. Never commit or share this file.",
      ].join("\n"),
    );
  }
  const id = loadAgentIdentity(paths);
  const info: AgentPublicInfo = {
    v: 1,
    address: account.cosmos,
    evm: account.evm,
    owner: account.owner,
    mlkemPublicKey: bytesToHex(id.sealKeys.mlkemPublicKey),
    x25519PublicKey: bytesToHex(id.sealKeys.x25519PublicKey),
    receiptPublicKey: bytesToHex(id.receiptKey.publicKey),
    receiptKeyHash: id.receiptKeyHash,
  };
  writeFileSync(paths.publicInfo, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
  return info;
}

export function loadAgentIdentity(paths: AgentPaths): AgentIdentity {
  const account = loadAgentAccount(paths.account);
  const s = loadSecrets(paths.keys);
  if (!s.SEAL_SEED || !s.RECEIPT_SEED) throw new Error(`${paths.keys} must set SEAL_SEED and RECEIPT_SEED`);
  const sealKeys = sealKeysFromSeed(hexToBytes(s.SEAL_SEED));
  const receiptKey = generateReceiptKey(hexToBytes(s.RECEIPT_SEED));
  return { account, sealKeys, receiptKey, receiptKeyHash: receiptKeyHash(receiptKey.publicKey) };
}

const HEX = /^[0-9a-f]+$/;

/** Read and check `public.json` (owner side). */
export function readAgentPublicInfo(path: string): AgentPublicInfo {
  const o = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const hex = (k: string, len: number) => {
    const v = o[k];
    if (typeof v !== "string" || !HEX.test(v) || v.length !== len * 2) throw new Error(`${path}: ${k} must be ${len} bytes of hex`);
    return v;
  };
  if (o.v !== 1 || typeof o.address !== "string" || typeof o.evm !== "string" || typeof o.owner !== "string") {
    throw new Error(`${path} is not an agent public info file`);
  }
  const info: AgentPublicInfo = {
    v: 1,
    address: o.address,
    evm: o.evm,
    owner: o.owner,
    mlkemPublicKey: hex("mlkemPublicKey", 1568),
    x25519PublicKey: hex("x25519PublicKey", 32),
    receiptPublicKey: hex("receiptPublicKey", 2592),
    receiptKeyHash: hex("receiptKeyHash", 32),
  };
  if (receiptKeyHash(hexToBytes(info.receiptPublicKey)) !== info.receiptKeyHash) throw new Error(`${path}: receiptKeyHash does not match`);
  return info;
}
