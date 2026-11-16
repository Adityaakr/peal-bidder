/**
 * The owner's brake: pause and resume by Sign In With QoreChain (agent/control.ts,
 * owner-cli/control.ts), against the owner's ML-DSA-87 key as the chain would
 * report it.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ControlError, OwnerControl, controlServer, readControlState, type ControlAction } from "../agent/control.ts";
import { StaticPqKeySource, PqKeyError, type PqKeySource } from "../agent/keysource.ts";
import { MemorySink, ReceiptLog, verifyReceipts } from "../agent/receipts.ts";
import { controlRequest, sendControl } from "../owner-cli/control.ts";
import { newAccount, newAgent, NOW } from "./helpers.ts";

const CHAIN = "qorechain-diana";
const URL0 = "http://127.0.0.1:8789";
const owner = newAccount();
const agent = newAgent();
const keys = new StaticPqKeySource().set(owner.address, owner.pqKey.publicKey);

function makeControl(over: { keys?: PqKeySource; statePath?: string; now?: () => number } = {}) {
  const sink = new MemorySink();
  const receipts = new ReceiptLog(sink, agent.receiptKey, agent.address, () => NOW);
  const control = new OwnerControl({
    owner: owner.address,
    agent: agent.address,
    chainId: CHAIN,
    domain: "127.0.0.1:8789",
    keys: over.keys ?? keys,
    receipts,
    now: over.now ?? (() => NOW),
    ...(over.statePath ? { statePath: over.statePath } : {}),
  });
  return { control, sink };
}

function request(control: OwnerControl, action: ControlAction, over: { signer?: typeof owner; agent?: string; url?: string; chainId?: string; now?: Date; nonce?: string } = {}) {
  return controlRequest({
    owner: over.signer ?? owner,
    agent: over.agent ?? agent.address,
    action,
    url: over.url ?? URL0,
    chainId: over.chainId ?? CHAIN,
    nonce: over.nonce ?? control.issueNonce(),
    now: over.now ?? new Date(NOW * 1000),
  });
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ControlError) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("pause and resume by Sign In With QoreChain", () => {
  it("the owner pauses and resumes; each change is a signed receipt", async () => {
    const { control, sink } = makeControl();
    expect(control.paused).toBe(false);
    const p = request(control, "pause");
    expect(p.message).toContain("Pause my Peal Bidder agent.");
    expect(p.signature.signatureType).toBe("ml-dsa-87-hybrid");
    expect(await control.apply(p.message, p.signature)).toMatchObject({ action: "pause", paused: true, since: NOW });
    expect(control.paused).toBe(true);
    const r = request(control, "resume");
    expect(await control.apply(r.message, r.signature)).toMatchObject({ action: "resume", paused: false });
    const check = verifyReceipts(sink.read(), agent.receiptKey.publicKey);
    expect(check.ok && check.receipts.map((x) => [x.body.kind, (x.body.data as { action: string }).action])).toEqual([
      ["control", "pause"],
      ["control", "resume"],
    ]);
  });

  it("refuses a replayed message: each nonce is single use", async () => {
    const { control } = makeControl();
    const p = request(control, "pause");
    await control.apply(p.message, p.signature);
    expect(await refusal(control.apply(p.message, p.signature))).toBe("NONCE_UNKNOWN");
  });

  it("refuses a nonce the agent never issued, and one that expired", async () => {
    let t = NOW;
    const { control } = makeControl({ now: () => t });
    const forged = request(control, "pause", { nonce: "abcdefgh12345678abcdefgh" });
    expect(await refusal(control.apply(forged.message, forged.signature))).toBe("NONCE_UNKNOWN");
    const late = request(control, "pause");
    t = NOW + 601;
    expect(await refusal(control.apply(late.message, late.signature))).toBe("NONCE_UNKNOWN");
  });

  it("refuses anyone but the owner, even with valid keys of their own", async () => {
    const { control } = makeControl();
    const mallory = newAccount();
    const m = request(control, "pause", { signer: mallory });
    expect(await refusal(control.apply(m.message, m.signature))).toBe("NOT_OWNER");
  });

  it("refuses the owner's stolen classical key paired with the thief's own ML-DSA-87 key", async () => {
    const { control } = makeControl();
    const thief = newAccount();
    const m = request(control, "pause", { signer: { ...owner, pqKey: thief.pqKey } });
    expect(m.signature.signatureType).toBe("ml-dsa-87-hybrid");
    expect(await refusal(control.apply(m.message, m.signature))).toBe("SIGN_IN_INVALID");
  });

  it("refuses a classical-only sign-in: a stolen secp256k1 key cannot pull the brake", async () => {
    const { control } = makeControl();
    const p = request(control, "pause");
    const { pq: _pq, ...classicalOnly } = p.signature;
    expect(await refusal(control.apply(p.message, { ...classicalOnly, signatureType: "secp256k1" }))).toBe("SIGN_IN_INVALID");
  });

  it("refuses an ML-DSA-87 signature by a key other than the one on chain", async () => {
    const other = newAccount();
    const { control } = makeControl({ keys: new StaticPqKeySource().set(owner.address, other.pqKey.publicKey) });
    const p = request(control, "pause");
    expect(await refusal(control.apply(p.message, p.signature))).toBe("SIGN_IN_INVALID");
  });

  it("fails closed when the owner's key cannot be read", async () => {
    const down: PqKeySource = { pqPublicKey: async () => Promise.reject(new PqKeyError("KEY_UNAVAILABLE", "rpc down")) };
    const { control } = makeControl({ keys: down });
    const p = request(control, "pause");
    expect(await refusal(control.apply(p.message, p.signature))).toBe("OWNER_KEY_UNAVAILABLE");
    expect(control.paused).toBe(false);
  });

  it("refuses a message for another domain, another chain, another agent, or an old one", async () => {
    const { control } = makeControl();
    const d = request(control, "pause", { url: "http://127.0.0.1:9999" });
    expect(await refusal(control.apply(d.message, d.signature))).toBe("SIGN_IN_INVALID");
    const c = request(control, "pause", { chainId: "qorechain-vladi" });
    expect(await refusal(control.apply(c.message, c.signature))).toBe("SIGN_IN_INVALID");
    const a = request(control, "pause", { agent: newAgent().address });
    expect(await refusal(control.apply(a.message, a.signature))).toBe("WRONG_AGENT");
    const old = request(control, "pause", { now: new Date((NOW - 3600) * 1000) });
    expect(await refusal(control.apply(old.message, old.signature))).toBe("SIGN_IN_INVALID");
  });

  it("refuses an edited message: the signature covers the action", async () => {
    const { control } = makeControl();
    const p = request(control, "resume");
    const edited = p.message.replace("urn:peal-bidder:control:resume", "urn:peal-bidder:control:pause");
    expect(await refusal(control.apply(edited, p.signature))).toBe("SIGN_IN_INVALID");
  });

  it("keeps the state across restarts in a 0600 file, and reads an unreadable file as paused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bidder-control-"));
    const statePath = join(dir, "control.json");
    const { control } = makeControl({ statePath });
    const p = request(control, "pause");
    await control.apply(p.message, p.signature);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(makeControl({ statePath }).control.paused).toBe(true);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ paused: true, since: NOW });
    writeFileSync(statePath, "not json");
    expect(readControlState(statePath).paused).toBe(true);
    expect(readControlState(join(dir, "absent.json")).paused).toBe(false);
  });
});

describe("the control endpoint and the owner's command", () => {
  it("pauses and resumes over HTTP on 127.0.0.1, and refuses a forged request with 403", async () => {
    const t = Math.floor(Date.now() / 1000);
    // The agent's domain is its own host and port: find a free port first.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const control = new OwnerControl({ owner: owner.address, agent: agent.address, chainId: CHAIN, domain: `127.0.0.1:${port}`, keys, now: () => t });
    const server = controlServer(control);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${port}`;
    try {
      expect(await sendControl({ owner, agent: agent.address, action: "pause", url, chainId: CHAIN })).toMatchObject({ paused: true, action: "pause" });
      expect(await (await fetch(`${url}/siwq/status`)).json()).toMatchObject({ paused: true });
      await expect(sendControl({ owner: newAccount(), agent: agent.address, action: "resume", url, chainId: CHAIN })).rejects.toThrow(/NOT_OWNER/);
      expect(await sendControl({ owner, agent: agent.address, action: "resume", url, chainId: CHAIN })).toMatchObject({ paused: false });
      const junk = await fetch(`${url}/siwq/control`, { method: "POST", body: "{" });
      expect(junk.status).toBe(403);
    } finally {
      server.close();
    }
  });
});
