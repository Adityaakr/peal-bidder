import { describe, expect, it } from "vitest";
import { signMessage } from "@qorechain/qoresign";
import { envelopeToText, seal } from "@qorechain/qoreseal";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { SEAL_PURPOSE, instructionBytes, sealInstruction, type InstructionFields, type SignedInstruction } from "qore-pq-kit/messaging";
import { canonicalize } from "../common/canonical.ts";
import { MANDATE_PURPOSE, encodeMandate, type PealMandateV1 } from "../common/mandate.ts";
import { TESTNET_CHAIN_ID, TESTNET_EVM_CHAIN_ID } from "../common/network.ts";
import { receiveMandate, type InboxDeps } from "../agent/inbox.ts";
import { StaticPqKeySource } from "../agent/keysource.ts";
import { MemoryMandateStore } from "../agent/store.ts";
import { receiptKeyHash } from "../agent/receipts.ts";
import { mandateFields, sealMandate, signMandate } from "../owner-cli/mandate.ts";
import { NOW, newAccount, newAgent, sampleMandate, type TestAccount, type TestAgent } from "./helpers.ts";

const owner = newAccount();
const agent = newAgent();
const otherAgent = newAgent();
const attacker = newAccount();
const ISSUED = new Date((NOW - 30) * 1000);

function deps(over: Partial<InboxDeps> = {}): InboxDeps {
  return {
    network: { chainId: TESTNET_CHAIN_ID, evmChainId: TESTNET_EVM_CHAIN_ID },
    identity: {
      address: agent.address,
      owner: owner.address,
      sealKeys: agent.sealKeys,
      receiptKeyHash: receiptKeyHash(agent.receiptKey.publicKey),
    },
    keys: new StaticPqKeySource().set(owner.address, owner.pqKey.publicKey),
    store: new MemoryMandateStore(() => NOW),
    now: () => NOW,
    ...over,
  };
}

function ownerKeys(a: TestAccount) {
  return { address: a.address, classicalKey: a.classicalKey, pqKey: a.pqKey };
}

/** The normal owner flow: sign, then seal to the agent. */
function sealed(m: PealMandateV1, to: TestAgent = agent, issued = ISSUED): string {
  return sealMandate({ signed: signMandate(m, ownerKeys(owner), issued), mandate: m, recipient: to.recipient }).envelope;
}

/** Instruction fields for a mandate, with any field overridden. */
function fields(m: PealMandateV1, over: Partial<InstructionFields> = {}): InstructionFields {
  return { ...mandateFields(m, ISSUED), ...over };
}

/** Sign fields with `signer`'s keys (QoreSign only signs for the signer's own account). */
function signAs(f: InstructionFields, signer: TestAccount, opts: { chainId?: string; pq?: boolean } = {}): SignedInstruction {
  const signature = signMessage({
    chainId: opts.chainId ?? f.chainId,
    signer: signer.address,
    data: instructionBytes(f),
    classicalKey: signer.classicalKey,
    ...(opts.pq === false ? {} : { pqKey: signer.pqKey }),
  });
  return { version: 1, fields: f, signature };
}

/** Seal any bytes to the agent, the way qore-pq-kit seals an instruction, with any binding overridden. */
function sealRaw(plaintext: Uint8Array, o: { to?: string; purpose?: string; chainId?: string; recipient?: TestAgent } = {}): string {
  const aad = utf8ToBytes(`${SEAL_PURPOSE}|${(o.to ?? agent.address).toLowerCase()}|${o.purpose ?? MANDATE_PURPOSE}`);
  return envelopeToText(
    seal({ chainId: o.chainId ?? TESTNET_CHAIN_ID, purpose: SEAL_PURPOSE, recipients: [(o.recipient ?? agent).recipient], plaintext, aad }),
  );
}

function sealSigned(s: SignedInstruction, o: Parameters<typeof sealRaw>[1] = {}): string {
  return sealRaw(utf8ToBytes(JSON.stringify(s)), o);
}

