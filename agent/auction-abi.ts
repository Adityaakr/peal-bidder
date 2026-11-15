/**
 * The parts of Peal Sealed Auction's interface the agent uses, written out by
 * hand from the contracts at Adityaakr/peal-sealed-auction@f502616
 * (`src/SealedAuction.sol`, `src/CommitteeRegistry.sol`,
 * `src/SealedAuctionFactory.sol`). The two entries share no code: the hackathon
 * rules keep each entry's repository its own, so the agent carries this small
 * interface instead of importing the auction's client. Shared cryptography
 * comes from qore-pq-kit (`threshold`), which both use by tag.
 */

/** The bid's 32-byte plaintext and the QoreSeal purpose of every share, as the auction defines them. */
export const SHARE_PURPOSE = "peal-sealed-auction/share/v1";
export const COMMIT_BID_SIGNATURE = "commitBid(uint32,bytes32,bytes32,bytes32[],bytes[],uint256)";
/** `SealedAuction.MAX_ENVELOPE_BYTES`. */
export const MAX_ENVELOPE_BYTES = 4096;

/** `SealedAuction.State`. */
export const AUCTION_STATE = ["Created", "Funded", "CommitOpen", "Closed", "Settled", "Failed", "Cancelled"] as const;

const CONFIG_COMPONENTS = [
  { name: "issuer", type: "address" },
  { name: "saleToken", type: "address" },
  { name: "quoteToken", type: "address" },
  { name: "totalSupply", type: "uint256" },
  { name: "saleDecimals", type: "uint8" },
  { name: "reservePrice", type: "uint256" },
  { name: "tickSize", type: "uint256" },
  { name: "numTicks", type: "uint16" },
  { name: "startTime", type: "uint64" },
  { name: "endTime", type: "uint64" },
  { name: "releaseDeadline", type: "uint64" },
  { name: "minBidQuantity", type: "uint256" },
  { name: "maxQuantityPerAddress", type: "uint256" },
  { name: "maxBids", type: "uint32" },
  { name: "bidBond", type: "uint256" },
  { name: "protocolFeeBps", type: "uint16" },
  { name: "feeRecipient", type: "address" },
  { name: "committeeSetId", type: "bytes32" },
  { name: "metadataHash", type: "bytes32" },
] as const;

export const sealedAuctionAbi = [
  { type: "function", name: "config", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "tuple", components: CONFIG_COMPONENTS }] },
  { type: "function", name: "state", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "threshold", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "members", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address[]" }] },
  { type: "function", name: "bidCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint32" }] },
  {
    type: "function",
    name: "bidCountOf",
    stateMutability: "view",
    inputs: [{ name: "bidder", type: "address" }],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "escrowFor",
    stateMutability: "view",
    inputs: [
      { name: "quantity", type: "uint256" },
      { name: "tick", type: "uint16" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "commitBid",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seq", type: "uint32" },
      { name: "ct", type: "bytes32" },
      { name: "keyHash", type: "bytes32" },
      { name: "shareHashes", type: "bytes32[]" },
      { name: "envelopes", type: "bytes[]" },
      { name: "escrow", type: "uint256" },
    ],
    outputs: [{ name: "bidId", type: "uint256" }],
  },
] as const;

export const committeeRegistryAbi = [
  {
    type: "function",
    name: "getSet",
    stateMutability: "view",
    inputs: [{ name: "setId", type: "bytes32" }],
    outputs: [
      { name: "threshold", type: "uint8" },
      {
        name: "members",
        type: "tuple[]",
        components: [
          { name: "account", type: "address" },
          { name: "kemKeySha3", type: "bytes32" },
          { name: "cardHash", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "MemberJoined",
    inputs: [
      { name: "setId", type: "bytes32", indexed: true },
      { name: "index", type: "uint8", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "kemKeySha3", type: "bytes32", indexed: false },
      { name: "cardHash", type: "bytes32", indexed: false },
      { name: "card", type: "bytes", indexed: false },
    ],
  },
] as const;

export const auctionFactoryAbi = [
  {
    type: "event",
    name: "AuctionCreated",
    inputs: [
      { name: "auction", type: "address", indexed: true },
      { name: "issuer", type: "address", indexed: true },
      { name: "saleToken", type: "address", indexed: true },
      { name: "quoteToken", type: "address", indexed: false },
      { name: "totalSupply", type: "uint256", indexed: false },
      { name: "committeeSetId", type: "bytes32", indexed: false },
      { name: "startTime", type: "uint64", indexed: false },
      { name: "endTime", type: "uint64", indexed: false },
      { name: "releaseDeadline", type: "uint64", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "details", type: "string", indexed: false },
    ],
  },
] as const;

/** The 32-byte plaintext the contract decrypts: `uint128 quantity ‖ uint16 tick ‖ 14 zero bytes`. */
export function encodePlaintext(quantity: bigint, tick: number): `0x${string}` {
  if (quantity <= 0n || quantity >= 1n << 128n) throw new Error("quantity must be in 1..2^128-1");
  if (!Number.isInteger(tick) || tick < 0 || tick > 0xffff) throw new Error("tick must be a uint16");
  return `0x${((quantity << 128n) | (BigInt(tick) << 112n)).toString(16).padStart(64, "0")}`;
}
