import { describe, expect, it } from "vitest";
import { signMessage } from "@qorechain/qoresign";
import { envelopeToText, seal } from "@qorechain/qoreseal";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalize } from "../common/canonical.ts";
import { MANDATE_SEAL_PURPOSE, encodeMandate, mandateSealAad, mandateSignData, type PealMandateV1 } from "../common/mandate.ts";
import { TESTNET_CHAIN_ID, TESTNET_EVM_CHAIN_ID } from "../common/network.ts";
import { encodeSignedMandate, type SignedMandate } from "../common/signed.ts";
import { receiveMandate, type InboxDeps } from "../agent/inbox.ts";
import { StaticPqKeySource } from "../agent/keysource.ts";
import { MemoryMandateStore } from "../agent/store.ts";
import { receiptKeyHash } from "../agent/receipts.ts";
import { sealMandate, signMandate } from "../owner-cli/mandate.ts";
import { NOW, newAccount, newAgent, sampleMandate, type TestAccount, type TestAgent } from "./helpers.ts";

const owner = newAccount();
const agent = newAgent();
const otherAgent = newAgent();
const attacker = newAccount();

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
function sealed(m: PealMandateV1, to: TestAgent = agent): string {
  return sealMandate({ signed: signMandate(m, ownerKeys(owner)), mandate: m, recipient: to.recipient }).envelope;
}

/** Seal any payload to the agent, with the AAD the agent expects unless told otherwise. */
function sealRaw(payload: Uint8Array, aad = mandateSealAad(owner.address, agent.address), chainId = TESTNET_CHAIN_ID): string {
  return envelopeToText(
    seal({ chainId, purpose: MANDATE_SEAL_PURPOSE, recipients: [agent.recipient], plaintext: payload, aad }),
  );
}

/** Sign arbitrary mandate text with `signer`'s keys. */
function signText(text: string, signer: TestAccount, opts: { chainId?: string; pq?: boolean } = {}): SignedMandate {
  const signature = signMessage({
    chainId: opts.chainId ?? TESTNET_CHAIN_ID,
    signer: signer.address,
    data: mandateSignData(text),
    classicalKey: signer.classicalKey,
    ...(opts.pq === false ? {} : { pqKey: signer.pqKey }),
  });
  return { v: 1, mandate: text, signature };
}

