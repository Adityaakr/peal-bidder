import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { sealedAuctionAbi } from "../agent/auction-abi.ts";
import { auctionOutcome, claimAll, claimCall } from "../agent/claims.ts";
import { MemorySink, ReceiptLog, verifyReceipts } from "../agent/receipts.ts";
import type { CallSender } from "../agent/smart-account-executor.ts";
import { AUCTION_A, newAgent } from "./helpers.ts";

const BIDDER = "0x9999999999999999999999999999999999999999" as Address;
const OTHER = "0x8888888888888888888888888888888888888888" as Address;

function client(state: number, bids: { bidder: Address; claimed: boolean; status: number; allocation: bigint }[]) {
  return {
    async readContract(a: { functionName: string; args?: readonly unknown[] }) {
      if (a.functionName === "state") return state;
      if (a.functionName === "clearingPrice") return 150_000n;
      if (a.functionName === "bidCountOf") return bids.length;
      const id = Number(a.args?.[0]);
      const b = bids[id]!;
      if (a.functionName === "getBid") {
        return { bidder: b.bidder, seq: id, status: b.status, exclusion: 0, shareMask: 3, bondBurned: false, claimed: b.claimed, quantity: 5n, tick: 7, escrow: 100n, ct: "0x", keyHash: "0x" };
      }
      if (a.functionName === "allocationOf") return b.allocation;
      throw new Error(a.functionName);
    },
    // The node filters by the indexed bidder; a lying node is caught by getBid's bidder check.
    async getContractEvents() {
      return bids.map((b, i) => ({ args: { bidId: BigInt(i), bidder: b.bidder } }));
    },
    async getBlockNumber() {
      return 5_000n;
    },
  };
}

describe("claims", () => {
  it("lists the bidder's own bids with their outcome", async () => {
    const c = client(4, [
      { bidder: BIDDER, claimed: false, status: 1, allocation: 3n },
      { bidder: OTHER, claimed: false, status: 1, allocation: 9n },
      { bidder: BIDDER, claimed: true, status: 3, allocation: 0n },
    ]);
    const o = await auctionOutcome(c as never, AUCTION_A, BIDDER);
    expect(o).toMatchObject({ state: "Settled", claimable: true, clearingPrice: 150_000n });
    expect(o.bids.map((b) => [b.bidId, b.status, b.claimed, b.allocation])).toEqual([
      [0n, "Opened", false, 3n],
      [2n, "Unopenable", true, 0n],
    ]);
  });

  it("claims each unclaimed bid once, with a receipt per claim", async () => {
    const c = client(4, [
      { bidder: BIDDER, claimed: false, status: 1, allocation: 3n },
      { bidder: BIDDER, claimed: true, status: 1, allocation: 1n },
      { bidder: BIDDER, claimed: false, status: 2, allocation: 0n },
    ]);
    const sent: Hex[] = [];
    const sender: CallSender = {
      sendCall: async (call) => {
        sent.push(call.data);
        return { status: "landed", txHash: `0x${sent.length}` };
      },
    };
    const agent = newAgent();
    const sink = new MemorySink();
    const receipts = new ReceiptLog(sink, agent.receiptKey, agent.address);
    const res = await claimAll({ outcome: await auctionOutcome(c as never, AUCTION_A, BIDDER), sender, receipts, mandateHash: null });
    expect(res.map((r) => r.bidId)).toEqual([0n, 2n]);
    expect(sent.map((d) => decodeFunctionData({ abi: sealedAuctionAbi, data: d }).args)).toEqual([[0n], [2n]]);
    const check = verifyReceipts(sink.read(), agent.receiptKey.publicKey);
    expect(check.ok && check.receipts.map((r) => r.body.kind)).toEqual(["claim", "claim"]);
  });

  it("does not claim before the auction is settled, failed or cancelled", async () => {
    const c = client(3, [{ bidder: BIDDER, claimed: false, status: 0, allocation: 0n }]);
    const sender: CallSender = { sendCall: async () => Promise.reject(new Error("must not be called")) };
    const agent = newAgent();
    const outcome = await auctionOutcome(c as never, AUCTION_A, BIDDER);
    expect(outcome.claimable).toBe(false);
    expect(await claimAll({ outcome, sender, receipts: new ReceiptLog(new MemorySink(), agent.receiptKey, agent.address), mandateHash: null })).toEqual([]);
  });

  it("encodes claim(bidId) to the auction", () => {
    const call = claimCall(AUCTION_A, 5n);
    expect(call.to).toBe(AUCTION_A);
    expect(decodeFunctionData({ abi: sealedAuctionAbi, data: call.data })).toMatchObject({ functionName: "claim", args: [5n] });
  });
});
