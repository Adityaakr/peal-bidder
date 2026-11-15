/**
 * Owner side of the mandate channel: sign a mandate with the owner's hybrid
 * keys, then seal it to the agent's ML-KEM-1024 key.
 */
import { signMessage, type ClassicalKey, type PqKeyPair } from "@qorechain/qoresign";
import { envelopeToText, seal, type SealMode, type SealRecipient } from "@qorechain/qoreseal";
import {
  MANDATE_SEAL_PURPOSE,
  encodeMandate,
  mandateHash,
  mandateSealAad,
  mandateSignData,
  type PealMandateV1,
} from "../common/mandate.ts";
import { encodeSignedMandate, type SignedMandate } from "../common/signed.ts";

export interface OwnerKeys {
  /** The owner's `qor1` account. */
  address: string;
  classicalKey: ClassicalKey;
  pqKey: Pick<PqKeyPair, "secretKey">;
}

/** Sign the canonical text of `mandate` with the owner's secp256k1 and ML-DSA-87 keys. */
export function signMandate(mandate: PealMandateV1, owner: OwnerKeys): SignedMandate {
  if (mandate.owner !== owner.address) throw new Error("the mandate names another owner");
  const text = encodeMandate(mandate);
  const signature = signMessage({
    chainId: mandate.chainId,
    signer: owner.address,
    data: mandateSignData(text),
    classicalKey: owner.classicalKey,
    pqKey: owner.pqKey,
  });
  return { v: 1, mandate: text, signature };
}

/**
 * Seal a signed mandate to the agent. `recipient` must come from the agent's
 * registered ML-KEM-1024 key (and, in hybrid mode, its verified recipient
 * card), never from the agent's own say-so.
 */
export function sealMandate(args: {
  signed: SignedMandate;
  mandate: PealMandateV1;
  recipient: SealRecipient;
  mode?: SealMode;
}): { envelope: string; mandateHash: string } {
  const { signed, mandate } = args;
  if (encodeMandate(mandate) !== signed.mandate) throw new Error("the signed text is not this mandate");
  const envelope = seal({
    chainId: mandate.chainId,
    purpose: MANDATE_SEAL_PURPOSE,
    recipients: [args.recipient],
    plaintext: encodeSignedMandate(signed),
    aad: mandateSealAad(mandate.owner, mandate.agent),
    mode: args.mode ?? "hybrid",
  });
  return { envelope: envelopeToText(envelope), mandateHash: mandateHash(signed.mandate) };
}