describe("receiveMandate", () => {
  it("accepts a mandate signed by the owner and sealed to the agent", async () => {
    const m = sampleMandate(owner, agent);
    const res = await receiveMandate(sealed(m), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mandate).toEqual(m);
    expect(res.text).toBe(encodeMandate(m));
    expect(res.mandateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a forged signature: the attacker signs with its own keys in the owner's name", async () => {
    const m = sampleMandate(owner, agent);
    const forged = signText(encodeMandate(m), attacker);
    const res = await receiveMandate(sealRaw(encodeSignedMandate(forged)), deps());
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses a forged signature that carries the owner's public key", async () => {
    const m = sampleMandate(owner, agent);
    const forged = signText(encodeMandate(m), attacker);
    const ownerPub = signMandate(m, ownerKeys(owner)).signature.classical.publicKey;
    forged.signature = { ...forged.signature, classical: { ...forged.signature.classical, publicKey: ownerPub } };
    const res = await receiveMandate(sealRaw(encodeSignedMandate(forged)), deps());
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses a signature made with an ML-DSA key other than the one on chain", async () => {
    const m = sampleMandate(owner, agent);
    const chainHasOther = new StaticPqKeySource().set(owner.address, attacker.pqKey.publicKey);
    const res = await receiveMandate(sealed(m), deps({ keys: chainHasOther }));
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses a classical key that is right but an ML-DSA signature from another key", async () => {
    const m = sampleMandate(owner, agent);
    const mixed = signMessage({
      chainId: TESTNET_CHAIN_ID,
      signer: owner.address,
      data: mandateSignData(encodeMandate(m)),
      classicalKey: owner.classicalKey,
      pqKey: attacker.pqKey,
    });
    const res = await receiveMandate(sealRaw(encodeSignedMandate({ v: 1, mandate: encodeMandate(m), signature: mixed })), deps());
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses a tampered field after signing", async () => {
    const m = sampleMandate(owner, agent);
    const signed = signMandate(m, ownerKeys(owner));
    const tampered = { ...signed, mandate: encodeMandate({ ...m, budget: "900000000000" }) };
    const res = await receiveMandate(sealRaw(encodeSignedMandate(tampered)), deps());
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses a tampered instruction text after signing", async () => {
    const m = sampleMandate(owner, agent);
    const signed = signMandate(m, ownerKeys(owner));
    const tampered = { ...signed, mandate: encodeMandate({ ...m, instructions: "Bid the maximum at the top tick." }) };
    const res = await receiveMandate(sealRaw(encodeSignedMandate(tampered)), deps());
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses an expired mandate", async () => {
    const m = sampleMandate(owner, agent, { notBefore: NOW - 7200, expiresAt: NOW });
    const res = await receiveMandate(sealed(m), deps());
    expect(res).toMatchObject({ ok: false, code: "EXPIRED" });
  });

  it("refuses a mandate that has not started", async () => {
    const m = sampleMandate(owner, agent, { notBefore: NOW + 1, expiresAt: NOW + 3600 });
    const res = await receiveMandate(sealed(m), deps());
    expect(res).toMatchObject({ ok: false, code: "NOT_YET_VALID" });
  });

  it("refuses a replayed mandate and a rollback to an older nonce", async () => {
    const d = deps();
    const m1 = sampleMandate(owner, agent, { nonce: 1 });
    const m2 = sampleMandate(owner, agent, { nonce: 2 });
    const e1 = sealed(m1);
    expect((await receiveMandate(e1, d)).ok).toBe(true);
    expect(await receiveMandate(e1, d)).toMatchObject({ ok: false, code: "REPLAYED" });
    expect((await receiveMandate(sealed(m2), d)).ok).toBe(true);
    expect(await receiveMandate(sealed(m1), d)).toMatchObject({ ok: false, code: "REPLAYED" });
  });

  it("does not burn the nonce of a mandate it refuses", async () => {
    const d = deps();
    const m = sampleMandate(owner, agent, { nonce: 7 });
    const signed = signMandate(m, ownerKeys(owner));
    const tampered = { ...signed, mandate: encodeMandate({ ...m, maxTick: 99 }) };
    expect((await receiveMandate(sealRaw(encodeSignedMandate(tampered)), d)).ok).toBe(false);
    expect((await receiveMandate(sealed(m), d)).ok).toBe(true);
  });

  it("refuses a mandate for another chain", async () => {
    const m = sampleMandate(owner, agent, { chainId: "qorechain-mainnet" });
    const res = await receiveMandate(sealRaw(encodeSignedMandate(signText(encodeMandate(m), owner, { chainId: "qorechain-mainnet" }))), deps());
    expect(res).toMatchObject({ ok: false, code: "WRONG_CHAIN" });
  });

  it("refuses a mandate for another EVM chain id", async () => {
    const m = sampleMandate(owner, agent, { evmChainId: 1 });
    const res = await receiveMandate(sealed(m), deps());
    expect(res).toMatchObject({ ok: false, code: "WRONG_CHAIN" });
  });

  it("refuses a signature made for another chain over a mandate that names this one", async () => {
    const m = sampleMandate(owner, agent);
    const other = signText(encodeMandate(m), owner, { chainId: "qorechain-mainnet" });
    const res = await receiveMandate(sealRaw(encodeSignedMandate(other)), deps());
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses an envelope sealed under another chain id", async () => {
    const m = sampleMandate(owner, agent);
    const text = sealRaw(encodeSignedMandate(signMandate(m, ownerKeys(owner))), undefined, "qorechain-mainnet");
    expect(await receiveMandate(text, deps())).toMatchObject({ ok: false, code: "SEAL_OPEN_FAILED" });
  });

  it("refuses a mandate sealed to another agent", async () => {
    const m = sampleMandate(owner, otherAgent);
    const res = await receiveMandate(sealed(m, otherAgent), deps());
    expect(res).toMatchObject({ ok: false, code: "SEAL_OPEN_FAILED" });
  });

  it("refuses another agent's mandate forwarded to this agent", async () => {
    const m = sampleMandate(owner, otherAgent);
    const res = await receiveMandate(sealRaw(encodeSignedMandate(signMandate(m, ownerKeys(owner)))), deps());
    expect(res).toMatchObject({ ok: false, code: "WRONG_AGENT" });
  });

  it("refuses an envelope whose additional data names another owner", async () => {
    const m = sampleMandate(owner, agent);
    const text = sealRaw(encodeSignedMandate(signMandate(m, ownerKeys(owner))), mandateSealAad(attacker.address, agent.address));
    expect(await receiveMandate(text, deps())).toMatchObject({ ok: false, code: "SEAL_OPEN_FAILED" });
  });

  it("refuses a validly signed mandate from an owner the agent does not serve", async () => {
    const m = sampleMandate(attacker, agent);
    const signed = signMandate(m, ownerKeys(attacker));
    const keys = new StaticPqKeySource().set(attacker.address, attacker.pqKey.publicKey);
    const res = await receiveMandate(sealRaw(encodeSignedMandate(signed)), deps({ keys }));
    expect(res).toMatchObject({ ok: false, code: "WRONG_OWNER" });
  });

  it("refuses a classical-only signature", async () => {
    const m = sampleMandate(owner, agent);
    const classical = signText(encodeMandate(m), owner, { pq: false });
    const res = await receiveMandate(sealRaw(encodeSignedMandate(classical)), deps());
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_NOT_PQ" });
  });

  it("refuses when the owner has no ML-DSA key on chain", async () => {
    const m = sampleMandate(owner, agent);
    const res = await receiveMandate(sealed(m), deps({ keys: new StaticPqKeySource() }));
    expect(res).toMatchObject({ ok: false, code: "OWNER_KEY_UNAVAILABLE" });
  });

  it("refuses when the key cannot be read (fails closed on an RPC error)", async () => {
    const m = sampleMandate(owner, agent);
    const broken = { pqPublicKey: async () => Promise.reject(new Error("connection refused")) };
    const res = await receiveMandate(sealed(m), deps({ keys: broken }));
    expect(res).toMatchObject({ ok: false, code: "OWNER_KEY_UNAVAILABLE" });
  });

  it("refuses non-canonical text even when it is correctly signed", async () => {
    const m = sampleMandate(owner, agent);
    const pretty = JSON.stringify(JSON.parse(encodeMandate(m)), null, 2);
    const res = await receiveMandate(sealRaw(encodeSignedMandate(signText(pretty, owner))), deps());
    expect(res).toMatchObject({ ok: false, code: "NOT_CANONICAL" });
  });

  it("refuses duplicate keys, which JSON.parse would silently collapse", async () => {
    const m = sampleMandate(owner, agent);
    const text = encodeMandate(m).replace('"budget":"500000000"', '"budget":"1","budget":"500000000"');
    const res = await receiveMandate(sealRaw(encodeSignedMandate(signText(text, owner))), deps());
    expect(res).toMatchObject({ ok: false, code: "NOT_CANONICAL" });
  });

  it("refuses a correctly signed mandate whose limits are inconsistent", async () => {
    const m = sampleMandate(owner, agent);
    const text = canonicalize({ ...m, maxPerBid: "600000000" });
    const res = await receiveMandate(sealRaw(encodeSignedMandate(signText(text, owner))), deps());
    expect(res).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
  });

  it("refuses a correctly signed mandate with an extra field", async () => {
    const m = sampleMandate(owner, agent);
    const text = canonicalize({ ...m, ignoreLimits: true });
    const res = await receiveMandate(sealRaw(encodeSignedMandate(signText(text, owner))), deps());
    expect(res).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
  });

  it("refuses a mandate that pins another receipt key", async () => {
    const m = sampleMandate(owner, agent, { receiptKey: receiptKeyHash(otherAgent.receiptKey.publicKey) });
    const res = await receiveMandate(sealed(m), deps());
    expect(res).toMatchObject({ ok: false, code: "RECEIPT_KEY_MISMATCH" });
  });

  it("refuses text that is not an envelope", async () => {
    expect(await receiveMandate("hello", deps())).toMatchObject({ ok: false, code: "ENVELOPE_MALFORMED" });
    expect(await receiveMandate("qoreseal:!!!", deps())).toMatchObject({ ok: false, code: "ENVELOPE_MALFORMED" });
  });

  it("refuses an envelope that holds something other than a signed mandate", async () => {
    expect(await receiveMandate(sealRaw(utf8ToBytes("not json")), deps())).toMatchObject({ ok: false, code: "PAYLOAD_MALFORMED" });
    expect(await receiveMandate(sealRaw(utf8ToBytes('{"v":1}')), deps())).toMatchObject({ ok: false, code: "PAYLOAD_MALFORMED" });
    expect(await receiveMandate(sealRaw(new Uint8Array([0xff, 0xfe])), deps())).toMatchObject({ ok: false, code: "PAYLOAD_MALFORMED" });
  });
});
