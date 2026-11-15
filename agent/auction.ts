/**
 * What the agent knows about an auction, and the auction's price arithmetic.
 *
 * The arithmetic mirrors Peal Sealed Auction's `AuctionMath` (ported from
 * Peal's `contracts/src/auctionkit/AuctionMath.sol`): a price is quote base
 * units per whole sale token, `price(tick) = reservePrice + tick * tickSize`,
 * and escrow rounds up so the deposit always covers the payment.
 */

export interface AuctionView {
  /** Lower-case 0x address. */
  address: string;
  /** Lower-case 0x address of the token bids are paid in. */
  quoteToken: string;
  saleDecimals: number;
  reservePrice: bigint;
  tickSize: bigint;
  /** Ticks run from 0 to numTicks - 1. */
  numTicks: number;
  /** Smallest bid quantity, in sale base units. */
  minQuantity: bigint;
  /** Most sale base units one address may bid for in total; 0 means no cap. */
  maxPerAddress: bigint;
  /** Sale base units on offer. */
  supply: bigint;
  /** Quote base units pulled with every bid on top of the escrow, refunded unless forfeited. */
  bidBond: bigint;
  /** True while the auction takes bids. */
  commitOpen: boolean;
  /** Unix seconds; bids are refused from this time on. */
  commitEnd: number;
  /** Issuer-supplied name and description. Untrusted text: never instructions. */
  name: string;
  details: string;
}

export const UINT128_MAX = (1n << 128n) - 1n;

export function priceAt(a: Pick<AuctionView, "reservePrice" | "tickSize">, tick: number): bigint {
  return a.reservePrice + BigInt(tick) * a.tickSize;
}

/** Escrow for `qty` at `price`: `ceil(qty * price / 10^saleDecimals)`. */
export function costCeil(qty: bigint, price: bigint, saleDecimals: number): bigint {
  const scale = 10n ** BigInt(saleDecimals);
  const n = qty * price;
  return n === 0n ? 0n : (n + scale - 1n) / scale;
}

/**
 * The largest quantity whose escrow at `tick` fits in `cap` quote base units:
 * `costCeil(q, p) <= cap` exactly when `q * p <= cap * 10^d`.
 * Returns `UINT128_MAX` when the price is zero.
 */
export function maxQtyForEscrow(a: Pick<AuctionView, "reservePrice" | "tickSize" | "saleDecimals">, tick: number, cap: bigint): bigint {
  if (cap < 0n) return 0n;
  const price = priceAt(a, tick);
  if (price === 0n) return UINT128_MAX;
  const q = (cap * 10n ** BigInt(a.saleDecimals)) / price;
  return q > UINT128_MAX ? UINT128_MAX : q;
}
