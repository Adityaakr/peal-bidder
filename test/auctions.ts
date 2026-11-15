import type { AuctionView } from "../agent/auction.ts";
import { FUSD } from "../common/network.ts";
import { AUCTION_A, AUCTION_B, NOW } from "./helpers.ts";

const E18 = 10n ** 18n;

/** A PEAL-T sale priced in fUSD: 0.10 fUSD reserve, 0.01 fUSD ticks, 64 ticks, 1 fUSD bond. */
export function auction(over: Partial<AuctionView> = {}): AuctionView {
  return {
    address: AUCTION_A,
    quoteToken: FUSD.toLowerCase(),
    saleDecimals: 18,
    reservePrice: 100_000n,
    tickSize: 10_000n,
    numTicks: 64,
    minQuantity: E18,
    maxPerAddress: 0n,
    supply: 1_000_000n * E18,
    bidBond: 1_000_000n,
    commitOpen: true,
    commitEnd: NOW + 3600,
    name: "Peal Tender buyback #1",
    details: "The treasury sells fUSD for PEAL-T at one uniform price.",
    ...over,
  };
}

export const auctionB = (over: Partial<AuctionView> = {}) => auction({ address: AUCTION_B, ...over });
