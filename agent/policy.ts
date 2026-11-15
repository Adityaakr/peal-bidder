/**
 * The deterministic policy: whatever the planner proposes, the bid that leaves
 * the agent fits the mandate.
 *
 * The policy never widens anything and never substitutes a target: an auction
 * outside the mandate, a closed auction or an unreadable proposal is skipped,
 * not redirected. A tick above the mandate's maximum is lowered to it, and a
 * quantity whose escrow does not fit the per-bid and remaining budget is
 * lowered until it does. The chain enforces the same limits again (spending
 * rule, scoped window, allowance), so this is the first of several layers.
 */
import type { PealMandateV1 } from "../common/mandate.ts";
import { UINT128_MAX, costCeil, maxQtyForEscrow, priceAt, type AuctionView } from "./auction.ts";

export interface Proposal {
  action: "bid" | "skip";
  auction: string;
  /** Sale base units, as a decimal string. */
  qty: string;
  tick: number;
  rationale: string;
}

/** What the agent has already done under the current mandate. */
export interface Ledger {
  bids: number;
  /** Quote base units committed so far (escrow plus bond of every bid placed). */
  committed: bigint;
  /** Sale base units bid so far, per lower-case auction address. */
  qtyByAuction: Record<string, bigint>;
}

export const EMPTY_LEDGER: Ledger = { bids: 0, committed: 0n, qtyByAuction: {} };

export interface PolicyContext {
  mandate: PealMandateV1;
  auctions: AuctionView[];
  ledger: Ledger;
  /** Unix seconds. */
  now: number;
}

export type SkipReason =
  | "PROPOSAL_MALFORMED"
  | "PLANNER_SKIPPED"
  | "MANDATE_NOT_ACTIVE"
  | "BID_COUNT_EXHAUSTED"
  | "AUCTION_NOT_IN_MANDATE"
  | "AUCTION_UNKNOWN"
  | "AUCTION_NOT_OPEN"
  | "WRONG_QUOTE_TOKEN"
  | "BUDGET_EXHAUSTED"
  | "ADDRESS_CAP_REACHED"
  | "BELOW_MIN_QUANTITY";

export type Adjustment = "TICK_LOWERED" | "QTY_LOWERED";

export type Decision =
  | {
      kind: "bid";
      auction: string;
      qty: bigint;
      tick: number;
      escrow: bigint;
      bond: bigint;
      /** escrow + bond: what leaves the owner's account. */
      outflow: bigint;
      adjustments: Adjustment[];
    }
  | { kind: "skip"; reason: SkipReason; detail: string };

const DECIMAL = /^(0|[1-9][0-9]{0,38})$/;
const MAX_RATIONALE = 2000;

/** Read a planner's output. Returns undefined for anything that is not a well-formed proposal. */
export function parseProposal(x: unknown): Proposal | undefined {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  if (o.action !== "bid" && o.action !== "skip") return undefined;
  if (typeof o.auction !== "string") return undefined;
  if (typeof o.qty !== "string" || !DECIMAL.test(o.qty)) return undefined;
  if (typeof o.tick !== "number" || !Number.isSafeInteger(o.tick) || o.tick < 0) return undefined;
  if (typeof o.rationale !== "string") return undefined;
  return {
    action: o.action,
    auction: o.auction.toLowerCase(),
    qty: o.qty,
    tick: o.tick,
    rationale: o.rationale.slice(0, MAX_RATIONALE),
  };
}

function skip(reason: SkipReason, detail: string): Decision {
  return { kind: "skip", reason, detail };
}

/** What one more bid may still take from the owner: the per-bid limit or what is left of the budget. */
export function remainingCap(mandate: PealMandateV1, ledger: Ledger): bigint {
  const left = BigInt(mandate.budget) - ledger.committed;
  const perBid = BigInt(mandate.maxPerBid);
  const cap = left < perBid ? left : perBid;
  return cap > 0n ? cap : 0n;
}

