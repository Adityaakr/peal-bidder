/**
 * PealMandate v1: what an owner allows its agent to do.
 *
 * The owner writes a mandate and sends its canonical text as the body of a
 * qore-pq-kit `messaging` instruction: signed with QoreSign (secp256k1 +
 * ML-DSA-87) and sealed with QoreSeal to the agent's registered ML-KEM-1024
 * key. The agent opens it, checks the signature against the owner's ML-DSA-87
 * key read from the chain, and refuses anything that does not check out
 * (see `agent/inbox.ts`).
 *
 * The mandate is advisory to the chain: the chain enforces the spending rule,
 * the scoped window and the allowance on its own. The mandate is how the
 * owner tells the agent what it wants inside those limits, authenticated so
 * nobody else can.
 */
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { parseAddress } from "@qorechain/qoresign";
import { canonicalize, parseCanonical } from "./canonical.ts";
import { TESTNET_CHAIN_ID, TESTNET_EVM_CHAIN_ID } from "./network.ts";

export const MANDATE_TYPE = "PealMandate";
export const MANDATE_VERSION = 1;

/** The instruction purpose a mandate travels under (qore-pq-kit `messaging`). */
export const MANDATE_PURPOSE = "peal-bidder/mandate/v1";

export const MAX_AUCTIONS = 16;
export const MAX_INSTRUCTIONS_LENGTH = 2000;
export const MAX_BIDS = 1000;
export const MAX_LIFETIME_SECONDS = 30 * 24 * 3600;
export const MAX_TICK = 65_535;
const UINT256_MAX = (1n << 256n) - 1n;

export interface PealMandateV1 {
  type: typeof MANDATE_TYPE;
  version: typeof MANDATE_VERSION;
  /** Cosmos chain id; must be the network the agent runs on. */
  chainId: string;
  /** EVM chain id; must be the network the agent runs on. */
  evmChainId: number;
  /** The owner's `qor1` account: the signer of the mandate. */
  owner: string;
  /** The agent's `qor1` account: the only agent that may act on it. */
  agent: string;
  /** Lower-case 0x address of the quote token (fUSD), the token budgets are counted in. */
  quoteToken: string;
  /** Lower-case 0x addresses of the auctions the agent may bid in. */
  auctions: string[];
  /** Total quote-token outflow (escrow plus bond, base units) the agent may commit across all bids. */
  budget: string;
  /** Largest quote-token outflow (escrow plus bond, base units) of one bid. */
  maxPerBid: string;
  /** Highest price tick the agent may bid at. */
  maxTick: number;
  /** Most bids the agent may place under this mandate. */
  maxBids: number;
  /** Unix seconds; the mandate is refused before this time. */
  notBefore: number;
  /** Unix seconds; the mandate is refused from this time on. */
  expiresAt: number;
  /** Strictly increasing per owner and agent; a mandate replaces every one with a lower nonce. */
  nonce: number;
  /** Hex SHA3-256 of the agent's ML-DSA-87 receipt public key: receipts must be signed by it. */
  receiptKey: string;
  /** The owner's plain-English instructions. Advisory: they cannot widen any limit above. */
  instructions: string;
}

export type MandateErrorCode = "SCHEMA_INVALID" | "NOT_CANONICAL";

