import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { BidDecision } from "../agent/agent.ts";
import type { BidEncoder } from "../agent/smart-account-executor.ts";
import { WindowExecutor, type WindowExecutorDeps, type WindowView } from "../agent/window-executor.ts";
import { AUCTION_A, newAccount, newAgent, sampleMandate } from "./helpers.ts";

const mandate = sampleMandate(newAccount(), newAgent());
const D: BidDecision = { kind: "bid", auction: AUCTION_A, qty: 1n, tick: 1, escrow: 1n, bond: 0n, outflow: 1n, adjustments: [] };
const encoder: BidEncoder = { encode: async () => ({ to: AUCTION_A as Hex, data: "0x01", gasLimit: 1_000_000n }) };
const LIVE: WindowView = { live: true, remainingTxs: 3n, allowedTargets: [AUCTION_A.toUpperCase().replace("0X", "0x")] };

function ex(over: Partial<WindowExecutorDeps> = {}) {
  const sent: unknown[] = [];
  const e = new WindowExecutor({
    encoder,
    window: async () => LIVE,
    send: async (tx) => {
      sent.push(tx);
      return "0xhash";
    },
    wait: async () => "success",
    ...over,
  });
  return { e, sent };
}

describe("window executor (fallback path)", () => {
  it("sends the commit inside a live window that admits the auction", async () => {
    const { e, sent } = ex();
    expect(await e.submit(D, mandate)).toEqual({ status: "landed", txHash: "0xhash" });
    expect(sent).toEqual([{ to: AUCTION_A, data: "0x01", gas: 1_000_000n }]);
  });

  it("sends nothing without a live window, with no transactions left, or when the window does not admit the auction", async () => {
    for (const w of [
      { ...LIVE, live: false },
      { ...LIVE, remainingTxs: 0n },
      { ...LIVE, allowedTargets: ["0x3333333333333333333333333333333333333333"] },
    ]) {
      const { e, sent } = ex({ window: async () => w });
      expect(await e.submit(D, mandate)).toMatchObject({ status: "refused" });
      expect(sent).toHaveLength(0);
    }
  });

  it("reports a reverted commit as refused, a lost receipt as unknown", async () => {
    expect(await ex({ wait: async () => "reverted" }).e.submit(D, mandate)).toMatchObject({ status: "refused", txHash: "0xhash" });
    expect(await ex({ wait: async () => Promise.reject(new Error("timed out")) }).e.submit(D, mandate)).toMatchObject({ status: "unknown", txHash: "0xhash" });
  });

  it("tells a refusal before broadcast from a network failure during it", async () => {
    expect(await ex({ send: async () => Promise.reject(new Error("EVM window does not admit this transaction")) }).e.submit(D, mandate)).toMatchObject({
      status: "refused",
    });
    expect(await ex({ send: async () => Promise.reject(new Error("fetch failed")) }).e.submit(D, mandate)).toMatchObject({ status: "unknown" });
  });

  it("sends nothing when encoding fails", async () => {
    const { e, sent } = ex({ encoder: { encode: async () => Promise.reject(new Error("escrow mismatch")) } });
    expect(await e.submit(D, mandate)).toMatchObject({ status: "refused", reason: "not sent: escrow mismatch" });
    expect(sent).toHaveLength(0);
  });
});
