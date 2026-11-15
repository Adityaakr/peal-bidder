/**
 * The owner's transactions. Every one is signed by the owner, or by the agent
 * account with keys only the owner holds: the agent process never runs this.
 *
 * Native-lane transactions are hybrid-signed (secp256k1 + ML-DSA-87) through
 * qore-pq-kit's `broadcast`; EVM transactions go through the kit's `sendEvm`
 * inside a window opened just for them and closed straight after.
 */
import { evmWindowCost } from "@qorechain/evm";
import { signRecipientCard, type RecipientCard } from "@qorechain/qoreseal";
import {
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  fetchAuthenticators,
  fetchEvmWindow,
  fetchKemKey,
  fetchPqcStatus,
  fetchSpendingRules,
  isRegisteredPqcKey,
  msg,
  openEvmWindowMsg,
  signProofOfPossession,
  verifyProofOfPossession,
  type EncodeObject,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { balances, broadcast, network, publicClient, sendEvm } from "qore-pq-kit";
import { encodeFunctionData, erc20Abi, hexToBytes, type Hex } from "viem";
import { qoreSignKeys } from "../common/accounts.ts";
import type { AgentPublicInfo } from "../agent/identity.ts";

export interface TxOutcome {
  txHash: string;
  note?: string;
}

/** Register an account's ML-DSA-87 key (classically signed, the one exception). Reads first: a repeat still costs its fee. */
export async function registerPqKey(acc: UnifiedAccount): Promise<TxOutcome | undefined> {
  const net = network();
  const before = await fetchPqcStatus({ rest: net.rest, address: acc.cosmos });
  if (before.registered) {
    if (isRegisteredPqcKey(before, acc.pqc.publicKey) === false) {
      throw new Error(`${acc.cosmos} already has a DIFFERENT ML-DSA-87 key registered; not sending`);
    }
    return undefined;
  }
  const proofOfPossession = signProofOfPossession({ chainId: net.chainId, account: acc.cosmos, keypair: acc.pqc });
  if (!verifyProofOfPossession({ chainId: net.chainId, account: acc.cosmos, publicKey: acc.pqc.publicKey, proof: proofOfPossession })) {
    throw new Error("the proof of possession does not verify locally; not sending");
  }
  const res = await broadcast(acc, [buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession })], "classical");
  return { txHash: res.transactionHash };
}

/** Publish the agent's ML-KEM-1024 key, hybrid-signed with the agent account's keys (held by the owner). */
export async function registerAgentKem(agentAccount: UnifiedAccount, info: AgentPublicInfo): Promise<TxOutcome | undefined> {
  if (info.address !== agentAccount.cosmos) throw new Error("public.json belongs to another account");
  const net = network();
  const current = await fetchKemKey({ rest: net.rest, address: agentAccount.cosmos });
  const wanted = hexToBytes(`0x${info.mlkemPublicKey}`);
  if (current.found && current.key && Buffer.from(current.key.publicKey).equals(Buffer.from(wanted))) return undefined;
  const res = await broadcast(agentAccount, [msg.pqc.registerKemKey({ sender: agentAccount.cosmos, algorithmId: 2, publicKey: wanted })]);
  return { txHash: res.transactionHash };
}

/** The agent's QoreSeal recipient card, signed with the agent account's classical and ML-DSA-87 keys. */
export function signAgentCard(agentAccount: UnifiedAccount, info: AgentPublicInfo): RecipientCard {
  if (info.address !== agentAccount.cosmos) throw new Error("public.json belongs to another account");
  const k = qoreSignKeys(agentAccount);
  return signRecipientCard({
    chainId: network().chainId,
    address: agentAccount.cosmos,
    keys: { mlkemPublicKey: hexToBytes(`0x${info.mlkemPublicKey}`), x25519PublicKey: hexToBytes(`0x${info.x25519PublicKey}`) },
    classicalKey: k.classicalKey,
    pqKey: k.pqKey,
  });
}

export interface WindowOptions {
  /** Contracts the window admits; at most 16. Empty refuses: the agent's window is always scoped. */
  targets: string[];
  /** Duration in blocks (about one a second on the testnet). */
  blocks: number;
  maxTxs: number;
  /** Gas each transaction is sized for. */
  gasPerTx: bigint;
  maxFeePerGas?: bigint;
}

