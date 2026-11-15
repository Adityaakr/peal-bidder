/**
 * Test accounts: fresh random keys per run. No mnemonic or key is ever stored
 * in the repository.
 */
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { addressFromPublicKey, deriveCanonicalPqKey, deriveClassicalKey, type ClassicalKey, type PqKeyPair } from "@qorechain/qoresign";
import { generateSealKeys, recipientOf, type SealKeyPair, type SealRecipient } from "@qorechain/qoreseal";
import { buildMandate, type PealMandateV1 } from "../common/mandate.ts";
import { FUSD } from "../common/network.ts";
import { generateReceiptKey, receiptKeyHash, type ReceiptKey } from "../agent/receipts.ts";

export interface TestAccount {
  address: string;
  hex: string;
  classicalKey: ClassicalKey;
  pqKey: PqKeyPair;
}

export function newAccount(): TestAccount {
  const mnemonic = generateMnemonic(wordlist, 256);
  const classicalKey = deriveClassicalKey({ mnemonic, type: "eth_secp256k1" });
  const addr = addressFromPublicKey(classicalKey.publicKey, "eth_secp256k1");
  const pqKey = deriveCanonicalPqKey({ mnemonic, address: addr.bech32 });
  return { address: addr.bech32, hex: addr.hex, classicalKey, pqKey };
}

export interface TestAgent extends TestAccount {
  sealKeys: SealKeyPair;
  recipient: SealRecipient;
  receiptKey: ReceiptKey;
}

export function newAgent(): TestAgent {
  const account = newAccount();
  const sealKeys = generateSealKeys();
  return { ...account, sealKeys, recipient: recipientOf(sealKeys), receiptKey: generateReceiptKey() };
}

export const AUCTION_A = "0x1111111111111111111111111111111111111111";
export const AUCTION_B = "0x2222222222222222222222222222222222222222";
export const NOW = 1_795_000_000;

export function sampleMandate(owner: TestAccount, agent: TestAgent, over: Partial<PealMandateV1> = {}): PealMandateV1 {
  const fields = {
    owner: owner.address,
    agent: agent.address,
    quoteToken: FUSD,
    auctions: [AUCTION_A],
    budget: "500000000", // 500 fUSD
    maxPerBid: "100000000", // 100 fUSD
    maxTick: 40,
    maxBids: 5,
    notBefore: NOW - 60,
    expiresAt: NOW + 86_400,
    nonce: 1,
    receiptKey: receiptKeyHash(agent.receiptKey.publicKey),
    instructions: "Buy PEAL-T in the treasury buyback. Prefer a fair price; never chase the top tick.",
  };
  return buildMandate({ ...fields, ...over });
}
