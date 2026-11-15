import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { BidderAgent, DryRunExecutor, type AuctionReader, type BidExecutor } from "../agent/agent.ts";
import type { AuctionView } from "../agent/auction.ts";
import { StaticPqKeySource } from "../agent/keysource.ts";
import { ClaudePlanner, RulePlanner, type Planner } from "../agent/planner/index.ts";
import { MemorySink, ReceiptLog, receiptKeyHash, verifyReceipts } from "../agent/receipts.ts";
import { MemoryMandateStore } from "../agent/store.ts";
import { TESTNET_CHAIN_ID, TESTNET_EVM_CHAIN_ID } from "../common/network.ts";
import { sealMandate, signMandate } from "../owner-cli/mandate.ts";
import { NOW, newAccount, newAgent, sampleMandate } from "./helpers.ts";
import { auction } from "./auctions.ts";

const owner = newAccount();
const agentKeys = newAgent();
const ownerKeys = { address: owner.address, classicalKey: owner.classicalKey, pqKey: owner.pqKey };

function reader(views: AuctionView[]): AuctionReader {
  return { read: async (addresses) => views.filter((v) => addresses.includes(v.address)) };
}

function setup(opts: { sink?: MemorySink; planners?: Planner[]; executor?: BidExecutor; views?: AuctionView[] } = {}) {
  const sink = opts.sink ?? new MemorySink();
  const receipts = new ReceiptLog(sink, agentKeys.receiptKey, agentKeys.address, () => NOW);
  const check = verifyReceipts(sink.read(), agentKeys.receiptKey.publicKey);
  if (!check.ok) throw new Error(check.error);
  const executor = opts.executor ?? new DryRunExecutor();
  const agent = new BidderAgent({
    inbox: {
      network: { chainId: TESTNET_CHAIN_ID, evmChainId: TESTNET_EVM_CHAIN_ID },
      identity: {
        address: agentKeys.address,
        owner: owner.address,
        sealKeys: agentKeys.sealKeys,
        receiptKeyHash: receiptKeyHash(agentKeys.receiptKey.publicKey),
      },
      keys: new StaticPqKeySource().set(owner.address, owner.pqKey.publicKey),
      store: new MemoryMandateStore(() => NOW),
      now: () => NOW,
    },
    receipts,
    history: check.receipts,
    planners: opts.planners ?? [new RulePlanner()],
    reader: reader(opts.views ?? [auction()]),
    executor,
  });
  return { agent, sink, executor };
}

function envelope(nonce = 1, maxBids = 5) {
  const m = sampleMandate(owner, agentKeys, { nonce, maxBids });
  return sealMandate({ signed: signMandate(m, ownerKeys), mandate: m, recipient: agentKeys.recipient }).envelope;
}

const landed: BidExecutor = { submit: async () => ({ status: "landed", txHash: "0xabc" }) };

describe("BidderAgent", () => {
  it("receives a mandate, plans, clamps, submits and writes a receipt for each", async () => {
    const { agent, sink, executor } = setup();
    expect((await agent.receive(envelope())).ok).toBe(true);
    const step = await agent.step();
    expect(step.kind).toBe("decided");
    expect((executor as DryRunExecutor).submitted).toHaveLength(1);
    const check = verifyReceipts(sink.read(), agentKeys.receiptKey.publicKey);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.receipts.map((r) => r.body.kind)).toEqual(["mandate-accepted", "decision", "result"]);
  });

  it("idles without a mandate and logs a refused mandate", async () => {
    const { agent, sink } = setup();
    expect(await agent.step()).toEqual({ kind: "idle", why: "no mandate" });
    const res = await agent.receive("qoreseal:AAAA");
    expect(res.ok).toBe(false);
    expect(await agent.step()).toEqual({ kind: "idle", why: "no mandate" });
    expect(JSON.parse(sink.read()[0] as string).body.kind).toBe("mandate-refused");
  });

  it("stops at the mandate's bid count when every bid lands", async () => {
    const { agent } = setup({ executor: landed });
    await agent.receive(envelope(1, 3));
    const kinds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await agent.step();
      kinds.push(s.kind === "idle" ? `idle: ${s.why}` : s.plan.decision.kind === "skip" ? s.plan.decision.reason : "bid");
    }
    // Once the count is used up the planner is not even asked (no model call is paid for).
    expect(kinds).toEqual(["bid", "bid", "bid", "idle: the mandate's bid count is used up", "idle: the mandate's bid count is used up"]);
    expect(agent.state.ledger.committed).toBeLessThanOrEqual(300_000_000n);
  });

  it("rebuilds the mandate and the ledger from the receipts after a restart", async () => {
    const first = setup({ executor: landed });
    await first.agent.receive(envelope());
    await first.agent.step();
    await first.agent.step();
    const before = first.agent.state;
    const second = setup({ sink: first.sink, executor: landed });
    expect(second.agent.state).toEqual(before);
    expect(second.agent.state.ledger.bids).toBe(2);
  });

  it("counts a submission with an unknown outcome as spent", async () => {
    const failing: BidExecutor = { submit: async () => Promise.reject(new Error("timeout after broadcast")) };
    const { agent } = setup({ executor: failing });
    await agent.receive(envelope());
    const s = await agent.step();
    expect(s).toMatchObject({ kind: "decided", submit: { status: "unknown" } });
    expect(agent.state.ledger.bids).toBe(1);
  });

  it("does not count a refused submission", async () => {
    const refused: BidExecutor = { submit: async () => ({ status: "refused", reason: "success=false: over the per-tx limit" }) };
    const { agent } = setup({ executor: refused });
    await agent.receive(envelope());
    await agent.step();
    expect(agent.state.ledger.bids).toBe(0);
  });

  it("a newer mandate replaces the active one and starts a fresh ledger", async () => {
    const { agent } = setup({ executor: landed });
    await agent.receive(envelope(1));
    await agent.step();
    expect(agent.state.ledger.bids).toBe(1);
    expect((await agent.receive(envelope(2))).ok).toBe(true);
    expect(agent.state.mandate?.nonce).toBe(2);
    expect(agent.state.ledger.bids).toBe(0);
  });

  it("clamps an injected instruction end to end", async () => {
    const dir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "claude");
    const f = JSON.parse(readFileSync(join(dir, "injection-obeyed-limits.json"), "utf8")) as {
      auction_details: string;
      response: Anthropic.Beta.Messages.BetaMessage;
    };
    const claude = new ClaudePlanner({ beta: { messages: { create: async () => f.response } } });
    const { agent, executor } = setup({ planners: [claude, new RulePlanner()], views: [auction({ details: f.auction_details })] });
    await agent.receive(envelope());
    await agent.step();
    const sent = (executor as DryRunExecutor).submitted[0];
    expect(sent).toBeDefined();
    expect(sent?.tick).toBe(40);
    expect(sent?.outflow).toBeLessThanOrEqual(100_000_000n);
  });
});
