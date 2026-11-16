/**
 * `pnpm agent audit`: the receipts checked against the chain through the
 * QoreChain MCP server.
 *
 * The first group runs the real MCP server in this process against the chain's
 * own answers, recorded from the testnet (`pnpm record:mcp-audit`), for two
 * receipts of the published live log: a landed bid and one the chain's daily
 * limit refused. The second group drives the audit's rules with a stand-in.
 */
import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { auditReceipts, transactionsIn } from "../agent/audit.ts";
import { ChainToolError, connectQoreChainMcp, type ChainTools } from "../agent/qorechain-mcp.ts";
import { verifyReceipts, type Receipt } from "../agent/receipts.ts";

const RELAYER = "qor16tsewlj6jpt4v2esmrhuk7z2xems6e09z5rpzc";
const AGENT_ACCOUNT = "qor1k7at260yd632szpqt8fguukwuf3l52fpfz8lur";

const live = new URL("../apps/web/public/live/", import.meta.url);
const meta = JSON.parse(readFileSync(new URL("agent.json", live), "utf8")) as { owner: string; receiptPublicKey: string };
const check = verifyReceipts(
  readFileSync(new URL("receipts.jsonl", live), "utf8")
    .split("\n")
    .filter((l) => l.length > 0),
  hexToBytes(meta.receiptPublicKey),
);
if (!check.ok) throw new Error("the published log does not verify");
const published = check.receipts;
const landed = published.find((r) => r.body.seq === 3) as Receipt;
const refused = published.find((r) => r.body.seq === 16) as Receipt;

const fixture = JSON.parse(readFileSync(new URL("fixtures/mcp-audit/published.json", import.meta.url), "utf8")) as {
  responses: { key: string; status: number; body: string }[];
};

/** The chain as recorded: the same request gets the same answer; anything else fails as the network would. */
function replayFetch() {
  const byKey = new Map(fixture.responses.map((r) => [r.key, r]));
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const hit = byKey.get(`${init?.method ?? "GET"} ${input} ${typeof init?.body === "string" ? init.body : ""}`);
    if (!hit) throw new TypeError(`fetch failed: not recorded: ${input}`);
    return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json" } });
  };
}

function withData(r: Receipt, data: Record<string, unknown>): Receipt {
  return { ...r, body: { ...r.body, data: { ...(r.body.data as Record<string, unknown>), ...data } as never } };
}

describe("the audit, through the real QoreChain MCP server, on recorded chain answers", () => {
  it("agrees with the published receipts: a landed bid and a refused one, each hybrid-signed and verified", async () => {
    const chain = await connectQoreChainMcp({ upstream: { fetch: replayFetch() } });
    try {
      const report = await auditReceipts([landed, refused], meta.owner, chain, { signers: [RELAYER, AGENT_ACCOUNT] });
      expect(report.ok).toBe(true);
      expect(report.owner).toMatchObject({ registered: true, algorithm: "ML-DSA-87", possessionProven: true, ok: true });
      const [a, b] = report.transactions;
      expect(a).toMatchObject({ seq: 3, recorded: "landed", chain: "success", tier: "pqc", hybridVerified: true, signer: RELAYER, verdict: "ok" });
      expect(b).toMatchObject({ seq: 16, recorded: "refused", chain: "refused", tier: "pqc", hybridVerified: true, verdict: "ok" });
      expect(b?.chainReason).toMatch(/daily limit .* exceeded/);
    } finally {
      await chain.close();
    }
  });

  it("catches a receipt that misstates the outcome, resolves an unknown one, and flags a foreign signer", async () => {
    const chain = await connectQoreChainMcp({ upstream: { fetch: replayFetch() } });
    try {
      const report = await auditReceipts(
        [withData(refused, { status: "landed" }), withData(landed, { status: "unknown" })],
        meta.owner,
        chain,
      );
      expect(report.ok).toBe(false);
      expect(report.transactions[0]).toMatchObject({ verdict: "mismatch" });
      expect(report.transactions[0]?.note).toMatch(/the receipt says landed, the chain says refused/);
      expect(report.transactions[1]).toMatchObject({ verdict: "resolved", chain: "success", hybridVerified: true });
      expect(report.transactions[1]?.note).toMatch(/landed: count it as spent/);

      const foreign = await auditReceipts([landed], meta.owner, chain, { signers: [AGENT_ACCOUNT] });
      expect(foreign.ok).toBe(false);
      expect(foreign.transactions[0]).toMatchObject({ verdict: "foreign-signer", signer: RELAYER });
    } finally {
      await chain.close();
    }
  });

  it("reports the chain as unreachable rather than passing", async () => {
    const chain = await connectQoreChainMcp({ upstream: { fetch: async () => Promise.reject(new TypeError("fetch failed")) } });
    try {
      const report = await auditReceipts([landed], meta.owner, chain);
      expect(report.ok).toBe(false);
      expect(report.owner.ok).toBe(false);
      expect(report.transactions[0]).toMatchObject({ verdict: "error", chain: "error" });
    } finally {
      await chain.close();
    }
  });
});

