/**
 * A fake QoreChain for the encoder and reader tests: an auction, its registry
 * and a committee of members with real keys (ML-DSA-87, ML-KEM-1024, signed
 * recipient cards), served through `readContract`, `getContractEvents`,
 * `call` (the pqcKeyStatus precompile) and a REST `fetch` (the KEM registry).
 */
import { generateSealKeys, signRecipientCard, type RecipientCard, type SealKeyPair } from "@qorechain/qoreseal";
import { cardHash, kemKeySha3 } from "qore-pq-kit/threshold";
import { bytesToHex, decodeFunctionData, encodeFunctionResult, stringToBytes, toHex, type Address, type Hex } from "viem";
import { PQC_KEY_STATUS_ABI } from "../agent/keysource.ts";
import { metadataHash } from "../agent/chain-auction.ts";
import { FUSD, TESTNET_CHAIN_ID } from "../common/network.ts";
import { AUCTION_A, newAccount, type TestAccount } from "./helpers.ts";

export const REGISTRY = "0x5555555555555555555555555555555555555555" as Address;
export const FACTORY = "0x6666666666666666666666666666666666666666" as Address;
export const SET_ID = `0x${"ab".repeat(32)}` as Hex;
export const E18 = 10n ** 18n;

export interface Member extends TestAccount {
  sealKeys: SealKeyPair;
  card: RecipientCard;
}

export function newMember(): Member {
  const a = newAccount();
  const sealKeys = generateSealKeys();
  const card = signRecipientCard({ chainId: TESTNET_CHAIN_ID, address: a.address, keys: sealKeys, classicalKey: a.classicalKey, pqKey: a.pqKey });
  return { ...a, sealKeys, card };
}

export interface FakeChainOptions {
  members?: Member[];
  threshold?: number;
  state?: number;
  startTime?: bigint;
  endTime?: bigint;
  bidCountOf?: number;
  /** Make the contract's escrow differ from AuctionMath's. */
  escrowSkew?: bigint;
  name?: string;
  details?: string;
  /** Emit AuctionCreated with text that does not match the metadata hash. */
  tamperMetadata?: boolean;
  /** Serve a different ML-KEM key over REST for member 1 (a lying proxy). */
  lyingRest?: boolean;
  blockTime?: bigint;
}

export function fakeChain(o: FakeChainOptions = {}) {
  const members = o.members ?? [newMember(), newMember(), newMember()];
  const threshold = o.threshold ?? 2;
  const name = o.name ?? "Peal Tender buyback #1";
  const details = o.details ?? "The treasury sells fUSD for PEAL-T.";
  const cfg = {
    issuer: "0x7777777777777777777777777777777777777777" as Address,
    saleToken: "0x8888888888888888888888888888888888888888" as Address,
    quoteToken: FUSD,
    totalSupply: 1_000_000n * E18,
    saleDecimals: 18,
    reservePrice: 100_000n,
    tickSize: 10_000n,
    numTicks: 64,
    startTime: o.startTime ?? 1_000n,
    endTime: o.endTime ?? 2_000_000_000n,
    releaseDeadline: 2_000_100_000n,
    minBidQuantity: E18,
    maxQuantityPerAddress: 0n,
    maxBids: 256,
    bidBond: 1_000_000n,
    protocolFeeBps: 0,
    feeRecipient: "0x0000000000000000000000000000000000000000" as Address,
    committeeSetId: SET_ID,
    metadataHash: metadataHash(name, details),
  };
  const regMembers = members.map((m) => ({ account: m.hex as Address, kemKeySha3: kemKeySha3(m.sealKeys.mlkemPublicKey), cardHash: cardHash(m.card) }));
  const calls: string[] = [];

  const client = {
    async readContract(args: { address: Address; functionName: string; args?: readonly unknown[] }) {
      calls.push(args.functionName);
      switch (args.functionName) {
        case "config":
          return cfg;
        case "state":
          return o.state ?? 2;
        case "registry":
          return REGISTRY;
        case "members":
          return members.map((m) => m.hex);
        case "threshold":
          return threshold;
        case "bidCountOf":
          return o.bidCountOf ?? 0;
        case "escrowFor": {
          const [qty, tick] = args.args as [bigint, number];
          const price = cfg.reservePrice + BigInt(tick) * cfg.tickSize;
          const n = qty * price;
          return (n === 0n ? 0n : (n + E18 - 1n) / E18) + (o.escrowSkew ?? 0n);
        }
        case "getSet":
          return [threshold, regMembers];
        default:
          throw new Error(`unexpected read ${args.functionName}`);
      }
    },
    async getContractEvents(args: { address: Address; eventName: string; args?: Record<string, unknown> }) {
      if (args.eventName === "MemberJoined") {
        return members.map((m, i) => ({
          args: { setId: SET_ID, index: i + 1, account: m.hex, kemKeySha3: regMembers[i]!.kemKeySha3, cardHash: regMembers[i]!.cardHash, card: toHex(stringToBytes(JSON.stringify(m.card))) },
        }));
      }
      if (args.eventName === "AuctionCreated") {
        return [{ args: { auction: AUCTION_A, name, details: o.tamperMetadata ? `${details} (edited)` : details } }];
      }
      return [];
    },
    async call(args: { to?: Address | null; data?: Hex }) {
      const { args: callArgs } = decodeFunctionData({ abi: PQC_KEY_STATUS_ABI, data: args.data as Hex });
      const m = members.find((x) => x.hex.toLowerCase() === (callArgs[0] as string).toLowerCase());
      return {
        data: encodeFunctionResult({
          abi: PQC_KEY_STATUS_ABI,
          functionName: "pqcKeyStatus",
          result: m ? [true, 1, bytesToHex(m.pqKey.publicKey), true] : [false, 0, "0x", false],
        }),
      };
    },
    async getBlock() {
      return { timestamp: o.blockTime ?? 1_795_000_000n };
    },
    async getBlockNumber() {
      return 50_000n;
    },
  };

  const fetch = (async (url: string) => {
    const addr = decodeURIComponent(url.split("/kem/")[1] ?? "");
    const i = members.findIndex((m) => m.address === addr);
    const key = i < 0 ? undefined : o.lyingRest && i === 0 ? generateSealKeys().mlkemPublicKey : members[i]!.sealKeys.mlkemPublicKey;
    const body = key ? { found: true, key: { address: addr, algorithm_id: 2, public_key: Buffer.from(key).toString("base64") } } : { found: false };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof globalThis.fetch;

  return { client, fetch, members, threshold, cfg, calls };
}
