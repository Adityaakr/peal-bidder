/**
 * Agent side of the mandate channel: open a sealed mandate and decide whether
 * to act on it. Every check fails closed and returns a stable refusal code;
 * nothing is acted on unless every check passes.
 */
import { isQoreSignError, verifyMessage } from "@qorechain/qoresign";
import { envelopeFromText, isQoreSealError, open, type SealKeyPair } from "@qorechain/qoreseal";
import {
  MANDATE_SEAL_PURPOSE,
  MandateError,
  decodeMandate,
  mandateHash,
  mandateSealAad,
  mandateSignData,
  type PealMandateV1,
} from "../common/mandate.ts";
import type { Network } from "../common/network.ts";
import { decodeSignedMandate, type SignedMandate } from "../common/signed.ts";
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
  signed: SignedMandate;
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

function refuse(code: RefusalCode, message: string, hash?: string): MandateRefusal {
  return hash === undefined ? { ok: false, code, message } : { ok: false, code, message, mandateHash: hash };
}

/**
 * Open and check a sealed mandate (`qoreseal:` text). On success the mandate's
 * nonce is recorded, so the same mandate, or any older one, is refused next time.
 */
export async function receiveMandate(envelopeText: string, deps: InboxDeps): Promise<AcceptedMandate | MandateRefusal> {
  const { network, identity } = deps;

  let envelope: Uint8Array;
  try {
    envelope = envelopeFromText(envelopeText.trim());
  } catch {
    return refuse("ENVELOPE_MALFORMED", "not a QoreSeal envelope");
  }

  let plaintext: Uint8Array;
  try {
    plaintext = open({
      chainId: network.chainId,
      purpose: MANDATE_SEAL_PURPOSE,
      envelope,
      keys: identity.sealKeys,
      aad: mandateSealAad(identity.owner, identity.address),
    });
  } catch (err) {
    const code = isQoreSealError(err) ? err.code : "UNKNOWN";
    return refuse("SEAL_OPEN_FAILED", `the envelope does not open for this agent and owner (${code})`);
  }

  const signed = decodeSignedMandate(plaintext);
  if (!signed) return refuse("PAYLOAD_MALFORMED", "the envelope does not hold a signed mandate");
  const hash = mandateHash(signed.mandate);

  let mandate: PealMandateV1;
  try {
    mandate = decodeMandate(signed.mandate);
  } catch (err) {
    if (err instanceof MandateError) return refuse(err.code, err.message, hash);
    throw err;
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

  try {
    verifyMessage({
      chainId: network.chainId,
      signer: mandate.owner,
      data: mandateSignData(signed.mandate),
      signature: signed.signature,
      pqPublicKey: ownerKey,
      requirePq: true,
    });
  } catch (err) {
    const code = isQoreSignError(err) ? err.code : "UNKNOWN";
    return refuse("SIGNATURE_INVALID", `the owner's signature does not verify (${code})`, hash);
  }

  // From here on the mandate is authenticated.
  const now = deps.now();
  if (now < mandate.notBefore) return refuse("NOT_YET_VALID", `the mandate starts at ${mandate.notBefore}`, hash);
  if (now >= mandate.expiresAt) return refuse("EXPIRED", `the mandate expired at ${mandate.expiresAt}`, hash);

  if (mandate.receiptKey !== identity.receiptKeyHash) {
    return refuse("RECEIPT_KEY_MISMATCH", "the mandate pins another receipt key", hash);
  }

  const accepted = await deps.store.acceptNonce(mandate.owner, mandate.nonce, hash);
  if (!accepted) return refuse("REPLAYED", `nonce ${mandate.nonce} is not above the last accepted nonce`, hash);

  return { ok: true, mandate, text: signed.mandate, mandateHash: hash, signed };
}
