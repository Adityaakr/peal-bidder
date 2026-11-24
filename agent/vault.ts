/**
 * Bidding from the owner's `BidderVault` (`contracts/src/BidderVault.sol`, not
 * audited): the contract holds the budget and is the bidder of every bid.
 *
 * The same sealed bid as before, wrapped one level: the encoder seals to the
 * vault's address (the auction's `msg.sender`), and `commitBid`'s arguments
 * travel inside `vault.bid(auction, …)`. Before anything is signed the agent
 * asks the vault what it would refuse (operator, expiry, approval, per-bid,
 * daily, budget, count, balance), so a hopeless bid is not sent. The vault
 * enforces the same limits again on chain; the agent's check is a courtesy.
 *
 * On the smart-account lane the caller is the owner's own 0x address, which
 * the agent's linked key acts as; on the window lane it is the agent account.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import type { PealMandateV1 } from "../common/mandate.ts";
import type { BidDecision } from "./agent.ts";
import { sealedAuctionAbi } from "./auction-abi.ts";
import type { BidEncoder, EncodedBid } from "./smart-account-executor.ts";

const POLICY_COMPONENTS = [
  { name: "operator", type: "address" },
  { name: "expiresAt", type: "uint64" },
  { name: "maxBids", type: "uint32" },
  { name: "maxPerBid", type: "uint128" },
  { name: "dailyLimit", type: "uint128" },
  { name: "budget", type: "uint128" },
] as const;

const APPROVAL_COMPONENTS = [
  { name: "auction", type: "address" },
  { name: "configHash", type: "bytes32" },
] as const;

const view = { type: "function", stateMutability: "view", inputs: [] } as const;
const call = { type: "function", stateMutability: "nonpayable" } as const;
const error = { type: "error" } as const;

/** The vault's interface, checked against the compiled artifact by `test/vault.test.ts`. */
export const bidderVaultAbi = [
  {
    ...call,
    name: "bid",
    inputs: [
      { name: "auction", type: "address" },
      { name: "seq", type: "uint32" },
      { name: "ct", type: "bytes32" },
      { name: "keyHash", type: "bytes32" },
      { name: "shareHashes", type: "bytes32[]" },
      { name: "envelopes", type: "bytes[]" },
      { name: "escrow", type: "uint256" },
    ],
    outputs: [{ name: "bidId", type: "uint256" }],
  },
  {
    ...call,
    name: "setPolicy",
    inputs: [
      { name: "p", type: "tuple", components: POLICY_COMPONENTS },
      { name: "approvals", type: "tuple[]", components: APPROVAL_COMPONENTS },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  { ...call, name: "revoke", inputs: [{ name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" }], outputs: [] },
  {
    ...call,
    name: "sweep",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  { ...call, name: "sweepAfterExit", inputs: [{ name: "token", type: "address" }], outputs: [] },
  { ...view, name: "owner", outputs: [{ name: "account", type: "address" }, { name: "nonce", type: "uint64" }] },
  { ...view, name: "quote", outputs: [{ name: "", type: "address" }] },
  { ...view, name: "factory", outputs: [{ name: "", type: "address" }] },
  { ...view, name: "policy", outputs: POLICY_COMPONENTS },
  { ...view, name: "epoch", outputs: [{ name: "", type: "uint256" }] },
  { ...view, name: "bidsUsed", outputs: [{ name: "", type: "uint32" }] },
  { ...view, name: "budgetUsed", outputs: [{ name: "", type: "uint128" }] },
  { ...view, name: "approvedAuctions", outputs: [{ name: "", type: "address[]" }] },
  { ...view, name: "exitOpensAt", outputs: [{ name: "", type: "uint256" }] },
  {
    ...view,
    name: "remaining",
    outputs: [
      { name: "today", type: "uint256" },
      { name: "budget", type: "uint256" },
      { name: "bids", type: "uint256" },
    ],
  },
  { ...error, name: "NotOperator", inputs: [] },
  { ...error, name: "PolicyExpired", inputs: [] },
  { ...error, name: "NotApproved", inputs: [{ name: "auction", type: "address" }] },
  { ...error, name: "NotVenueAuction", inputs: [{ name: "auction", type: "address" }] },
  { ...error, name: "ConfigMismatch", inputs: [{ name: "auction", type: "address" }, { name: "actual", type: "bytes32" }] },
  { ...error, name: "WrongQuote", inputs: [{ name: "auction", type: "address" }] },
  { ...error, name: "OverPerBid", inputs: [{ name: "total", type: "uint256" }] },
  { ...error, name: "OverDaily", inputs: [{ name: "spent", type: "uint256" }, { name: "total", type: "uint256" }] },
  { ...error, name: "OverBudget", inputs: [{ name: "used", type: "uint256" }, { name: "total", type: "uint256" }] },
  { ...error, name: "TooManyBids", inputs: [] },
  { ...error, name: "UnexpectedOutflow", inputs: [{ name: "got", type: "uint256" }, { name: "expected", type: "uint256" }] },
  { ...error, name: "BadPolicy", inputs: [{ name: "what", type: "string" }] },
  { ...error, name: "TooEarly", inputs: [] },
  // The kit's PqAuth, as the vault's owner functions revert with it.
  { ...error, name: "PqSignatureInvalid", inputs: [] },
  { ...error, name: "PqBadSignatureLength", inputs: [{ name: "length", type: "uint256" }] },
  { ...error, name: "PqExpired", inputs: [{ name: "deadline", type: "uint256" }, { name: "timestamp", type: "uint256" }] },
  { ...error, name: "PqDeadlineTooFar", inputs: [{ name: "deadline", type: "uint256" }, { name: "latestAllowed", type: "uint256" }] },
  { ...error, name: "PqPrecompileUnavailable", inputs: [{ name: "precompile", type: "address" }] },
] as const;

/** What the committee's reader decodes from a `MsgExecuteEVM`: it must not change. */
export const VAULT_BID_SIGNATURE = "bid(address,uint32,bytes32,bytes32,bytes32[],bytes[],uint256)";
export const VAULT_BID_SELECTOR = toFunctionSelector(VAULT_BID_SIGNATURE);

/** `--vault 0x…`, checked. */
export function parseVaultAddress(v: string): Address {
  if (!isAddress(v, { strict: false })) throw new Error(`${v} is not a contract address`);
  return getAddress(v.toLowerCase());
}

export interface VaultPolicy {
  operator: Address;
  expiresAt: bigint;
  maxBids: number;
  maxPerBid: bigint;
  dailyLimit: bigint;
  budget: bigint;
}

export interface VaultView {
  address: Address;
  owner: Address;
  /** The next owner signature's nonce. */
  nonce: bigint;
  quote: Address;
  factory: Address;
  epoch: bigint;
  policy: VaultPolicy;
  approvedAuctions: Address[];
  remaining: { today: bigint; budget: bigint; bids: bigint };
  /** Quote tokens in the vault now. */
  balance: bigint;
  exitOpensAt: bigint;
}

export type VaultClient = Pick<PublicClient, "readContract">;

const BALANCE_OF = [{ ...view, name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;

export async function readVault(client: VaultClient, address: Address): Promise<VaultView> {
  const read = { address, abi: bidderVaultAbi } as const;
  const [owner, quote, factory, epoch, p, approvedAuctions, rem, exitOpensAt] = await Promise.all([
    client.readContract({ ...read, functionName: "owner" }),
    client.readContract({ ...read, functionName: "quote" }),
    client.readContract({ ...read, functionName: "factory" }),
    client.readContract({ ...read, functionName: "epoch" }),
    client.readContract({ ...read, functionName: "policy" }),
    client.readContract({ ...read, functionName: "approvedAuctions" }),
    client.readContract({ ...read, functionName: "remaining" }),
    client.readContract({ ...read, functionName: "exitOpensAt" }),
  ]);
  const balance = await client.readContract({ address: quote, abi: BALANCE_OF, functionName: "balanceOf", args: [address] });
  return {
    address,
    owner: owner[0],
    nonce: owner[1],
    quote,
    factory,
    epoch,
    policy: { operator: p[0], expiresAt: p[1], maxBids: p[2], maxPerBid: p[3], dailyLimit: p[4], budget: p[5] },
    approvedAuctions: [...approvedAuctions],
    remaining: { today: rem[0], budget: rem[1], bids: rem[2] },
    balance,
    exitOpensAt,
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Why the vault would refuse this bid from `sender`, or undefined. `now` in unix seconds. */
export function vaultRefusal(v: VaultView, d: Pick<BidDecision, "auction" | "outflow">, sender: Address, quoteToken: string, now: number): string | undefined {
  if (!same(v.quote, quoteToken)) return "the vault holds another token than the mandate's";
  if (!same(v.policy.operator, sender)) return "the vault's operator is another account (or the policy was revoked)";
  if (BigInt(now) >= v.policy.expiresAt) return "the vault's policy has expired";
  if (!v.approvedAuctions.some((a) => same(a, d.auction))) return "the vault's owner has not approved this auction";
  if (v.remaining.bids === 0n) return "the vault's bid count is used up";
  if (d.outflow > v.policy.maxPerBid) return `the bid needs ${d.outflow}, the vault allows ${v.policy.maxPerBid} a bid`;
  if (d.outflow > v.remaining.today) return `the bid needs ${d.outflow}, the vault has ${v.remaining.today} left today`;
  if (d.outflow > v.remaining.budget) return `the bid needs ${d.outflow}, the vault has ${v.remaining.budget} of its budget left`;
  if (d.outflow > v.balance) return `the bid needs ${d.outflow}, the vault holds ${v.balance}`;
  return undefined;
}

/** `commitBid` calldata rewritten as `vault.bid(auction, …)`. */
export function wrapCommit(auction: Address, commitData: Hex): Hex {
  const { functionName, args } = decodeFunctionData({ abi: sealedAuctionAbi, data: commitData });
  if (functionName !== "commitBid") throw new Error(`not a commitBid: ${functionName}`);
  const [seq, ct, keyHash, shareHashes, envelopes, escrow] = args;
  return encodeFunctionData({ abi: bidderVaultAbi, functionName: "bid", args: [auction, seq, ct, keyHash, shareHashes, envelopes, escrow] });
}

export interface VaultBidEncoderDeps {
  /** Seals with `bidder` set to the vault. */
  inner: BidEncoder;
  vault: Address;
  /** Who will call the vault: the owner's 0x address (smart account) or the agent account (window). */
  operator: Address;
  client: VaultClient;
  now?: () => number;
}

/** Asks the vault, seals, and wraps. */
export class VaultBidEncoder implements BidEncoder {
  constructor(private readonly deps: VaultBidEncoderDeps) {}

  async encode(d: BidDecision, mandate: PealMandateV1): Promise<EncodedBid> {
    const now = this.deps.now ?? (() => Math.floor(Date.now() / 1000));
    const v = await readVault(this.deps.client, this.deps.vault);
    const why = vaultRefusal(v, d, this.deps.operator, mandate.quoteToken, now());
    if (why) throw new Error(why);
    const inner = await this.deps.inner.encode(d, mandate);
    if (!same(inner.to, d.auction)) throw new Error("the encoder targets another contract than the decision");
    return { to: this.deps.vault, data: wrapCommit(d.auction as Address, inner.data), gasLimit: inner.gasLimit };
  }
}

/** The encoded call is the decision's: straight to its auction, or to the vault naming it. */
export function assertBidTarget(bid: EncodedBid, d: Pick<BidDecision, "auction">, vault?: Address): void {
  if (!vault) {
    if (!same(bid.to, d.auction)) throw new Error("the encoder targets another contract than the decision");
    return;
  }
  if (!same(bid.to, vault)) throw new Error("the encoder targets another contract than the vault");
  const { functionName, args } = decodeFunctionData({ abi: bidderVaultAbi, data: bid.data });
  if (functionName !== "bid" || !same(args[0], d.auction)) throw new Error("the encoder's vault call names another auction than the decision");
}