export class MandateError extends Error {
  override name = "MandateError";
  constructor(
    readonly code: MandateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const KEYS: readonly (keyof PealMandateV1)[] = [
  "type",
  "version",
  "chainId",
  "evmChainId",
  "owner",
  "agent",
  "quoteToken",
  "auctions",
  "budget",
  "maxPerBid",
  "maxTick",
  "maxBids",
  "notBefore",
  "expiresAt",
  "nonce",
  "receiptKey",
  "instructions",
];

const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const HEX32 = /^[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new MandateError("SCHEMA_INVALID", message);
}

function qorAddress(field: string, v: unknown): string {
  if (typeof v !== "string") fail(`${field} must be a qor1 address`);
  let bech32: string;
  try {
    bech32 = parseAddress(v).bech32;
  } catch {
    fail(`${field} must be a qor1 address`);
  }
  if (bech32 !== v) fail(`${field} must be a lower-case qor1 address`);
  return v;
}

function hexAddress(field: string, v: unknown): string {
  if (typeof v !== "string" || !HEX_ADDRESS.test(v)) fail(`${field} must be a lower-case 0x address`);
  return v;
}

function amount(field: string, v: unknown): bigint {
  if (typeof v !== "string" || !DECIMAL.test(v)) fail(`${field} must be a decimal string`);
  const n = BigInt(v);
  if (n > UINT256_MAX) fail(`${field} exceeds uint256`);
  return n;
}

function int(field: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    fail(`${field} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

/** Check every field of a parsed mandate. Throws `MandateError("SCHEMA_INVALID")`. */
export function validateMandate(value: unknown): PealMandateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("mandate must be an object");
  const m = value as Record<string, unknown>;
  const keys = Object.keys(m).sort();
  const expected = [...KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    fail(`mandate must have exactly the fields ${expected.join(", ")}`);
  }
  if (m.type !== MANDATE_TYPE) fail(`type must be ${MANDATE_TYPE}`);
  if (m.version !== MANDATE_VERSION) fail(`version must be ${MANDATE_VERSION}`);
  if (typeof m.chainId !== "string" || m.chainId.length === 0 || m.chainId.length > 64) fail("chainId must be a string");
  int("evmChainId", m.evmChainId, 1, Number.MAX_SAFE_INTEGER);
  const owner = qorAddress("owner", m.owner);
  const agent = qorAddress("agent", m.agent);
  if (owner === agent) fail("owner and agent must be different accounts");
  hexAddress("quoteToken", m.quoteToken);
  if (!Array.isArray(m.auctions) || m.auctions.length === 0 || m.auctions.length > MAX_AUCTIONS) {
    fail(`auctions must list 1 to ${MAX_AUCTIONS} addresses`);
  }
  m.auctions.forEach((a, i) => hexAddress(`auctions[${i}]`, a));
  if (new Set(m.auctions).size !== m.auctions.length) fail("auctions must not repeat");
  const budget = amount("budget", m.budget);
  const maxPerBid = amount("maxPerBid", m.maxPerBid);
  if (budget === 0n) fail("budget must be positive");
  if (maxPerBid === 0n) fail("maxPerBid must be positive");
  if (maxPerBid > budget) fail("maxPerBid must not exceed budget");
  int("maxTick", m.maxTick, 0, MAX_TICK);
  int("maxBids", m.maxBids, 1, MAX_BIDS);
  const notBefore = int("notBefore", m.notBefore, 0, Number.MAX_SAFE_INTEGER);
  const expiresAt = int("expiresAt", m.expiresAt, 0, Number.MAX_SAFE_INTEGER);
  if (expiresAt <= notBefore) fail("expiresAt must be after notBefore");
  if (expiresAt - notBefore > MAX_LIFETIME_SECONDS) fail("a mandate may last at most 30 days");
  int("nonce", m.nonce, 1, Number.MAX_SAFE_INTEGER);
  if (typeof m.receiptKey !== "string" || !HEX32.test(m.receiptKey)) fail("receiptKey must be 64 lower-case hex digits");
  if (typeof m.instructions !== "string" || m.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    fail(`instructions must be a string of at most ${MAX_INSTRUCTIONS_LENGTH} characters`);
  }
  return m as unknown as PealMandateV1;
}

/** Fill in the constant fields and normalise addresses, then validate. */
export function buildMandate(
  fields: Omit<PealMandateV1, "type" | "version" | "chainId" | "evmChainId"> &
    Partial<Pick<PealMandateV1, "chainId" | "evmChainId">>,
): PealMandateV1 {
  return validateMandate({
    type: MANDATE_TYPE,
    version: MANDATE_VERSION,
    chainId: fields.chainId ?? TESTNET_CHAIN_ID,
    evmChainId: fields.evmChainId ?? TESTNET_EVM_CHAIN_ID,
    owner: fields.owner,
    agent: fields.agent,
    quoteToken: fields.quoteToken.toLowerCase(),
    auctions: fields.auctions.map((a) => a.toLowerCase()),
    budget: fields.budget,
    maxPerBid: fields.maxPerBid,
    maxTick: fields.maxTick,
    maxBids: fields.maxBids,
    notBefore: fields.notBefore,
    expiresAt: fields.expiresAt,
    nonce: fields.nonce,
    receiptKey: fields.receiptKey.toLowerCase(),
    instructions: fields.instructions,
  });
}

/** The canonical text of a mandate. */
export function encodeMandate(m: PealMandateV1): string {
  return canonicalize(validateMandate(m));
}

/** Parse canonical mandate text. Throws `MandateError` on non-canonical text or a bad field. */
export function decodeMandate(text: string): PealMandateV1 {
  let value: unknown;
  try {
    value = parseCanonical(text);
  } catch (err) {
    throw new MandateError("NOT_CANONICAL", (err as Error).message);
  }
  return validateMandate(value);
}

/** Hex SHA3-256 of the canonical text: the mandate's identity in receipts and logs. */
export function mandateHash(text: string): string {
  return bytesToHex(sha3_256(utf8ToBytes(text)));
}