/** Highest tick the mandate and the auction both allow. */
export function tickCeiling(mandate: PealMandateV1, a: AuctionView): number {
  return Math.min(mandate.maxTick, a.numTicks - 1);
}

/** Largest quantity at `tick` that fits every limit, or 0n. */
export function maxQty(ctx: PolicyContext, a: AuctionView, tick: number): bigint {
  const cap = remainingCap(ctx.mandate, ctx.ledger);
  if (cap <= a.bidBond) return 0n;
  let q = maxQtyForEscrow(a, tick, cap - a.bidBond);
  if (q > a.supply) q = a.supply;
  if (a.maxPerAddress > 0n) {
    const left = a.maxPerAddress - (ctx.ledger.qtyByAuction[a.address] ?? 0n);
    if (left < q) q = left > 0n ? left : 0n;
  }
  return q > UINT128_MAX ? UINT128_MAX : q;
}

/** Turn a planner's output into a bid that fits the mandate, or a skip with its reason. */
export function clamp(raw: unknown, ctx: PolicyContext): Decision {
  const { mandate, ledger, now } = ctx;
  const p = parseProposal(raw);
  if (!p) return skip("PROPOSAL_MALFORMED", "the planner's output is not a well-formed proposal");
  if (p.action === "skip") return skip("PLANNER_SKIPPED", p.rationale);

  if (now < mandate.notBefore || now >= mandate.expiresAt) return skip("MANDATE_NOT_ACTIVE", "outside the mandate's validity");
  if (ledger.bids >= mandate.maxBids) return skip("BID_COUNT_EXHAUSTED", `${ledger.bids} of ${mandate.maxBids} bids placed`);
  if (!mandate.auctions.includes(p.auction)) return skip("AUCTION_NOT_IN_MANDATE", `${p.auction} is not in the mandate`);
  const a = ctx.auctions.find((x) => x.address === p.auction);
  if (!a) return skip("AUCTION_UNKNOWN", `${p.auction} could not be read`);
  if (!a.commitOpen || now >= a.commitEnd) return skip("AUCTION_NOT_OPEN", `${p.auction} is not taking bids`);
  if (a.quoteToken !== mandate.quoteToken) return skip("WRONG_QUOTE_TOKEN", "the auction is paid in another token");
  if (a.numTicks < 1) return skip("AUCTION_NOT_OPEN", "the auction has no ticks");

  const adjustments: Adjustment[] = [];
  let tick = p.tick;
  const ceiling = tickCeiling(mandate, a);
  if (tick > ceiling) {
    tick = ceiling;
    adjustments.push("TICK_LOWERED");
  }

  if (remainingCap(mandate, ledger) <= a.bidBond) return skip("BUDGET_EXHAUSTED", "no budget left for another bid");
  if (a.maxPerAddress > 0n && (ledger.qtyByAuction[a.address] ?? 0n) >= a.maxPerAddress) {
    return skip("ADDRESS_CAP_REACHED", "the auction's per-address cap is reached");
  }
  let qty = BigInt(p.qty);
  const most = maxQty(ctx, a, tick);
  if (qty > most) {
    qty = most;
    adjustments.push("QTY_LOWERED");
  }
  if (qty === 0n || qty < a.minQuantity) {
    return skip("BELOW_MIN_QUANTITY", `quantity ${qty} is below the auction's minimum ${a.minQuantity}`);
  }

  const escrow = costCeil(qty, priceAt(a, tick), a.saleDecimals);
  return { kind: "bid", auction: a.address, qty, tick, escrow, bond: a.bidBond, outflow: escrow + a.bidBond, adjustments };
}

/** The ledger after a bid lands. */
export function recordBid(ledger: Ledger, d: Extract<Decision, { kind: "bid" }>): Ledger {
  return {
    bids: ledger.bids + 1,
    committed: ledger.committed + d.outflow,
    qtyByAuction: { ...ledger.qtyByAuction, [d.auction]: (ledger.qtyByAuction[d.auction] ?? 0n) + d.qty },
  };
}
