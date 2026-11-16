/**
 * pnpm record:mcp-audit - record the chain's answers to the QoreChain MCP
 * server while it audits two receipts of the published live log (a landed bid
 * and one the chain refused), so that test/audit.test.ts
 * replays the real server against real answers with no network.
 * Read-only: the server never signs or broadcasts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { auditReceipts } from "../agent/audit.ts";
import { connectQoreChainMcp } from "../agent/qorechain-mcp.ts";
import { verifyReceipts } from "../agent/receipts.ts";

const dir = new URL("../apps/web/public/live/", import.meta.url);
const meta = JSON.parse(readFileSync(new URL("agent.json", dir), "utf8")) as { owner: string; receiptPublicKey: string };
const lines = readFileSync(new URL("receipts.jsonl", dir), "utf8").split("\n").filter((l) => l.length > 0);
const check = verifyReceipts(lines, hexToBytes(meta.receiptPublicKey));
if (!check.ok) throw new Error(`published log broken at line ${check.line}`);

const recorded: { key: string; status: number; body: string }[] = [];
const recordingFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const res = await fetch(input, init);
  const body = await res.text();
  recorded.push({ key: `${init?.method ?? "GET"} ${input} ${typeof init?.body === "string" ? init.body : ""}`, status: res.status, body });
  return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
};
const chain = await connectQoreChainMcp({ upstream: { fetch: recordingFetch } });
// Receipt 3: the first landed bid. Receipt 16: a bid the chain's daily limit refused.
const subset = check.receipts.filter((r) => r.body.seq === 3 || r.body.seq === 16);
const report = await auditReceipts(subset, meta.owner, chain, {});
await chain.close();
writeFileSync(new URL("../test/fixtures/mcp-audit/published.json", import.meta.url), `${JSON.stringify({ recordedAt: new Date().toISOString(), responses: recorded })}\n`);
console.log(`ok=${report.ok} ${recorded.length} answers recorded`);
