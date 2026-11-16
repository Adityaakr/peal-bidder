/**
 * `pnpm owner topup --qor 2`: top up the fUSD budget from QOR on the chain's
 * AMM, in one hybrid transaction.
 *
 * The agent bids in fUSD, and the faucet pays a fixed amount of it. An owner
 * who wants a larger budget (or another round once the faucet's fUSD is spent)
 * has QOR. This swaps QOR for fUSD on the fUSD/QOR constant-product pool and,
 * in the same transaction, converts the minimum it will receive into ERC-20
 * fUSD on the owner's account, which is what the auction's escrow takes. The
 * two messages are atomic: either the budget grows by at least the minimum, or
 * nothing happens.
 *
 * The price comes from the chain's own quote (`/qorechain/amm/v1/quote/exact_in`),
 * not from local arithmetic, and the swap carries a minimum out (the quote less
 * the slippage tolerance). A trade whose quoted price impact is above the
 * owner's limit is refused before anything is signed; the chain also refuses
 * any swap over its own `max_swap_impact_bps`.
 */
import { msg, type EncodeObject } from "@qorechain/sdk";
import { convertCoinMsg } from "qore-pq-kit";

export const UQOR = "uqor";

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface Pool {
  id: string;
  tokenA: string;
  tokenB: string;
  reserveA: bigint;
  reserveB: bigint;
}

/** The active constant-product pool between `denomA` and `denomB` with the deepest reserve of `denomA`. */
export async function findPool(rest: string, denomA: string, denomB: string, f: FetchLike = fetch): Promise<Pool> {
  const res = await f(`${rest}/qorechain/amm/v1/pools`);
  if (!res.ok) throw new Error(`could not read the AMM pools (HTTP ${res.status})`);
  const body = (await res.json()) as { pools?: Record<string, string>[] };
  const pools = (body.pools ?? [])
    .filter((p) => p.status === "active" && p.pool_type === "constant_product")
    .filter((p) => (p.token_a === denomA && p.token_b === denomB) || (p.token_a === denomB && p.token_b === denomA))
    .map((p) => {
      const aFirst = p.token_a === denomA;
      return {
        id: String(p.id),
        tokenA: denomA,
        tokenB: denomB,
        reserveA: BigInt(aFirst ? (p.reserve_a ?? "0") : (p.reserve_b ?? "0")),
        reserveB: BigInt(aFirst ? (p.reserve_b ?? "0") : (p.reserve_a ?? "0")),
      };
    })
    .sort((x, y) => (y.reserveA > x.reserveA ? 1 : y.reserveA < x.reserveA ? -1 : 0));
  const best = pools[0];
  if (!best) throw new Error(`no active pool between ${denomA} and ${denomB}`);
  return best;
}

export interface Quote {
  poolId: string;
  denomIn: string;
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  impactBps: number;
}

/** The chain's quote for an exact-in swap. */
export async function quoteExactIn(rest: string, poolId: string, denomIn: string, amountIn: bigint, f: FetchLike = fetch): Promise<Quote> {
  const q = new URLSearchParams({ pool_id: poolId, denom_in: denomIn, amount_in: amountIn.toString() });
  const res = await f(`${rest}/qorechain/amm/v1/quote/exact_in?${q.toString()}`);
  const body = (await res.json()) as { amount_out?: string; fee?: string; impact_bps?: number; message?: string };
  if (!res.ok || body.amount_out === undefined) throw new Error(`the chain did not quote the swap: ${body.message ?? `HTTP ${res.status}`}`);
  return { poolId, denomIn, amountIn, amountOut: BigInt(body.amount_out), fee: BigInt(body.fee ?? "0"), impactBps: Number(body.impact_bps ?? 0) };
}

export interface TopupPlan {
  quote: Quote;
  /** The least the swap may pay out; also the amount converted to ERC-20 in the same transaction. */
  minOut: bigint;
}

/** Apply the owner's slippage tolerance and impact limit to a quote. */
export function planTopup(quote: Quote, opts: { slippageBps: number; maxImpactBps: number }): TopupPlan {
  if (!Number.isInteger(opts.slippageBps) || opts.slippageBps < 0 || opts.slippageBps >= 10_000) throw new Error("slippage must be 0 to 9,999 basis points");
  if (quote.amountOut <= 0n) throw new Error("the pool quotes nothing for this amount");
  if (quote.impactBps > opts.maxImpactBps) {
    throw new Error(`the quoted price impact is ${quote.impactBps} bps, over your limit of ${opts.maxImpactBps}: swap less, or raise --max-impact-bps`);
  }
  const minOut = (quote.amountOut * BigInt(10_000 - opts.slippageBps)) / 10_000n;
  if (minOut <= 0n) throw new Error("the minimum out rounds to zero; swap more");
  return { quote, minOut };
}

/** The transaction: swap QOR for fUSD bank coins, then convert the guaranteed minimum into ERC-20 fUSD on `receiver0x`. */
export function topupMsgs(sender: string, receiver0x: string, denomOut: string, plan: TopupPlan, convert: boolean): EncodeObject[] {
  const swap = msg.amm.swapExactIn({
    sender,
    poolId: plan.quote.poolId,
    tokenIn: { denom: plan.quote.denomIn, amount: plan.quote.amountIn.toString() },
    denomOut,
    minOut: plan.minOut.toString(),
  });
  return convert ? [swap, convertCoinMsg(sender, denomOut, plan.minOut, receiver0x)] : [swap];
}
