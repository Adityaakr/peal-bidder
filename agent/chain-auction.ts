/**
 * Reading auctions from the chain.
 *
 * Every number comes from the auction contract's own `config()` and `state()`.
 * The issuer's name and description come from the factory's `AuctionCreated`
 * event and are kept only if they hash to the auction's `metadataHash`
 * (`keccak256(abi.encode(name, details))`, `SealedAuctionFactory.metadataHash`).
 * Either way they are untrusted text for the planner. The event is looked for
 * around the block at the auction's start time, not back from the head, so an
 * auction stays readable however long ago it was created.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex, type PublicClient } from "viem";
import type { AuctionReader } from "./agent.ts";
import { AUCTION_STATE, auctionFactoryAbi, sealedAuctionAbi } from "./auction-abi.ts";
import type { AuctionView } from "./auction.ts";
import { blockNear, scanBackwards } from "./logs.ts";

/** How far past the start-time block the creation event may sit (an auction can be created after its start), and how far back to look from there. */
const CREATED_AFTER_START = 20_000n;
const CREATED_SEARCH = 120_000n;

export type AuctionClient = Pick<PublicClient, "readContract" | "getContractEvents" | "getBlock" | "getBlockNumber">;

export function metadataHash(name: string, details: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [name, details]));
}

export class ChainAuctionReader implements AuctionReader {
  constructor(
    private readonly client: AuctionClient,
    private readonly opts: { factory?: Address; fromBlock?: bigint } = {},
  ) {}

  private async metadata(auction: Address, expected: Hex, startTime: bigint): Promise<{ name: string; details: string; verified: boolean }> {
    if (!this.opts.factory) return { name: "", details: "", verified: false };
    const factory = this.opts.factory;
    let logs;
    try {
      const near = await blockNear(this.client, startTime);
      const around = near === undefined ? {} : { toBlock: near + CREATED_AFTER_START, maxBlocks: CREATED_SEARCH };
      logs = await scanBackwards(
        this.client,
        (fromBlock, toBlock) =>
          this.client.getContractEvents({ address: factory, abi: auctionFactoryAbi, eventName: "AuctionCreated", args: { auction }, fromBlock, toBlock, strict: true }),
        { done: (found) => found.length > 0, ...around, ...(this.opts.fromBlock !== undefined ? { fromBlock: this.opts.fromBlock } : {}) },
      );
    } catch {
      // The text is optional: without it the planner still sees every number from the contract.
      return { name: "", details: "", verified: false };
    }
    for (const l of logs) {
      const { name, details } = l.args as { name: string; details: string };
      if (metadataHash(name, details).toLowerCase() === expected.toLowerCase()) return { name, details, verified: true };
    }
    return { name: "", details: "", verified: false };
  }

  async readOne(address: string, now: number): Promise<AuctionView> {
    const auction = address as Address;
    const [cfg, state] = await Promise.all([
      this.client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" }),
      this.client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "state" }),
    ]);
    const meta = await this.metadata(auction, cfg.metadataHash, cfg.startTime);
    const open = AUCTION_STATE[state] === "CommitOpen" && now >= Number(cfg.startTime) && now < Number(cfg.endTime);
    return {
      address: address.toLowerCase(),
      quoteToken: cfg.quoteToken.toLowerCase(),
      saleDecimals: cfg.saleDecimals,
      reservePrice: cfg.reservePrice,
      tickSize: cfg.tickSize,
      numTicks: cfg.numTicks,
      minQuantity: cfg.minBidQuantity,
      maxPerAddress: cfg.maxQuantityPerAddress,
      supply: cfg.totalSupply,
      bidBond: cfg.bidBond,
      commitOpen: open,
      commitEnd: Number(cfg.endTime),
      name: meta.name,
      details: meta.verified ? meta.details : "",
    };
  }

  /** Reads each auction; one that cannot be read is left out (the policy then skips it as unknown). */
  async read(addresses: string[]): Promise<AuctionView[]> {
    // The chain's clock decides whether bidding is open, not the agent's.
    const now = Number((await this.client.getBlock()).timestamp);
    const out: AuctionView[] = [];
    for (const a of addresses) {
      try {
        out.push(await this.readOne(a, now));
      } catch {
        // left out
      }
    }
    return out;
  }
}
