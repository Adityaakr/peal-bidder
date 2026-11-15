/**
 * Owner side of the mandate channel, on qore-pq-kit's `messaging` module: a
 * mandate is the body of a signed instruction (QoreSign hybrid signature,
 * secp256k1 + ML-DSA-87) sealed to the agent (QoreSeal, ML-KEM-1024 + X25519).
 *
 * The instruction's fields repeat the mandate's chain, owner, agent, nonce and
 * expiry, and its purpose is `peal-bidder/mandate/v1`; the agent refuses an
 * instruction whose fields disagree with the mandate inside it.
 */
import { envelopeToText, type SealMode, type SealRecipient } from "@qorechain/qoreseal";
import type { ClassicalKey, PqKeyPair } from "@qorechain/qoresign";
import { isoSeconds, sealInstruction, signInstruction, type InstructionFields, type SignedInstruction } from "qore-pq-kit/messaging";
import { MANDATE_PURPOSE, encodeMandate, mandateHash, type PealMandateV1 } from "../common/mandate.ts";

export interface OwnerKeys {
  /** The owner's `qor1` account. */
  address: string;
  classicalKey: ClassicalKey;
  pqKey: Pick<PqKeyPair, "secretKey">;
}

/** The instruction fields that carry a mandate. */
export function mandateFields(mandate: PealMandateV1, issuedAt: Date = new Date()): InstructionFields {
  return {
    chainId: mandate.chainId,
    from: mandate.owner,
    to: mandate.agent,
    purpose: MANDATE_PURPOSE,
    nonce: String(mandate.nonce),
    issuedAt: isoSeconds(issuedAt),
    expiresAt: isoSeconds(new Date(mandate.expiresAt * 1000)),
    body: encodeMandate(mandate),
  };
}

/** Sign a mandate with the owner's secp256k1 and ML-DSA-87 keys (qore-pq-kit `signInstruction`). */
export function signMandate(mandate: PealMandateV1, owner: OwnerKeys, issuedAt?: Date): SignedInstruction {
  if (mandate.owner !== owner.address) throw new Error("the mandate names another owner");
  return signInstruction({ fields: mandateFields(mandate, issuedAt), classicalKey: owner.classicalKey, pqKey: owner.pqKey });
}

/**
 * Seal a signed mandate to the agent (qore-pq-kit `sealInstruction`).
 * `recipient` must come from the agent's registered ML-KEM-1024 key and, in
 * hybrid mode, its verified recipient card, never from the agent's own say-so.
 */
export function sealMandate(args: {
  signed: SignedInstruction;
  mandate: PealMandateV1;
  recipient: SealRecipient;
  mode?: SealMode;
}): { envelope: string; mandateHash: string } {
  const { signed, mandate } = args;
  if (encodeMandate(mandate) !== signed.fields.body) throw new Error("the signed instruction does not carry this mandate");
  const envelope = sealInstruction(signed, args.recipient, args.mode ?? "hybrid");
  return { envelope: envelopeToText(envelope), mandateHash: mandateHash(signed.fields.body) };
}
