import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { BidderAgent, DryRunExecutor } from "../agent/agent.ts";
import { LockHeld, acquireLock } from "../agent/lock.ts";
import { StaticPqKeySource } from "../agent/keysource.ts";
import { RulePlanner } from "../agent/planner/index.ts";
import { MemorySink, ReceiptLog, receiptKeyHash, verifyReceipts } from "../agent/receipts.ts";
import { FileSink } from "../agent/receipt-file.ts";
import { drainInbox, serve, tick } from "../agent/serve.ts";
import type { CallSender } from "../agent/smart-account-executor.ts";
import { MemoryMandateStore } from "../agent/store.ts";
import { TESTNET_CHAIN_ID, TESTNET_EVM_CHAIN_ID } from "../common/network.ts";
import { sealMandate, signMandate } from "../owner-cli/mandate.ts";
import { auction } from "./auctions.ts";
import { AUCTION_A, NOW, newAccount, newAgent, sampleMandate } from "./helpers.ts";

const owner = newAccount();
const agentKeys = newAgent();

function dir() {
  return mkdtempSync(join(tmpdir(), "peal-bidder-serve-"));
}

function setup(sinkPath: string, views = [auction()]) {
  const receipts = new ReceiptLog(new FileSink(sinkPath), agentKeys.receiptKey, agentKeys.address, () => NOW);
  const agent = new BidderAgent({
    inbox: {
      network: { chainId: TESTNET_CHAIN_ID, evmChainId: TESTNET_EVM_CHAIN_ID },
      identity: { address: agentKeys.address, owner: owner.address, sealKeys: agentKeys.sealKeys, receiptKeyHash: receiptKeyHash(agentKeys.receiptKey.publicKey) },
      keys: new StaticPqKeySource().set(owner.address, owner.pqKey.publicKey),
      store: new MemoryMandateStore(() => NOW),
      now: () => NOW,
    },
    receipts,
    history: [],
    planners: [new RulePlanner()],
    reader: { read: async (a) => views.filter((v) => a.includes(v.address)) },
    executor: new DryRunExecutor(),
    countDryRuns: true,
  });
  return { agent };
}

function envelope(nonce: number) {
  const m = sampleMandate(owner, agentKeys, { nonce, maxBids: 2 });
  return sealMandate({ signed: signMandate(m, { address: owner.address, classicalKey: owner.classicalKey, pqKey: owner.pqKey }, new Date((NOW - 30) * 1000)), mandate: m, recipient: agentKeys.recipient }).envelope;
}

describe("single-instance lock", () => {
  it("lets one process hold the lock and refuses a second", () => {
    const path = join(dir(), "agent.lock");
    const release = acquireLock(path);
    expect(() => acquireLock(path)).toThrow(LockHeld);
    release();
    expect(existsSync(path)).toBe(false);
    acquireLock(path)();
  });

  it("takes over a lock left by a process that is gone", () => {
    const path = join(dir(), "agent.lock");
    writeFileSync(path, "999999999\n2026-11-16T00:00:00Z\n");
    const release = acquireLock(path);
    expect(readFileSync(path, "utf8").split("\n")[0]).toBe(String(process.pid));
    release();
  });
});

describe("one receipts chain across logs", () => {
  it("two logs on one file extend one chain", () => {
    const d = dir();
    const path = join(d, "receipts.jsonl");
    const a = new ReceiptLog(new FileSink(path), agentKeys.receiptKey, agentKeys.address);
    const b = new ReceiptLog(new FileSink(path), agentKeys.receiptKey, agentKeys.address);
    a.append("decision", null, { n: 1 });
    b.append("claim", null, { n: 2 });
    a.append("decision", null, { n: 3 });
    expect(verifyReceipts(new FileSink(path).read(), agentKeys.receiptKey.publicKey)).toMatchObject({ ok: true, count: 3 });
  });

  it("refuses to continue a log that was truncated or written by someone else", () => {
    const sink = new MemorySink();
    const log = new ReceiptLog(sink, agentKeys.receiptKey, agentKeys.address);
    log.append("decision", null, { n: 1 });
    log.append("decision", null, { n: 2 });
    sink.lines.pop();
    expect(() => log.append("decision", null, { n: 3 })).toThrow(/truncated/);
    const other = newAgent();
    const sink2 = new MemorySink();
    const log2 = new ReceiptLog(sink2, agentKeys.receiptKey, agentKeys.address);
    new ReceiptLog(sink2, other.receiptKey, other.address).append("decision", null, {}); // a foreign line
    expect(() => log2.append("decision", null, {})).toThrow(/does not verify/);
  });
});

