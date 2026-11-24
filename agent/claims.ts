/**
 * After the auction: find the agent's bids and claim them.
 *
 * The chain is the record: the agent's bids are the auction's stored bids for
 * its bidder address (the vault when bids go through one, else the owner's
 * account on the smart-account path, the agent's own on the fallback path). `claim(bidId)` is
 * permissionless and always pays the bidder, so claiming moves nothing out of
 * the owner's account; it is sent through the same executor as the bids.
 */
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import type { SubmitResult } from "./agent.ts";
import { AUCTION_STATE, BID_STATUS, EXCLUSION, sealedAuctionAbi } from "./auction-abi.ts";
import type { ReceiptLog } from "./receipts.ts";
import type { CallSender } from "./smart-account-executor.ts";

export type ClaimsClient = Pick<PublicClient, "readContract">;

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

/**
 * The bidder's bids, read from storage: `bidCount`, then `getBid(i)` for each
 * (at most `MAX_BIDS` = 256). Not from `BidCommitted` logs: on qorechain-diana
 * the events of a call made through `MsgExecuteEVM` do not reach `eth_getLogs`
 * (found in the live demo, docs/spikes.md), so a smart-account bidder's
 * commits would be invisible there.
 */
export async function auctionOutcome(client: ClaimsClient, auction: string, bidder: Address): Promise<AuctionOutcome> {
  const address = auction as Address;
  const [stateIndex, clearingPrice, count, mine] = await Promise.all([
    client.readContract({ address, abi: sealedAuctionAbi, functionName: "state" }),
    client.readContract({ address, abi: sealedAuctionAbi, functionName: "clearingPrice" }),
    client.readContract({ address, abi: sealedAuctionAbi, functionName: "bidCount" }),
    client.readContract({ address, abi: sealedAuctionAbi, functionName: "bidCountOf", args: [bidder] }),
  ]);
  const state = AUCTION_STATE[stateIndex] ?? "Created";
  const bids: OwnBid[] = [];
  for (let i = 0n; i < BigInt(count) && bids.length < Number(mine); i++) {
    const b = await client.readContract({ address, abi: sealedAuctionAbi, functionName: "getBid", args: [i] });
    if (b.bidder.toLowerCase() !== bidder.toLowerCase()) continue;
    const allocation = await client.readContract({ address, abi: sealedAuctionAbi, functionName: "allocationOf", args: [i] });
    bids.push({
      auction: auction.toLowerCase(),
      bidId: i,
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
  /** The vault that is the bidder, recorded in the receipt. */
  vault?: string;
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
      ...(args.vault ? { vault: args.vault.toLowerCase() } : {}),
    });
    out.push({ bidId: b.bidId, result });
  }
  return out;
}
