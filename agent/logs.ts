/**
 * Event logs from the public testnet RPC, which refuses `eth_getLogs` over
 * more than 10,000 blocks (found by Peal Sealed Auction on qorechain-diana).
 * Reads backwards from the latest block in windows of 9,999 blocks until the
 * caller has what it needs, or a block budget is spent.
 */
import type { PublicClient } from "viem";

export const LOG_WINDOW = 9_999n;
/** About two to three days of testnet blocks (roughly one a second). */
export const DEFAULT_MAX_BLOCKS = 250_000n;

export type LogsClient = Pick<PublicClient, "getContractEvents" | "getBlockNumber">;

/**
 * `fetch(from, to)` reads one window; `done(all)` says when to stop. Logs come
 * back oldest first. Stops at `fromBlock` (default: `maxBlocks` below the head).
 */
export async function scanBackwards<T>(
  client: Pick<PublicClient, "getBlockNumber">,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  opts: { done?: (found: T[]) => boolean; fromBlock?: bigint; maxBlocks?: bigint } = {},
): Promise<T[]> {
  const head = await client.getBlockNumber();
  const floorByBudget = head > (opts.maxBlocks ?? DEFAULT_MAX_BLOCKS) ? head - (opts.maxBlocks ?? DEFAULT_MAX_BLOCKS) : 0n;
  const floor = opts.fromBlock !== undefined && opts.fromBlock > floorByBudget ? opts.fromBlock : floorByBudget;
  let found: T[] = [];
  for (let to = head; to >= floor; ) {
    const from = to >= floor + LOG_WINDOW ? to - LOG_WINDOW : floor;
    const page = await fetch(from, to);
    found = [...page, ...found];
    if (opts.done?.(found)) break;
    if (from === floor) break;
    to = from - 1n;
  }
  return found;
}
