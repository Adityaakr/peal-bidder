/**
 * Event logs from the public testnet RPC, which refuses `eth_getLogs` over
 * more than 10,000 blocks (found by Peal Sealed Auction on qorechain-diana).
 *
 * - `scanBackwards` reads from a start block (default: the latest) down, in
 *   windows of 9,999 blocks, until the caller has what it needs or a block
 *   budget is spent.
 * - `scanForwards` reads up from a block where the caller knows the events
 *   begin (a contract's deployment), for events that sit near the start.
 * - `blockNear` estimates the block at a time, so a lookup can start where an
 *   event happened instead of at the head: the testnet makes about a block a
 *   second and a half, so a budget counted back from the head stops reaching
 *   an event after a few days.
 */
import type { PublicClient } from "viem";

export const LOG_WINDOW = 9_999n;
/** About four days of testnet blocks (roughly one every 1.5 s). */
export const DEFAULT_MAX_BLOCKS = 250_000n;

export type LogsClient = Pick<PublicClient, "getContractEvents" | "getBlockNumber">;

/**
 * `fetch(from, to)` reads one window; `done(all)` says when to stop. Logs come
 * back oldest first. Starts at `toBlock` (default: the head) and stops at
 * `fromBlock` (default: `maxBlocks` below the start).
 */
export async function scanBackwards<T>(
  client: Pick<PublicClient, "getBlockNumber">,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  opts: { done?: (found: T[]) => boolean; fromBlock?: bigint; toBlock?: bigint; maxBlocks?: bigint } = {},
): Promise<T[]> {
  const head = await client.getBlockNumber();
  const start = opts.toBlock !== undefined && opts.toBlock < head ? opts.toBlock : head;
  const budget = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const floorByBudget = start > budget ? start - budget : 0n;
  const floor = opts.fromBlock !== undefined && opts.fromBlock > floorByBudget ? opts.fromBlock : floorByBudget;
  let found: T[] = [];
  for (let to = start; to >= floor; ) {
    const from = to >= floor + LOG_WINDOW ? to - LOG_WINDOW : floor;
    const page = await fetch(from, to);
    found = [...page, ...found];
    if (opts.done?.(found)) break;
    if (from === floor) break;
    to = from - 1n;
  }
  return found;
}

/**
 * Reads from `fromBlock` up towards the head, in windows of 9,999 blocks, until
 * `done(all)` or `maxBlocks` past `fromBlock` (default: up to the head). Logs
 * come back oldest first.
 */
export async function scanForwards<T>(
  client: Pick<PublicClient, "getBlockNumber">,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  opts: { fromBlock: bigint; done?: (found: T[]) => boolean; maxBlocks?: bigint },
): Promise<T[]> {
  const head = await client.getBlockNumber();
  const ceiling = opts.maxBlocks !== undefined && opts.fromBlock + opts.maxBlocks < head ? opts.fromBlock + opts.maxBlocks : head;
  let found: T[] = [];
  for (let from = opts.fromBlock; from <= ceiling; ) {
    const to = from + LOG_WINDOW <= ceiling ? from + LOG_WINDOW : ceiling;
    found = [...found, ...(await fetch(from, to))];
    if (opts.done?.(found)) break;
    from = to + 1n;
  }
  return found;
}

export type BlockClient = Pick<PublicClient, "getBlock">;

/**
 * The block at about `timestamp` (seconds), from the head and a block 100,000
 * below it, corrected once against the block it first lands on. Good to a few
 * thousand blocks while the block rate holds; callers scan a margin around it.
 * Undefined when the client cannot say (then callers fall back to the head).
 */
export async function blockNear(client: BlockClient, timestamp: bigint): Promise<bigint | undefined> {
  try {
    const head = await client.getBlock();
    if (typeof head.number !== "bigint" || typeof head.timestamp !== "bigint") return undefined;
    if (timestamp >= head.timestamp) return head.number;
    const refNumber = head.number > 100_000n ? head.number - 100_000n : 0n;
    if (refNumber === head.number) return 0n;
    const ref = await client.getBlock({ blockNumber: refNumber });
    const span = head.timestamp - ref.timestamp;
    if (span <= 0n) return undefined;
    // blocks per second, as a ratio, kept in integers
    const perSecond = (dt: bigint) => (dt * (head.number - refNumber)) / span;
    let guess = head.number - perSecond(head.timestamp - timestamp);
    if (guess < 0n) guess = 0n;
    const at = await client.getBlock({ blockNumber: guess });
    const drift = at.timestamp - timestamp;
    guess = drift >= 0n ? guess - perSecond(drift) : guess + perSecond(-drift);
    if (guess < 0n) return 0n;
    return guess > head.number ? head.number : guess;
  } catch {
    return undefined;
  }
}
