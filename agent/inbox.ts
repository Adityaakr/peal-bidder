/**
 * Agent side of the mandate channel: open a sealed mandate and decide whether
 * to act on it. Every check fails closed and returns a stable refusal code;
 * nothing is acted on unless every check passes.
 *
 * The envelope and the signature are qore-pq-kit `messaging` instructions
 * (`openInstruction`, `verifyInstruction` with `requirePq`). What the kit does
 * not know, the agent checks here: that the instruction's fields agree with the
 * mandate it carries, the mandate's own fields, the owner's key from the
 * chain, the start time, the pinned receipt key and the strictly increasing
 * nonce.
 */
import { envelopeFromText, isQoreSealError, type SealKeyPair } from "@qorechain/qoreseal";
import { InstructionRefused, isoSeconds, openInstruction, verifyInstruction, type SignedInstruction } from "qore-pq-kit/messaging";
import { MANDATE_PURPOSE, MAX_LIFETIME_SECONDS, MandateError, decodeMandate, mandateHash, type PealMandateV1 } from "../common/mandate.ts";
import type { Network } from "../common/network.ts";
import { PqKeyError, type PqKeySource } from "./keysource.ts";
import type { MandateStore } from "./store.ts";

export type RefusalCode =
  | "ENVELOPE_MALFORMED"
  | "SEAL_OPEN_FAILED"
  | "PAYLOAD_MALFORMED"
  | "NOT_CANONICAL"
  | "SCHEMA_INVALID"
  | "WRONG_CHAIN"
  | "WRONG_AGENT"
  | "WRONG_OWNER"
  | "SIGNATURE_NOT_PQ"
  | "OWNER_KEY_UNAVAILABLE"
  | "SIGNATURE_INVALID"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "REPLAYED"
  | "RECEIPT_KEY_MISMATCH";

export interface MandateRefusal {
  ok: false;
  code: RefusalCode;
  message: string;
  /** Present once the mandate text could be read (it is not authenticated unless the code says so). */
  mandateHash?: string;
}

export interface AcceptedMandate {
  ok: true;
  mandate: PealMandateV1;
  /** Canonical text, exactly as signed. */
  text: string;
  mandateHash: string;
  signed: SignedInstruction;
}

export interface AgentIdentity {
  /** The agent's own `qor1` account. */
  address: string;
  /** The one owner this agent takes mandates from. */
  owner: string;
  /** The agent's QoreSeal keys (ML-KEM-1024 + X25519). */
  sealKeys: SealKeyPair;
  /** Hex SHA3-256 of the agent's ML-DSA-87 receipt public key. */
  receiptKeyHash: string;
}

export interface InboxDeps {
  network: Pick<Network, "chainId" | "evmChainId">;
  identity: AgentIdentity;
  keys: PqKeySource;
  store: MandateStore;
  /** Unix seconds. */
  now: () => number;
}

/** A sealed mandate is about 12 KB of text; anything far larger is refused before it is decoded. */
export const MAX_ENVELOPE_TEXT = 256 * 1024;

/** The longest an instruction may live: the mandate's own limit plus a day for signing ahead of `notBefore`. */
const MAX_INSTRUCTION_LIFETIME = MAX_LIFETIME_SECONDS + 86_400;

const FIELDS = ["chainId", "from", "to", "purpose", "nonce", "issuedAt", "expiresAt", "body"] as const;

function refuse(code: RefusalCode, message: string, hash?: string): MandateRefusal {
  return hash === undefined ? { ok: false, code, message } : { ok: false, code, message, mandateHash: hash };
}

function wellFormed(s: unknown): s is SignedInstruction {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  const f = o.fields as Record<string, unknown> | undefined;
  const sig = o.signature as Record<string, unknown> | undefined;
  if (o.version !== 1 || typeof f !== "object" || f === null || typeof sig !== "object" || sig === null) return false;
  if (!FIELDS.every((k) => typeof f[k] === "string")) return false;
  const classical = sig.classical as Record<string, unknown> | undefined;
  return (
    typeof sig.signatureType === "string" &&
    typeof classical === "object" &&
    classical !== null &&
    typeof classical.keyType === "string" &&
    typeof classical.publicKey === "string" &&
    typeof classical.signature === "string"
  );
}

/**
 * Open and check a sealed mandate (`qoreseal:` text). On success the mandate's
 * nonce is recorded, so the same mandate, or any older one, is refused next time.
 */