describe("serve", () => {
  it("each tick reads the inbox, plans once and logs one line; stops when the limits are used up", async () => {
    const d = dir();
    const inbox = join(d, "inbox");
    mkdirSync(inbox);
    writeFileSync(join(inbox, "1.qoreseal"), envelope(1));
    writeFileSync(join(inbox, "0-junk.qoreseal"), "qoreseal:AAAA");
    const { agent } = setup(join(d, "receipts.jsonl"));
    const lines: Record<string, unknown>[] = [];
    const n = await serve({ agent, inbox, log: (l) => lines.push(l) }, { intervalSeconds: 0, maxTicks: 4 });
    expect(n).toBe(4);
    expect(readdirSync(join(inbox, "done")).sort()).toEqual(["0-junk.qoreseal", "1.qoreseal"]);
    expect(lines[0]?.inbox).toEqual([
      expect.objectContaining({ file: "0-junk.qoreseal", refused: "SEAL_OPEN_FAILED" }),
      expect.objectContaining({ file: "1.qoreseal", accepted: expect.any(String) }),
    ]);
    const steps = lines.map((l) => l.step as Record<string, unknown>);
    expect(steps.slice(0, 2).every((s) => (s.decision as Record<string, unknown>)?.bid === AUCTION_A)).toBe(true);
    expect(steps.slice(2)).toEqual([{ idle: "the mandate's bid count is used up" }, { idle: "the mandate's bid count is used up" }]);
    // Nothing secret in the log lines.
    expect(JSON.stringify(lines)).not.toMatch(/secretKey|privateKey|mnemonic/i);
  });

  it("does not ask the planner when no auction is taking bids", async () => {
    const d = dir();
    const { agent } = setup(join(d, "receipts.jsonl"), [auction({ commitOpen: false })]);
    await drainInbox(agent, d); // nothing there
    expect((await agent.receive(envelope(1))).ok).toBe(true);
    const t = await tick({ agent, inbox: join(d, "none") });
    expect(t.step).toEqual({ kind: "idle", why: "no auction of the mandate is taking bids" });
  });

  it("claims finished auctions through the executor, recording on the same chain", async () => {
    const d = dir();
    const path = join(d, "receipts.jsonl");
    const { agent } = setup(path);
    expect((await agent.receive(envelope(1))).ok).toBe(true);
    const sent: string[] = [];
    const sender: CallSender = { sendCall: async (c) => (sent.push(c.data), { status: "landed", txHash: "0x1" }) };
    const client = {
      readContract: async (a: { functionName: string }) =>
        a.functionName === "state" ? 4 : a.functionName === "clearingPrice" ? 1n : a.functionName === "allocationOf" ? 5n : a.functionName === "bidCountOf" || a.functionName === "bidCount" ? 1 : { bidder: owner.hex, seq: 0, status: 1, exclusion: 0, shareMask: 3, bondBurned: false, claimed: false, quantity: 1n, tick: 1, escrow: 1n, ct: "0x", keyHash: "0x" },
      getContractEvents: async () => [{ args: { bidId: 0n, bidder: owner.hex } }],
      getBlockNumber: async () => 100n,
    };
    const t = await tick({
      agent,
      inbox: join(d, "none"),
      claims: { client: client as never, bidder: owner.hex as Address, sender, receipts: new ReceiptLog(new FileSink(path), agentKeys.receiptKey, agentKeys.address, () => NOW) },
    });
    expect(t.claims).toEqual([{ auction: AUCTION_A, state: "Settled", claimed: 1 }]);
    expect(sent).toHaveLength(1);
    const check = verifyReceipts(new FileSink(path).read(), agentKeys.receiptKey.publicKey);
    expect(check.ok && check.receipts.map((r) => r.body.kind)).toEqual(["mandate-accepted", "decision", "submission", "result", "claim"]);
  });

  it("stops on the signal", async () => {
    const d = dir();
    const { agent } = setup(join(d, "receipts.jsonl"));
    const stop = new AbortController();
    const p = serve({ agent, inbox: join(d, "none"), log: () => stop.abort() }, { intervalSeconds: 3600, signal: stop.signal });
    expect(await p).toBe(1);
  });
});
