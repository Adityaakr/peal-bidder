/**
 * Auction views from a JSON file: what the agent reads until Peal Sealed
 * Auction's contracts are deployed (expected 22 to 23 November), and for
 * local runs. Large numbers are decimal strings.
 */
import { readFileSync } from "node:fs";
import type { AuctionReader } from "./agent.ts";
import type { AuctionView } from "./auction.ts";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DEC = /^[0-9]{1,78}$/;

export function parseAuctionView(o: Record<string, unknown>, where = "auction"): AuctionView {
  const addr = (k: string) => {
    const v = o[k];
    if (typeof v !== "string" || !ADDR.test(v)) throw new Error(`${where}.${k} must be a 0x address`);
    return v.toLowerCase();
  };
  const big = (k: string) => {
    const v = o[k];
    if (typeof v !== "string" || !DEC.test(v)) throw new Error(`${where}.${k} must be a decimal string`);
    return BigInt(v);
  };
  const num = (k: string, min: number, max: number) => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${where}.${k} must be an integer`);
    return v;
  };
  const text = (k: string) => {
    const v = o[k] ?? "";
    if (typeof v !== "string") throw new Error(`${where}.${k} must be a string`);
    return v;
  };
  if (typeof o.commitOpen !== "boolean") throw new Error(`${where}.commitOpen must be true or false`);
  return {
    address: addr("address"),
    quoteToken: addr("quoteToken"),
    saleDecimals: num("saleDecimals", 0, 36),
    reservePrice: big("reservePrice"),
    tickSize: big("tickSize"),
    numTicks: num("numTicks", 0, 65_536),
    minQuantity: big("minQuantity"),
    maxPerAddress: big("maxPerAddress"),
    supply: big("supply"),
    bidBond: big("bidBond"),
    commitOpen: o.commitOpen,
    commitEnd: num("commitEnd", 0, Number.MAX_SAFE_INTEGER),
    name: text("name"),
    details: text("details"),
  };
}

export class FileAuctionReader implements AuctionReader {
  constructor(private readonly path: string) {}

  async read(addresses: string[]): Promise<AuctionView[]> {
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error(`${this.path} must hold a JSON array of auctions`);
    const views = raw.map((o, i) => parseAuctionView(o as Record<string, unknown>, `${this.path}[${i}]`));
    return views.filter((v) => addresses.includes(v.address));
  }
}
