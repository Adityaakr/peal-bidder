/**
 * The signed mandate, as it travels inside a QoreSeal envelope.
 */
import type { MessageSignature } from "@qorechain/qoresign";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export interface SignedMandate {
  v: 1;
  /** Canonical PealMandate v1 text (see `common/mandate.ts`). */
  mandate: string;
  /** QoreSign hybrid signature over `mandateSignData(mandate)`. */
  signature: MessageSignature;
}

export function encodeSignedMandate(s: SignedMandate): Uint8Array {
  return utf8ToBytes(JSON.stringify({ v: s.v, mandate: s.mandate, signature: s.signature }));
}

/** Parse the plaintext of an opened envelope. Returns undefined when it is not a signed mandate. */
export function decodeSignedMandate(bytes: Uint8Array): SignedMandate | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (o.v !== 1 || typeof o.mandate !== "string") return undefined;
  const sig = o.signature as Record<string, unknown> | undefined;
  if (typeof sig !== "object" || sig === null) return undefined;
  const classical = sig.classical as Record<string, unknown> | undefined;
  if (
    typeof sig.signatureType !== "string" ||
    typeof classical !== "object" ||
    classical === null ||
    typeof classical.keyType !== "string" ||
    typeof classical.publicKey !== "string" ||
    typeof classical.signature !== "string"
  ) {
    return undefined;
  }
  if (sig.pq !== undefined) {
    const pq = sig.pq as Record<string, unknown>;
    if (typeof pq !== "object" || pq === null || typeof pq.algorithmId !== "number" || typeof pq.signature !== "string") {
      return undefined;
    }
  }
  return { v: 1, mandate: o.mandate, signature: o.signature as MessageSignature };
}
