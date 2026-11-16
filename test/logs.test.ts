import { describe, expect, it } from "vitest";
import { LOG_WINDOW, scanBackwards } from "../agent/logs.ts";

describe("scanBackwards (the public RPC refuses log ranges over 10,000 blocks)", () => {
  it("reads windows of at most 10,000 blocks, newest first, and stops when done", async () => {
    const calls: [bigint, bigint][] = [];
    const found = await scanBackwards(
      { getBlockNumber: async () => 50_000n },
      async (from, to) => {
        calls.push([from, to]);
        expect(to - from).toBeLessThanOrEqual(LOG_WINDOW);
        return from <= 25_000n && 25_000n <= to ? ["hit"] : [];
      },
      { done: (f) => f.length > 0 },
    );
    expect(found).toEqual(["hit"]);
    expect(calls[0]).toEqual([40_001n, 50_000n]);
    expect(calls.at(-1)![0]).toBeLessThanOrEqual(25_000n);
  });

  it("covers every block down to the floor, without gaps or overlaps, oldest results first", async () => {
    const seen: bigint[] = [];
    const found = await scanBackwards(
      { getBlockNumber: async () => 25_000n },
      async (from, to) => {
        for (let b = from; b <= to; b++) seen.push(b);
        return [Number(from)];
      },
      { fromBlock: 1_000n },
    );
    expect(seen.length).toBe(24_001);
    expect(new Set(seen).size).toBe(24_001);
    expect(found).toEqual([...found].sort((a, b) => a - b));
  });

  it("stops at the block budget", async () => {
    let calls = 0;
    await scanBackwards({ getBlockNumber: async () => 10_000_000n }, async () => (calls++, []), { maxBlocks: 30_000n });
    expect(calls).toBe(4);
  });
});
