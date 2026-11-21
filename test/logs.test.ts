import { describe, expect, it } from "vitest";
import { LOG_WINDOW, blockNear, scanBackwards, scanForwards } from "../agent/logs.ts";

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

describe("scanBackwards from a block below the head", () => {
  it("starts at toBlock and counts the budget from there", async () => {
    const calls: [bigint, bigint][] = [];
    await scanBackwards({ getBlockNumber: async () => 1_000_000n }, async (from, to) => (calls.push([from, to]), []), { toBlock: 500_000n, maxBlocks: 20_000n });
    expect(calls[0]).toEqual([490_001n, 500_000n]);
    expect(calls.at(-1)![0]).toBe(480_000n);
  });

  it("never starts above the head", async () => {
    const calls: [bigint, bigint][] = [];
    await scanBackwards({ getBlockNumber: async () => 30_000n }, async (from, to) => (calls.push([from, to]), []), { toBlock: 90_000n, maxBlocks: 5_000n });
    expect(calls).toEqual([[25_000n, 30_000n]]);
  });
});

describe("scanForwards (events that sit near a known start)", () => {
  it("reads up from fromBlock in windows, oldest first, and stops when done", async () => {
    const calls: [bigint, bigint][] = [];
    const found = await scanForwards(
      { getBlockNumber: async () => 10_480_000n },
      async (from, to) => {
        calls.push([from, to]);
        expect(to - from).toBeLessThanOrEqual(LOG_WINDOW);
        return from <= 10_183_212n && 10_183_212n <= to ? [1, 2, 3] : [];
      },
      { fromBlock: 10_183_000n, done: (f) => f.length >= 3 },
    );
    expect(found).toEqual([1, 2, 3]);
    expect(calls).toEqual([[10_183_000n, 10_192_999n]]);
  });

  it("covers every block up to the head without gaps or overlaps", async () => {
    const seen: bigint[] = [];
    await scanForwards(
      { getBlockNumber: async () => 25_000n },
      async (from, to) => {
        for (let b = from; b <= to; b++) seen.push(b);
        return [];
      },
      { fromBlock: 1_000n },
    );
    expect(seen.length).toBe(24_001);
    expect(new Set(seen).size).toBe(24_001);
  });
});

describe("blockNear (the block at a time)", () => {
  // A chain with a block every 1.5 s from block 0 at t = 1,000,000,000.
  const chain = (head: bigint) => ({
    getBlock: async (a?: { blockNumber?: bigint }) => {
      const n = a?.blockNumber ?? head;
      return { number: n, timestamp: 1_000_000_000n + (n * 3n) / 2n };
    },
  });

  it("lands within a block of the right one", async () => {
    const t = 1_000_000_000n + (200_000n * 3n) / 2n;
    const n = await blockNear(chain(500_000n) as never, t);
    expect(n).toBeDefined();
    expect(n! >= 199_999n && n! <= 200_001n).toBe(true);
  });

  it("says the head for a time at or after it, and 0 before the chain", async () => {
    expect(await blockNear(chain(500_000n) as never, 2_000_000_000n)).toBe(500_000n);
    expect(await blockNear(chain(500_000n) as never, 1n)).toBe(0n);
  });

  it("is undefined when the client cannot say (callers then start at the head)", async () => {
    expect(await blockNear({ getBlock: async () => ({ timestamp: 5n }) } as never, 1n)).toBeUndefined();
    expect(await blockNear({ getBlock: async () => Promise.reject(new Error("down")) } as never, 1n)).toBeUndefined();
  });
});
