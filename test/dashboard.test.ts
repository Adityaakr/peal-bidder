import { describe, expect, it } from "vitest";
import { MemorySink, ReceiptLog, receiptKeyHash, verifyReceipts } from "../agent/receipts.ts";
import { encodeMandate } from "../common/mandate.ts";
import { escapeHtml, renderDashboard, txUrlFor } from "../dashboard/render.ts";
import { NOW, newAccount, newAgent, sampleMandate } from "./helpers.ts";

const owner = newAccount();
const agent = newAgent();

function log() {
  const sink = new MemorySink();
  const r = new ReceiptLog(sink, agent.receiptKey, agent.address, () => NOW);
  const m = sampleMandate(owner, agent, { instructions: "Buy <b>fair</b> & never chase" });
  const text = encodeMandate(m);
  r.append("mandate-refused", null, { code: "SIGNATURE_INVALID", message: "<script>alert(1)</script>" });
  r.append("mandate-accepted", "aa".repeat(32), { text, nonce: 1 });
  r.append("decision", "aa".repeat(32), {
    source: "claude",
    model: "claude-opus-5-5",
    usage: null,
    attempts: [],
    raw: '{"rationale":"<img src=x onerror=alert(1)>"}',
    decision: { kind: "bid", auction: m.auctions[0] as string, qty: "1", tick: 40, escrow: "100", bond: "1000000", outflow: "1000100", adjustments: ["TICK_LOWERED"] },
    ledgerBefore: { bids: 0, committed: "0" },
  });
  r.append("result", "aa".repeat(32), {
    status: "refused",
    txHash: "ABCDEF0123456789ABCDEF",
    reason: "spending limit exceeded",
    counted: false,
    decision: { kind: "bid", auction: m.auctions[0] as string, qty: "1", tick: 40, escrow: "100", bond: "1000000", outflow: "1000100", adjustments: [] },
  });
  return sink;
}

describe("dashboard", () => {
  it("shows the mandate, the decisions and the refusals, escaping every untrusted string", () => {
    const check = verifyReceipts(log().read(), agent.receiptKey.publicKey);
    const html = renderDashboard({
      agent: agent.address,
      owner: owner.address,
      receiptKeyHash: receiptKeyHash(agent.receiptKey.publicKey),
      check,
      txUrl: (h) => `https://example.test/tx/${h}`,
      now: NOW,
    });
    expect(html).toContain("4 receipts: chain and ML-DSA-87 signatures verify");
    expect(html).toContain("pinned by this mandate");
    expect(html).toContain("SIGNATURE_INVALID");
    expect(html).toContain("TICK_LOWERED");
    expect(html).toContain("https://example.test/tx/ABCDEF0123456789ABCDEF");
    expect(html).toContain("spending limit exceeded");
    expect(html).toContain("500 fUSD");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>fair</b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says so when the log is broken", () => {
    const lines = log().read();
    lines[2] = (lines[2] as string).replace("TICK_LOWERED", "QTY_LOWERED");
    const html = renderDashboard({
      agent: agent.address,
      owner: owner.address,
      receiptKeyHash: receiptKeyHash(agent.receiptKey.publicKey),
      check: verifyReceipts(lines, agent.receiptKey.publicKey),
      txUrl: (h) => h,
      now: NOW,
    });
    expect(html).toContain("receipts log broken at line 3");
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("links transactions to the REST route unless an explorer is configured", () => {
    expect(txUrlFor({})("AB")).toBe("https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/AB");
    expect(txUrlFor({ QORE_EXPLORER_TX_URL: "https://explorer.test/tx/" })("AB")).toBe("https://explorer.test/tx/AB");
  });
});