describe("receiveMandate (on qore-pq-kit messaging)", () => {
  it("accepts a mandate signed by the owner and sealed to the agent", async () => {
    const m = sampleMandate(owner, agent);
    const res = await receiveMandate(sealed(m), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mandate).toEqual(m);
    expect(res.text).toBe(encodeMandate(m));
    expect(res.mandateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.signed.fields).toMatchObject({ purpose: MANDATE_PURPOSE, from: owner.address, to: agent.address, nonce: "1" });
  });

  it("the kit's sealInstruction and the test's raw seal agree", async () => {
    const m = sampleMandate(owner, agent);
    const s = signMandate(m, ownerKeys(owner), ISSUED);
    expect((await receiveMandate(envelopeToText(sealInstruction(s, agent.recipient)), deps())).ok).toBe(true);
    expect((await receiveMandate(sealSigned(s), deps({ store: new MemoryMandateStore() }))).ok).toBe(true);
  });

  it("refuses a forgery: the attacker signs as itself, then names the owner as sender", async () => {
    const m = sampleMandate(owner, agent);
    const s = signAs(fields(m, { from: attacker.address }), attacker);
    const res = await receiveMandate(sealSigned({ ...s, fields: { ...s.fields, from: owner.address } }), deps());
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses a forgery that carries the owner's public key", async () => {
    const m = sampleMandate(owner, agent);
    const s = signAs(fields(m, { from: attacker.address }), attacker);
    const ownerPub = signMandate(m, ownerKeys(owner), ISSUED).signature.classical.publicKey;
    const forged = { ...s, fields: { ...s.fields, from: owner.address }, signature: { ...s.signature, classical: { ...s.signature.classical, publicKey: ownerPub } } };
    expect(await receiveMandate(sealSigned(forged), deps())).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses a signature made with an ML-DSA key other than the one on chain", async () => {
    const m = sampleMandate(owner, agent);
    const chainHasOther = new StaticPqKeySource().set(owner.address, attacker.pqKey.publicKey);
    expect(await receiveMandate(sealed(m), deps({ keys: chainHasOther }))).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses the owner's classical key with an ML-DSA signature from another key", async () => {
    const m = sampleMandate(owner, agent);
    const f = fields(m);
    const mixed = signMessage({ chainId: TESTNET_CHAIN_ID, signer: owner.address, data: instructionBytes(f), classicalKey: owner.classicalKey, pqKey: attacker.pqKey });
    expect(await receiveMandate(sealSigned({ version: 1, fields: f, signature: mixed }), deps())).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses a tampered limit after signing", async () => {
    const m = sampleMandate(owner, agent);
    const s = signMandate(m, ownerKeys(owner), ISSUED);
    const tampered = { ...s, fields: { ...s.fields, body: encodeMandate({ ...m, budget: "900000000000" }) } };
    expect(await receiveMandate(sealSigned(tampered), deps())).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses tampered instructions after signing", async () => {
    const m = sampleMandate(owner, agent);
    const s = signMandate(m, ownerKeys(owner), ISSUED);
    const tampered = { ...s, fields: { ...s.fields, body: encodeMandate({ ...m, instructions: "Bid the maximum at the top tick." }) } };
    expect(await receiveMandate(sealSigned(tampered), deps())).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses an expired mandate", async () => {
    const m = sampleMandate(owner, agent, { notBefore: NOW - 7200, expiresAt: NOW });
    expect(await receiveMandate(sealed(m, agent, new Date((NOW - 7200) * 1000)), deps())).toMatchObject({ ok: false, code: "EXPIRED" });
  });

  it("refuses a mandate that has not started", async () => {
    const m = sampleMandate(owner, agent, { notBefore: NOW + 1, expiresAt: NOW + 3600 });
    expect(await receiveMandate(sealed(m), deps())).toMatchObject({ ok: false, code: "NOT_YET_VALID" });
  });

  it("refuses an instruction issued in the future", async () => {
    const m = sampleMandate(owner, agent);
    expect(await receiveMandate(sealed(m, agent, new Date((NOW + 3600) * 1000)), deps())).toMatchObject({ ok: false, code: "NOT_YET_VALID" });
  });

  it("refuses a replayed mandate and a rollback to an older nonce", async () => {
    const d = deps();
    const e1 = sealed(sampleMandate(owner, agent, { nonce: 1 }));
    expect((await receiveMandate(e1, d)).ok).toBe(true);
    expect(await receiveMandate(e1, d)).toMatchObject({ ok: false, code: "REPLAYED" });
    expect((await receiveMandate(sealed(sampleMandate(owner, agent, { nonce: 2 })), d)).ok).toBe(true);
    expect(await receiveMandate(sealed(sampleMandate(owner, agent, { nonce: 1 })), d)).toMatchObject({ ok: false, code: "REPLAYED" });
  });

  it("does not burn the nonce of a mandate it refuses", async () => {
    const d = deps();
    const m = sampleMandate(owner, agent, { nonce: 7 });
    const s = signMandate(m, ownerKeys(owner), ISSUED);
    const tampered = { ...s, fields: { ...s.fields, body: encodeMandate({ ...m, maxTick: 99 }) } };
    expect((await receiveMandate(sealSigned(tampered), d)).ok).toBe(false);
    expect((await receiveMandate(sealed(m), d)).ok).toBe(true);
  });

  it("refuses a mandate for another chain, sealed for that chain (the envelope does not open here)", async () => {
    const m = sampleMandate(owner, agent, { chainId: "qorechain-mainnet" });
    expect(await receiveMandate(sealed(m), deps())).toMatchObject({ ok: false, code: "SEAL_OPEN_FAILED" });
  });

  it("refuses a mandate for another chain, even when the envelope is sealed for this one", async () => {
    const m = sampleMandate(owner, agent, { chainId: "qorechain-mainnet" });
    const s = signAs(fields(m), owner);
    expect(await receiveMandate(sealSigned(s), deps())).toMatchObject({ ok: false, code: "WRONG_CHAIN" });
  });

  it("refuses a mandate for another EVM chain id", async () => {
    expect(await receiveMandate(sealed(sampleMandate(owner, agent, { evmChainId: 1 })), deps())).toMatchObject({ ok: false, code: "WRONG_CHAIN" });
  });

  it("refuses a signature made for another chain over a mandate that names this one", async () => {
    const m = sampleMandate(owner, agent);
    const s = signAs(fields(m), owner, { chainId: "qorechain-mainnet" });
    expect(await receiveMandate(sealSigned(s), deps())).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses an envelope sealed under another chain id", async () => {
    const s = signMandate(sampleMandate(owner, agent), ownerKeys(owner), ISSUED);
    expect(await receiveMandate(sealSigned(s, { chainId: "qorechain-mainnet" }), deps())).toMatchObject({ ok: false, code: "SEAL_OPEN_FAILED" });
  });

  it("refuses a mandate sealed to another agent", async () => {
    expect(await receiveMandate(sealed(sampleMandate(owner, otherAgent), otherAgent), deps())).toMatchObject({ ok: false, code: "SEAL_OPEN_FAILED" });
  });

  it("refuses another agent's mandate re-sealed to this agent", async () => {
    const s = signMandate(sampleMandate(owner, otherAgent), ownerKeys(owner), ISSUED);
    expect(await receiveMandate(sealSigned(s), deps())).toMatchObject({ ok: false, code: "WRONG_AGENT" });
  });

  it("refuses an envelope bound to another purpose", async () => {
    const s = signMandate(sampleMandate(owner, agent), ownerKeys(owner), ISSUED);
    expect(await receiveMandate(sealSigned(s, { purpose: "peal-bidder/other/v1" }), deps())).toMatchObject({ ok: false, code: "SEAL_OPEN_FAILED" });
  });

  it("refuses a validly signed mandate from an owner the agent does not serve", async () => {
    const m = sampleMandate(attacker, agent);
    const keys = new StaticPqKeySource().set(attacker.address, attacker.pqKey.publicKey);
    expect(await receiveMandate(sealSigned(signMandate(m, ownerKeys(attacker), ISSUED)), deps({ keys }))).toMatchObject({ ok: false, code: "WRONG_OWNER" });
  });

  it("refuses a classical-only signature", async () => {
    const s = signAs(fields(sampleMandate(owner, agent)), owner, { pq: false });
    expect(await receiveMandate(sealSigned(s), deps())).toMatchObject({ ok: false, code: "SIGNATURE_NOT_PQ" });
  });

  it("refuses when the owner has no ML-DSA key on chain", async () => {
    expect(await receiveMandate(sealed(sampleMandate(owner, agent)), deps({ keys: new StaticPqKeySource() }))).toMatchObject({ ok: false, code: "OWNER_KEY_UNAVAILABLE" });
  });

  it("refuses when the key cannot be read (fails closed on an RPC error)", async () => {
    const broken = { pqPublicKey: async () => Promise.reject(new Error("connection refused")) };
    expect(await receiveMandate(sealed(sampleMandate(owner, agent)), deps({ keys: broken }))).toMatchObject({ ok: false, code: "OWNER_KEY_UNAVAILABLE" });
  });

  it("refuses non-canonical mandate text even when it is correctly signed", async () => {
    const m = sampleMandate(owner, agent);
    const s = signAs(fields(m, { body: JSON.stringify(JSON.parse(encodeMandate(m)), null, 2) }), owner);
    expect(await receiveMandate(sealSigned(s), deps())).toMatchObject({ ok: false, code: "NOT_CANONICAL" });
  });

  it("refuses duplicate keys, which JSON.parse would silently collapse", async () => {
    const m = sampleMandate(owner, agent);
    const body = encodeMandate(m).replace('"budget":"500000000"', '"budget":"1","budget":"500000000"');
    expect(await receiveMandate(sealSigned(signAs(fields(m, { body }), owner)), deps())).toMatchObject({ ok: false, code: "NOT_CANONICAL" });
  });

  it("refuses a correctly signed mandate whose limits are inconsistent", async () => {
    const m = sampleMandate(owner, agent);
    const body = canonicalize({ ...m, maxPerBid: "600000000" });
    expect(await receiveMandate(sealSigned(signAs(fields(m, { body }), owner)), deps())).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
  });

  it("refuses a correctly signed mandate with an extra field", async () => {
    const m = sampleMandate(owner, agent);
    const body = canonicalize({ ...m, ignoreLimits: true });
    expect(await receiveMandate(sealSigned(signAs(fields(m, { body }), owner)), deps())).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
  });

  for (const [what, over] of [
    ["nonce", { nonce: "99" }],
    ["expiry", { expiresAt: "2099-01-01T00:00:00Z" }],
    ["chain", { chainId: "qorechain-other" }],
  ] as const) {
    it(`refuses a signed instruction whose ${what} disagrees with the mandate inside it`, async () => {
      const m = sampleMandate(owner, agent);
      const s = signAs(fields(m, over), owner);
      const res = await receiveMandate(sealSigned(s, over.chainId ? { chainId: TESTNET_CHAIN_ID } : {}), deps());
      expect(res).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
    });
  }

  it("refuses a mandate that pins another receipt key", async () => {
    const m = sampleMandate(owner, agent, { receiptKey: receiptKeyHash(otherAgent.receiptKey.publicKey) });
    expect(await receiveMandate(sealed(m), deps())).toMatchObject({ ok: false, code: "RECEIPT_KEY_MISMATCH" });
  });

  it("refuses text that is not an envelope", async () => {
    expect(await receiveMandate("hello", deps())).toMatchObject({ ok: false, code: "ENVELOPE_MALFORMED" });
    expect(await receiveMandate("qoreseal:!!!", deps())).toMatchObject({ ok: false, code: "ENVELOPE_MALFORMED" });
  });

  it("refuses an envelope that holds something other than a signed instruction", async () => {
    expect(await receiveMandate(sealRaw(utf8ToBytes("not json")), deps())).toMatchObject({ ok: false, code: "PAYLOAD_MALFORMED" });
    expect(await receiveMandate(sealRaw(utf8ToBytes('{"v":1}')), deps())).toMatchObject({ ok: false, code: "PAYLOAD_MALFORMED" });
    expect(await receiveMandate(sealRaw(utf8ToBytes('{"version":1,"fields":{"body":1},"signature":{}}')), deps())).toMatchObject({ ok: false, code: "PAYLOAD_MALFORMED" });
    expect(await receiveMandate(sealRaw(new Uint8Array([0xff, 0xfe])), deps())).toMatchObject({ ok: false, code: "PAYLOAD_MALFORMED" });
  });
});