export async function receiveMandate(envelopeText: string, deps: InboxDeps): Promise<AcceptedMandate | MandateRefusal> {
  const { network, identity } = deps;

  if (envelopeText.length > MAX_ENVELOPE_TEXT) return refuse("ENVELOPE_MALFORMED", `the envelope is larger than ${MAX_ENVELOPE_TEXT} characters`);
  let envelope: Uint8Array;
  try {
    envelope = envelopeFromText(envelopeText.trim());
  } catch {
    return refuse("ENVELOPE_MALFORMED", "not a QoreSeal envelope");
  }

  let signed: unknown;
  try {
    signed = openInstruction({ envelope, keys: identity.sealKeys, chainId: network.chainId, to: identity.address, purpose: MANDATE_PURPOSE });
  } catch (err) {
    if (err instanceof InstructionRefused) return refuse("PAYLOAD_MALFORMED", err.reason);
    const code = isQoreSealError(err) ? err.code : "UNKNOWN";
    return refuse("SEAL_OPEN_FAILED", `the envelope does not open for this agent and purpose (${code})`);
  }
  if (!wellFormed(signed)) return refuse("PAYLOAD_MALFORMED", "the envelope does not hold a signed instruction");
  const f = signed.fields;
  const hash = mandateHash(f.body);

  let mandate: PealMandateV1;
  try {
    mandate = decodeMandate(f.body);
  } catch (err) {
    if (err instanceof MandateError) return refuse(err.code, err.message, hash);
    throw err;
  }

  // The instruction's fields must say what the mandate inside says.
  if (
    f.purpose !== MANDATE_PURPOSE ||
    f.chainId !== mandate.chainId ||
    f.from !== mandate.owner ||
    f.to !== mandate.agent ||
    f.nonce !== String(mandate.nonce) ||
    f.expiresAt !== isoSeconds(new Date(mandate.expiresAt * 1000))
  ) {
    return refuse("SCHEMA_INVALID", "the instruction's fields disagree with the mandate it carries", hash);
  }

  if (mandate.chainId !== network.chainId || mandate.evmChainId !== network.evmChainId) {
    return refuse("WRONG_CHAIN", `the mandate is for ${mandate.chainId}/${mandate.evmChainId}`, hash);
  }
  if (mandate.agent !== identity.address) return refuse("WRONG_AGENT", "the mandate names another agent", hash);
  if (mandate.owner !== identity.owner) return refuse("WRONG_OWNER", "the mandate names another owner", hash);
  if (signed.signature.signatureType !== "ml-dsa-87-hybrid" || !signed.signature.pq) {
    return refuse("SIGNATURE_NOT_PQ", "the mandate is not signed with ML-DSA-87", hash);
  }

  let ownerKey: Uint8Array;
  try {
    ownerKey = await deps.keys.pqPublicKey(mandate.owner);
  } catch (err) {
    const code = err instanceof PqKeyError ? err.code : "KEY_UNAVAILABLE";
    return refuse("OWNER_KEY_UNAVAILABLE", `the owner's ML-DSA-87 key cannot be read from the chain (${code})`, hash);
  }

  const now = deps.now();
  try {
    verifyInstruction(signed, ownerKey, {
      chainId: network.chainId,
      to: identity.address,
      purpose: MANDATE_PURPOSE,
      from: identity.owner,
      now: new Date(now * 1000),
      maxLifetimeSeconds: MAX_INSTRUCTION_LIFETIME,
    });
  } catch (err) {
    const reason = err instanceof InstructionRefused ? err.reason : (err as Error).message;
    if (reason.startsWith("bad signature")) return refuse("SIGNATURE_INVALID", `the owner's signature does not verify (${reason})`, hash);
    if (reason.startsWith("expired")) return refuse("EXPIRED", `the mandate ${reason}`, hash);
    if (reason.startsWith("issued in the future")) return refuse("NOT_YET_VALID", `the mandate was ${reason}`, hash);
    return refuse("SCHEMA_INVALID", reason, hash);
  }

  // From here on the mandate is authenticated.
  if (now < mandate.notBefore) return refuse("NOT_YET_VALID", `the mandate starts at ${mandate.notBefore}`, hash);
  if (now >= mandate.expiresAt) return refuse("EXPIRED", `the mandate expired at ${mandate.expiresAt}`, hash);

  if (mandate.receiptKey !== identity.receiptKeyHash) {
    return refuse("RECEIPT_KEY_MISMATCH", "the mandate pins another receipt key", hash);
  }

  const accepted = await deps.store.acceptNonce(mandate.owner, mandate.nonce, hash);
  if (!accepted) return refuse("REPLAYED", `nonce ${mandate.nonce} is not above the last accepted nonce`, hash);

  return { ok: true, mandate, text: f.body, mandateHash: hash, signed };
}