/** The QOR (uqor) a window must allow: value plus the maximum fee of every transaction. */
export function windowMaxValue(o: WindowOptions): bigint {
  return evmWindowCost({ gas: o.gasPerTx, maxFeePerGas: o.maxFeePerGas ?? 250_000_000_000n, value: 0n }) * BigInt(o.maxTxs);
}

export function openWindowMsgFor(sender: string, o: WindowOptions): EncodeObject {
  if (o.targets.length === 0) throw new Error("refusing to open an unscoped window");
  return openEvmWindowMsg({
    sender,
    blocks: o.blocks,
    maxTxs: o.maxTxs,
    maxValue: windowMaxValue(o),
    allowedTargets: o.targets.map((t) => t.toLowerCase()),
  });
}

/** Open a scoped EVM window for `acc` (for the agent: signed with the agent account's ML-DSA key, which the owner holds). */
export async function openWindow(acc: UnifiedAccount, o: WindowOptions): Promise<TxOutcome> {
  const res = await broadcast(acc, [openWindowMsgFor(acc.cosmos, o)]);
  return { txHash: res.transactionHash, note: `${o.blocks} blocks, ${o.maxTxs} txs, ${windowMaxValue(o)} uqor, targets ${o.targets.join(" ")}` };
}

export async function closeWindow(acc: UnifiedAccount): Promise<TxOutcome | undefined> {
  const w = await fetchEvmWindow({ rest: network().rest, address: acc.cosmos });
  if (!w.found) return undefined;
  const res = await broadcast(acc, [closeEvmWindowMsg(acc.cosmos)]);
  return { txHash: res.transactionHash };
}

/**
 * One ERC-20 call from `acc`: open a window scoped to the token for one
 * transaction, send the call, and close the window again even if it fails.
 */
async function tokenCallInWindow(acc: UnifiedAccount, token: string, data: Hex, note: string): Promise<TxOutcome[]> {
  const out: TxOutcome[] = [];
  out.push(await openWindow(acc, { targets: [token], blocks: 300, maxTxs: 1, gasPerTx: 120_000n }));
  try {
    const receipt = await sendEvm(acc, { to: token as Hex, data, gas: 100_000n });
    out.push({ txHash: receipt.transactionHash, note });
  } finally {
    const closed = await closeWindow(acc);
    if (closed) out.push(closed);
  }
  return out;
}

/** Approve `amount` of the quote token to `spender` from `acc` (the owner's account, or the agent account's on the fallback path). */
export async function approveQuote(acc: UnifiedAccount, token: string, spender: string, amount: bigint): Promise<TxOutcome[]> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, amount] });
  return tokenCallInWindow(acc, token, data, `approve ${amount} to ${spender} from ${acc.cosmos}`);
}

/** Fallback path: move `amount` of the quote token from the owner to the agent's account, which then bids with it. */
export async function transferQuote(owner: UnifiedAccount, token: string, to: string, amount: bigint): Promise<TxOutcome[]> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Hex, amount] });
  return tokenCallInWindow(owner, token, data, `transfer ${amount} to ${to}`);
}

/** Send owner-signed native messages (link, rules, revoke) in one hybrid transaction. */
export async function sendOwnerMsgs(owner: UnifiedAccount, msgs: EncodeObject[]): Promise<TxOutcome> {
  const res = await broadcast(owner, msgs);
  return { txHash: res.transactionHash };
}

export async function allowance(token: string, owner: string, spender: string): Promise<bigint> {
  return publicClient().readContract({ address: token as Hex, abi: erc20Abi, functionName: "allowance", args: [owner as Hex, spender as Hex] });
}

/** Everything the chain says about an account that matters to the Bidder. */
export async function accountStatus(address: string, evm: string) {
  const rest = network().rest;
  const [bank, pqc, kem, window, authenticators, rules] = await Promise.all([
    balances(address),
    fetchPqcStatus({ rest, address }),
    fetchKemKey({ rest, address }),
    fetchEvmWindow({ rest, address }),
    fetchAuthenticators({ rest, address }).catch((e: Error) => ({ error: e.message })),
    fetchSpendingRules({ rest, address }).catch((e: Error) => ({ error: e.message })),
  ]);
  const evmBalance = await publicClient().getBalance({ address: evm as Hex });
  return { address, evm, bank, evmBalance, pqc: { registered: pqc.registered }, kem: { registered: kem.found }, window, authenticators, rules };
}
