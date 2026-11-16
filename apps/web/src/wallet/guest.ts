/**
 * guest.ts - a testnet owner, and its agent, that live in this browser.
 *
 * Ported from Peal Tender's guest account (`apps/dashboard/src/wallet/guest.ts`):
 * a fresh 24-word mnemonic from the browser's random source, kept in this
 * browser's storage only, with both keys (secp256k1 and ML-DSA-87) derived by
 * @qorechain/sdk. QoreChain admits an EVM transaction only from an account with a
 * registered ML-DSA-87 key and a live window, and MetaMask cannot make that
 * signature while QoreX does not send EVM transactions for pages yet, so this is
 * the account that acts.
 *
 * What is new for the Bidder: the same phrase also gives the visitor's agent.
 * Account 0 is the owner (signs mandates with ML-DSA-87). Account 1 is the agent:
 * its classical key, and seeds for its QoreSeal keys (to open mandates) and its
 * receipt key, are derived from account 1's private key, so restoring the phrase
 * restores the agent and its receipts key.
 *
 * Testnet only, for trying the app: the page warns, offers a backup, and can forget it.
 */
import { sha3_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { hexToBytes, type Hex } from "viem";
import type { UnifiedAccount } from "@qorechain/sdk";
import { CHAIN_ID, COMET_RPC, FUSD, FUSD_DENOM, NATIVE_FEE, REST } from "../config.ts";
import { evm, rest } from "../chain.ts";

const STORE = "peal-bidder.guest.v1";

export interface GuestStatus {
  evm: string;
  cosmos: string;
  /** Native balance in uqor. */
  uqor: bigint;
  /** fUSD held as the bank coin (how the faucet pays it). */
  fusdBank: bigint;
  /** fUSD held as the ERC-20 (what an auction takes). */
  fusdErc20: bigint;
  keyRegistered: boolean;
  keyIsOurs: boolean;
}

export interface Guest {
  owner: UnifiedAccount;
  agent: UnifiedAccount;
  /** 32-byte seeds for the agent's QoreSeal keys and receipt key. */
  sealSeed: Uint8Array;
  receiptSeed: Uint8Array;
}

type Log = (line: string) => void;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function savedMnemonic(): string | undefined {
  try {
    return storage()?.getItem(STORE) ?? undefined;
  } catch {
    return undefined;
  }
}

async function sdk() {
  return import("@qorechain/sdk");
}

let cached: { mnemonic: string; guest: Guest } | undefined;

function seed(label: string, privateKey: string): Uint8Array {
  return sha3_256(new Uint8Array([...utf8ToBytes(`peal-bidder/web/${label}/v1\n`), ...hexToBytes(privateKey as Hex)]));
}

export async function load(): Promise<Guest | undefined> {
  const m = savedMnemonic();
  if (!m) return undefined;
  if (cached?.mnemonic === m) return cached.guest;
  const s = await sdk();
  const [owner, agent] = await Promise.all([s.deriveUnifiedAccount(m, 0), s.deriveUnifiedAccount(m, 1)]);
  const guest = { owner, agent, sealSeed: seed("seal", agent.privateKey), receiptSeed: seed("receipt", agent.privateKey) };
  cached = { mnemonic: m, guest };
  return guest;
}

export async function create(): Promise<Guest> {
  const s = await sdk();
  storage()?.setItem(STORE, s.generateMnemonic(256));
  return (await load())!;
}

export async function importMnemonic(m: string): Promise<Guest> {
  const s = await sdk();
  const words = m.trim().split(/\s+/).join(" ");
  if (!s.validateMnemonic(words)) throw new Error("That is not a valid recovery phrase.");
  storage()?.setItem(STORE, words);
  return (await load())!;
}

export function forget(): void {
  storage()?.removeItem(STORE);
  cached = undefined;
}

// ---------------------------------------------------------------- reading

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export async function status(acc: UnifiedAccount): Promise<GuestStatus> {
  const s = await sdk();
  const [bal, pqc, erc] = await Promise.all([
    rest<{ balances: { denom: string; amount: string }[] }>(`/cosmos/bank/v1beta1/balances/${acc.cosmos}`),
    s.fetchPqcStatus({ rest: REST, address: acc.cosmos }),
    evm.readContract({ address: FUSD, abi: erc20, functionName: "balanceOf", args: [acc.evm as Hex] }).catch(() => 0n),
  ]);
  const coin = (d: string) => BigInt(bal?.balances.find((b) => b.denom === d)?.amount ?? "0");
  return {
    evm: acc.evm,
    cosmos: acc.cosmos,
    uqor: coin("uqor"),
    fusdBank: coin(FUSD_DENOM),
    fusdErc20: erc as bigint,
    keyRegistered: pqc.registered,
    keyIsOurs: pqc.registered ? s.isRegisteredPqcKey(pqc, acc.pqc.publicKey) !== false : false,
  };
}

// ---------------------------------------------------------------- native (hybrid-signed) transactions

async function broadcast(acc: UnifiedAccount, messages: { typeUrl: string; value: unknown }[], mode: "hybrid" | "classical" = "hybrid") {
  const s = await sdk();
  const { StargateClient } = await import("@cosmjs/stargate");
  const a = await rest<{ account?: Record<string, unknown> }>(`/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
  const base = (a?.account?.base_account ?? a?.account ?? {}) as Record<string, string>;
  const signer = new s.EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(COMET_RPC);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber: BigInt(base.account_number ?? "0"),
      sequence: BigInt(base.sequence ?? "0"),
      fee: NATIVE_FEE,
      messages: messages as never,
    });
    if (res.code !== 0) throw new Error(`transaction ${res.transactionHash} failed (code ${res.code}): ${res.rawLog ?? ""}`);
    return res.transactionHash as string;
  } finally {
    transport.disconnect();
  }
}

/** Register the owner's ML-DSA-87 key with a proof of possession (the one message the chain takes classically signed). */
export async function registerKey(acc: UnifiedAccount, log: Log): Promise<string | undefined> {
  const s = await sdk();
  const st = await status(acc);
  if (st.keyRegistered) {
    if (!st.keyIsOurs) throw new Error("A different post-quantum key is registered for this account.");
    log("Your ML-DSA-87 key is already on chain.");
    return undefined;
  }
  if (st.uqor < 300_000n) throw new Error("The account needs a little test QOR first (about 0.3) to pay for registering its key.");
  log("Registering your ML-DSA-87 key on chain…");
  const proof = s.signProofOfPossession({ chainId: CHAIN_ID, account: acc.cosmos, keypair: acc.pqc });
  const msg = s.buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: proof });
  const tx = await broadcast(acc, [msg], "classical");
  log(`Key registered (tx ${tx.slice(0, 10)}…).`);
  return tx;
}
