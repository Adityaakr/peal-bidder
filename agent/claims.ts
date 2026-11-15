/**
 * After the auction: find the agent's bids and claim them.
 *
 * The chain is the record: the agent's bids are the auction's `BidCommitted`
 * events for its bidder address (the owner's account on the smart-account
 * path, the agent's own on the fallback path). `claim(bidId)` is
 * permissionless and always pays the bidder, so claiming moves nothing out of
 * the owner's account; it is sent through the same executor as the bids.
 */
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import type { SubmitResult } from "./agent.ts";
import { AUCTION_STATE, BID_STATUS, EXCLUSION, sealedAuctionAbi } from "./auction-abi.ts";
import type { ReceiptLog } from "./receipts.ts";
import type { CallSender } from "./smart-account-executor.ts";

export type ClaimsClient = Pick<PublicClient, "readContract" | "getContractEvents">;

export interface OwnBid {
  auction: string;
  bidId: bigint;
  seq: number;
  escrow: bigint;
  status: (typeof BID_STATUS)[number];
  exclusion: (typeof EXCLUSION)[number];
  claimed: boolean;
  /** Sale tokens won (0 until settled, or when not opened). */
  allocation: bigint;
  /** Opened bids only: what the committee revealed. */
  quantity: bigint;
  tick: number;
}

export interface AuctionOutcome {
  auction: string;
  state: (typeof AUCTION_STATE)[number];
  clearingPrice: bigint;
  bids: OwnBid[];
  /** Claims are possible in Settled, Failed and Cancelled. */
  claimable: boolean;
}

export const CLAIM_GAS = 300_000n;

export async function auctionOutcome(client: ClaimsClient, auction: string, bidder: Address, fromBlock = 0n): Promise<AuctionOutcome> {
  const address = auction as Address;
  const [stateIndex, clearingPrice] = await Promise.all([
    client.readContract({ address, abi: sealedAuctionAbi, functionName: "state" }),
    client.readContract({ address, abi: sealedAuctionAbi, functionName: "clearingPrice" }),
  ]);
  const state = AUCTION_STATE[stateIndex] ?? "Created";
  const logs = await client.getContractEvents({ address, abi: sealedAuctionAbi, eventName: "BidCommitted", args: { bidder }, fromBlock, strict: true });
  const bids: OwnBid[] = [];
  for (const l of logs) {
    const bidId = l.args.bidId as bigint;
    const [b, allocation] = await Promise.all([
      client.readContract({ address, abi: sealedAuctionAbi, functionName: "getBid", args: [bidId] }),
      client.readContract({ address, abi: sealedAuctionAbi, functionName: "allocationOf", args: [bidId] }),
    ]);
    if (b.bidder.toLowerCase() !== bidder.toLowerCase()) continue;
    bids.push({
      auction: auction.toLowerCase(),
      bidId,
      seq: b.seq,
      escrow: b.escrow,
      status: BID_STATUS[b.status] ?? "Pending",
      exclusion: EXCLUSION[b.exclusion] ?? "None",
      claimed: b.claimed,
      allocation,
      quantity: b.quantity,
      tick: b.tick,
    });
  }
  return { auction: auction.toLowerCase(), state, clearingPrice, bids, claimable: state === "Settled" || state === "Failed" || state === "Cancelled" };
}

export function claimCall(auction: string, bidId: bigint): { to: Hex; data: Hex; gasLimit: bigint } {
  return { to: auction as Hex, data: encodeFunctionData({ abi: sealedAuctionAbi, functionName: "claim", args: [bidId] }), gasLimit: CLAIM_GAS };
}

/** Claim every unclaimed bid of a claimable auction; one receipt per claim. */
export async function claimAll(args: {
  outcome: AuctionOutcome;
  sender: CallSender;
  receipts: ReceiptLog;
  mandateHash: string | null;
}): Promise<{ bidId: bigint; result: SubmitResult }[]> {
  const { outcome } = args;
  if (!outcome.claimable) return [];
  const out = [];
  for (const b of outcome.bids) {
    if (b.claimed) continue;
    const result = await args.sender.sendCall(claimCall(outcome.auction, b.bidId));
    args.receipts.append("claim", args.mandateHash, {
      auction: outcome.auction,
      bidId: b.bidId.toString(),
      auctionState: outcome.state,
      bidStatus: b.status,
      allocation: b.allocation.toString(),
      status: result.status,
      txHash: result.txHash ?? null,
      reason: result.reason ?? null,
    });
    out.push({ bidId: b.bidId, result });
  }
  return out;
}