/** A stand-in chain: answers per (tool, target), or a NOT_FOUND. */
function fakeChain(answers: Record<string, Record<string, unknown> | "NOT_FOUND">): ChainTools {
  return {
    async call(tool, args) {
      const key = `${tool} ${String(args.hash ?? args.target)}`;
      const a = answers[key];
      if (a === undefined || a === "NOT_FOUND") throw new ChainToolError(tool, "NOT_FOUND", "no such thing");
      return a;
    },
    async close() {},
  };
}

const OWNER = "qor1owner";
const ownerOk = { address_status: { registered: true, algorithm: "ML-DSA-87", algorithm_id: 1, possession_proven: true } };
const verified = { transaction_status: { has_exactly_one_pqc_layer: true, verification: { checked: true, verified: true } } };

function receipt(seq: number, kind: "result" | "claim", data: Record<string, unknown>): Receipt {
  return { body: { v: 1, seq, prev: "", at: 0, agent: AGENT_ACCOUNT, kind, mandateHash: null, data: data as never }, sig: "" };
}

describe("the audit's rules", () => {
  it("lists only results and claims that name a transaction", () => {
    const rs = [
      receipt(0, "result", { status: "landed", txHash: "AA" }),
      receipt(1, "result", { status: "dry-run", txHash: null }),
      receipt(2, "result", { status: "refused", txHash: null, reason: "not sent" }),
      receipt(3, "claim", { status: "unknown", txHash: "BB" }),
    ];
    expect(transactionsIn(rs).map((t) => [t.seq, t.recorded])).toEqual([
      [0, "landed"],
      [3, "unknown"],
    ]);
  });

  it("a landed receipt for a transaction the chain does not have is a mismatch; an unknown one did not land", async () => {
    const chain = fakeChain({ [`get_pq_status ${OWNER}`]: ownerOk, "get_transaction AA": "NOT_FOUND", "get_transaction BB": "NOT_FOUND" });
    const r = await auditReceipts([receipt(0, "result", { status: "landed", txHash: "AA" }), receipt(1, "result", { status: "unknown", txHash: "BB" })], OWNER, chain);
    expect(r.transactions.map((t) => t.verdict)).toEqual(["mismatch", "resolved"]);
    expect(r.transactions[1]?.note).toMatch(/did not land/);
    expect(r.ok).toBe(false);
  });

  it("a native transaction without a verifying ML-DSA-87 layer is unshielded", async () => {
    const chain = fakeChain({
      [`get_pq_status ${OWNER}`]: ownerOk,
      "get_transaction AA": { success: true, height: "1", signers: [{ address: RELAYER }], security: { tier: "classical" } },
      "get_pq_status AA": { transaction_status: { has_exactly_one_pqc_layer: false, verification: { checked: false, verified: false, reason: "no hybrid layer" } } },
    });
    const r = await auditReceipts([receipt(0, "result", { status: "landed", txHash: "AA" })], OWNER, chain);
    expect(r.transactions[0]).toMatchObject({ verdict: "unshielded", hybridVerified: false });
    expect(r.ok).toBe(false);
  });

  it("an EVM transaction from the window path is classical by design, and passes", async () => {
    const chain = fakeChain({
      [`get_pq_status ${OWNER}`]: ownerOk,
      "get_transaction 0xabc": { success: true, height: "1", signers: [{ address: AGENT_ACCOUNT }], security: { tier: "classical" } },
    });
    const r = await auditReceipts([receipt(0, "result", { status: "landed", txHash: "0xabc" })], OWNER, chain, { signers: [AGENT_ACCOUNT] });
    expect(r.ok).toBe(true);
    expect(r.transactions[0]?.note).toMatch(/inside the owner's window, classical by design/);
  });

  it("an owner without a key, or without proof of possession, fails the audit", async () => {
    const tx = { "get_transaction AA": { success: true, signers: [{ address: RELAYER }], security: { tier: "pqc" } }, "get_pq_status AA": verified };
    const noKey = await auditReceipts([], OWNER, fakeChain({ [`get_pq_status ${OWNER}`]: { address_status: { registered: false } }, ...tx }));
    expect(noKey).toMatchObject({ ok: false, owner: { registered: false } });
    expect(noKey.owner.note).toMatch(/refuses every mandate/);
    const noPop = await auditReceipts([], OWNER, fakeChain({ [`get_pq_status ${OWNER}`]: { address_status: { registered: true, algorithm_id: 1, possession_proven: false } } }));
    expect(noPop.owner).toMatchObject({ ok: false, possessionProven: false });
  });
});
