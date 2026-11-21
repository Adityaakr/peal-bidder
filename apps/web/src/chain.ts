/**
 * chain.ts - reading QoreChain from the browser: the EVM RPC directly, the REST
 * API through the same-origin proxy. Read-only; nothing here signs.
 */
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { ChainAuctionReader } from "../../../agent/chain-auction.ts";
import { auctionFactoryAbi, AUCTION_STATE, sealedAuctionAbi } from "../../../agent/auction-abi.ts";
import { ChainPqKeySource, PqKeyError } from "../../../agent/keysource.ts";
import type { AuctionView } from "../../../agent/auction.ts";
import { EVM_CHAIN_ID, EVM_RPC, FACTORY, FUSD, REST } from "./config.ts";

export const chain = {
  id: EVM_CHAIN_ID,
  name: "QoreChain testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
};

export const evm = createPublicClient({ chain, transport: http(EVM_RPC, { retryCount: 1, timeout: 20_000 }) }) as PublicClient;

export async function rest<T>(path: string): Promise<T | undefined> {
  const r = await fetch(`${REST}${path}`);
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`QoreChain REST ${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** A Cosmos transaction by hash: its result code, height and raw log (undefined when the node does not have it). */
export async function cosmosTx(hash: string): Promise<{ code: number; height: number; rawLog: string } | undefined> {
  const r = await rest<{ tx_response?: { code: number; height: string; raw_log?: string } }>(`/cosmos/tx/v1beta1/txs/${hash}`);
  const t = r?.tx_response;
  return t ? { code: t.code, height: Number(t.height), rawLog: t.raw_log ?? "" } : undefined;
}

/** Whether an account has an ML-DSA-87 key on chain, read the way the agent reads it (`pqcKeyStatus`). */
export async function pqKeyState(address: string): Promise<{ ok: true; key: Uint8Array } | { ok: false; code: string }> {
  try {
    return { ok: true, key: await new ChainPqKeySource(evm).pqPublicKey(address) };
  } catch (e) {
    return { ok: false, code: e instanceof PqKeyError ? e.code : "KEY_UNAVAILABLE" };
  }
}

export interface SpendingRuleView {
  id: string;
  enabled: boolean;
  perTxLimit: string;
  dailyLimit: string;
  allowedDenoms: string[];
  allowedEvmCalls: string[];
  denomLimits: { denom: string; per_tx_limit?: string; perTxLimit?: string; daily_limit?: string; dailyLimit?: string }[];
}

/** The owner's spending rules, from the abstract-account module (snake or camel case, as the node answers). */
export async function spendingRules(owner: string): Promise<SpendingRuleView[] | undefined> {
  const r = await rest<Record<string, unknown>>(`/qorechain/abstractaccount/v1/accounts/${owner}/spending_rules`);
  if (!r) return undefined;
  const list = (r.spending_rules ?? r.spendingRules ?? r.rules ?? []) as Record<string, unknown>[];
  return list.map((x) => ({
    id: String(x.id ?? ""),
    enabled: Boolean(x.enabled),
    perTxLimit: String(x.per_tx_limit ?? x.perTxLimit ?? ""),
    dailyLimit: String(x.daily_limit ?? x.dailyLimit ?? ""),
    allowedDenoms: (x.allowed_denoms ?? x.allowedDenoms ?? []) as string[],
    allowedEvmCalls: (x.allowed_evm_calls ?? x.allowedEvmCalls ?? []) as string[],
    denomLimits: (x.denom_limits ?? x.denomLimits ?? []) as SpendingRuleView["denomLimits"],
  }));
}

export interface AuctionSummary extends AuctionView {
  state: (typeof AUCTION_STATE)[number];
  startTime: number;
  bidCount: number;
}

const reader = new ChainAuctionReader(evm, { factory: FACTORY });

/** One auction, with its lifecycle state and bid count. */
export async function auctionSummary(address: Address, now?: number): Promise<AuctionSummary> {
  const t = now ?? Number((await evm.getBlock()).timestamp);
  const [view, state, cfg, bidCount] = await Promise.all([
    reader.readOne(address, t),
    evm.readContract({ address, abi: sealedAuctionAbi, functionName: "state" }),
    evm.readContract({ address, abi: sealedAuctionAbi, functionName: "config" }),
    evm.readContract({ address, abi: sealedAuctionAbi, functionName: "bidCount" }),
  ]);
  return { ...view, state: AUCTION_STATE[state] ?? "Created", startTime: Number(cfg.startTime), bidCount: Number(bidCount) };
}

/** The factory's auctions, newest first, at most `limit`. */
export async function factoryAuctions(limit = 12): Promise<{ now: number; auctions: AuctionSummary[] }> {
  const [count, block] = await Promise.all([evm.readContract({ address: FACTORY, abi: auctionFactoryAbi, functionName: "auctionCount" }), evm.getBlock()]);
  const now = Number(block.timestamp);
  const n = Number(count);
  const offset = Math.max(0, n - limit);
  const page = await evm.readContract({ address: FACTORY, abi: auctionFactoryAbi, functionName: "auctionsPaged", args: [BigInt(offset), BigInt(limit)] });
  // Read side by side; an unreadable auction is left out.
  const read = await Promise.allSettled([...page].reverse().map((a) => auctionSummary(a, now)));
  const out = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  return { now, auctions: out };
}

/** Auctions taking bids now, paid in fUSD: the ones a guest agent may bid in. */
export function openForGuests(list: AuctionSummary[], now: number): AuctionSummary[] {
  return list.filter((a) => a.commitOpen && now < a.commitEnd && a.quoteToken === FUSD);
}

export async function chainNow(): Promise<number> {
  return Number((await evm.getBlock()).timestamp);
}
