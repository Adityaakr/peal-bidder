/**
 * Turning a clamped decision into a sealed `commitBid` call.
 *
 * 1. Read the auction's committee from its registry and check every member
 *    with qore-pq-kit's `verifyMember`: the ML-DSA-87 key from the chain, the
 *    ML-KEM-1024 key from REST against the hash the member signed into the
 *    registry, and the recipient card against its hash and both keys. A lying
 *    REST endpoint cannot substitute a key.
 * 2. Ask the contract for the escrow the bid needs and refuse if it differs
 *    from what the policy computed (a misread config must not reach the chain).
 * 3. Seal the bid with the kit's `sealSlot`: a fresh key K encrypts
 *    `quantity ‖ tick` in one block, K is split t-of-n, and each share is sealed
 *    to one member (ML-KEM-1024 + X25519), all bound to (chain, auction,
 *    bidder, seq).
 *
 * The bidder is whoever `msg.sender` will be: the owner's account on the
 * smart-account path, the agent's own account on the window path.
 * Nothing here logs K, a share or the plaintext.
 */
import type { RecipientCard, SealRecipient } from "@qorechain/qoreseal";
import { sealSlot, verifyMember } from "qore-pq-kit/threshold";
import { bytesToString, encodeFunctionData, hexToBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
import type { PealMandateV1 } from "../common/mandate.ts";
import type { BidDecision } from "./agent.ts";
import { MAX_ENVELOPE_BYTES, SHARE_PURPOSE, committeeRegistryAbi, encodePlaintext, sealedAuctionAbi } from "./auction-abi.ts";
import type { BidEncoder, EncodedBid } from "./smart-account-executor.ts";
import { blockNear, scanBackwards, scanForwards } from "./logs.ts";

export type EncoderClient = Pick<PublicClient, "readContract" | "getContractEvents" | "call" | "getBlockNumber" | "getBlock">;

export interface Committee {
  threshold: number;
  recipients: SealRecipient[];
  members: Address[];
}

export interface SealedBidEncoderDeps {
  client: EncoderClient;
  /** REST base URL for ML-KEM keys (may be an untrusted proxy). */
  rest: string;
  evmChainId: number;
  /** QoreSeal chain id the cards and envelopes are bound to. */
  sealChainId: string;
  /** `msg.sender` of the commit. */
  bidder: Address;
  gasLimit?: bigint;
  /** The registry's deployment block: `MemberJoined` events are read up from it. Without it they are read back from about the auction's start. */
  fromBlock?: bigint;
  fetch?: typeof globalThis.fetch;
  /** Tests only: replace member verification. */
  verify?: typeof verifyMember;
}

/** A sealed commit measured 405k to 439k gas on the testnet (Peal Sealed Auction's demo run); with headroom. */
export const DEFAULT_COMMIT_GAS = 800_000n;

export class SealedBidEncoder implements BidEncoder {
  private readonly committees = new Map<string, Committee>();

  constructor(private readonly deps: SealedBidEncoderDeps) {}

  /** The auction's committee, verified member by member (cached per auction: committee sets are immutable). */
  async committee(auction: Address): Promise<Committee> {
    const cached = this.committees.get(auction.toLowerCase());
    if (cached) return cached;
    const { client } = this.deps;
    const [cfg, registry, members, threshold] = await Promise.all([
      client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" }),
      client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "registry" }),
      client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "members" }),
      client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "threshold" }),
    ]);
    const [setThreshold, setMembers] = await client.readContract({
      address: registry,
      abi: committeeRegistryAbi,
      functionName: "getSet",
      args: [cfg.committeeSetId],
    });
    if (setThreshold !== threshold || setMembers.length !== members.length) throw new Error("the auction and its registry disagree on the committee");
    setMembers.forEach((m, i) => {
      if (m.account.toLowerCase() !== (members[i] as string).toLowerCase()) throw new Error(`committee member ${i + 1} differs between auction and registry`);
    });
    // Members join when their set is registered, before any auction uses it. With
    // the registry's deployment block known, read up from there (the joins sit at
    // the start); otherwise read back from about the auction's start.
    const fetchJoins = (fromBlock: bigint, toBlock: bigint) =>
      client.getContractEvents({ address: registry, abi: committeeRegistryAbi, eventName: "MemberJoined", args: { setId: cfg.committeeSetId }, fromBlock, toBlock, strict: true });
    const done = (found: { args: { index: number } }[]) => new Set(found.map((l) => Number(l.args.index))).size >= setMembers.length;
    const logs =
      this.deps.fromBlock !== undefined
        ? await scanForwards(client, fetchJoins, { fromBlock: this.deps.fromBlock, done })
        : await (async () => {
            const near = await blockNear(client, cfg.startTime);
            return scanBackwards(client, fetchJoins, { done, ...(near !== undefined ? { toBlock: near } : {}) });
          })();
    const cards = new Map<number, Hex>();
    for (const l of logs) cards.set(Number(l.args.index), l.args.card as Hex);
    const verify = this.deps.verify ?? verifyMember;
    const recipients: SealRecipient[] = [];
    for (let i = 0; i < setMembers.length; i++) {
      const m = setMembers[i]!;
      const raw = cards.get(i + 1);
      if (!raw) throw new Error(`no MemberJoined event for committee member ${i + 1}`);
      const card = JSON.parse(bytesToString(hexToBytes(raw))) as RecipientCard;
      recipients.push(
        await verify({
          address: m.account,
          expectKemSha3: m.kemKeySha3,
          card,
          expectCardHash: m.cardHash,
          sealChainId: this.deps.sealChainId,
          client: client as PublicClient,
          rest: this.deps.rest,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        }),
      );
    }
    const c = { threshold, recipients, members: setMembers.map((m) => m.account) };
    this.committees.set(auction.toLowerCase(), c);
    return c;
  }

  async encode(d: BidDecision, _mandate: PealMandateV1): Promise<EncodedBid> {
    const auction = d.auction as Address;
    const { client, bidder } = this.deps;
    const [cfg, escrow, seq] = await Promise.all([
      client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" }),
      client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "escrowFor", args: [d.qty, d.tick] }),
      client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "bidCountOf", args: [bidder] }),
    ]);
    if (escrow !== d.escrow) throw new Error(`the auction needs escrow ${escrow}, the policy computed ${d.escrow}`);
    if (cfg.bidBond !== d.bond) throw new Error(`the auction's bond is ${cfg.bidBond}, the policy counted ${d.bond}`);
    const committee = await this.committee(auction);
    const sealed = sealSlot({
      binding: { chainId: BigInt(this.deps.evmChainId), app: auction, sender: bidder, seq: BigInt(seq) },
      plaintext: encodePlaintext(d.qty, d.tick),
      committee: committee.recipients,
      threshold: committee.threshold,
      sealChainId: this.deps.sealChainId,
      purpose: SHARE_PURPOSE,
    });
    for (const e of sealed.envelopes) {
      if (e.length > MAX_ENVELOPE_BYTES) throw new Error(`a share envelope is ${e.length} bytes; the auction takes at most ${MAX_ENVELOPE_BYTES}`);
    }
    const data = encodeFunctionData({
      abi: sealedAuctionAbi,
      functionName: "commitBid",
      args: [seq, sealed.ct, sealed.keyHash, sealed.shareHashes, sealed.envelopes.map((e) => toHex(e)), escrow],
    });
    return { to: auction, data, gasLimit: this.deps.gasLimit ?? DEFAULT_COMMIT_GAS };
  }
}
