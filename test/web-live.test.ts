/**
 * The web app's reading of the live agent's published receipts
 * (`apps/web/public/live/`): the log verifies against the published key, and the
 * events and figures the landing page shows come out as the testnet run recorded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { receiptKeyHash, verifyReceipts } from "../agent/receipts.ts";
import { statsOf, toEvents, type LiveAgentInfo } from "../apps/web/src/live.ts";

const dir = join(import.meta.dirname, "..", "apps", "web", "public", "live");
const info = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")) as LiveAgentInfo;
const lines = readFileSync(join(dir, "receipts.jsonl"), "utf8").split("\n").filter((l) => l.length > 0);

describe("published receipts", () => {
  it("publish only public material", () => {
    expect(Object.keys(info).sort()).toEqual(["address", "evm", "owner", "publishedAt", "receiptKeyHash", "receiptPublicKey", "v"]);
    expect(receiptKeyHash(hexToBytes(info.receiptPublicKey))).toBe(info.receiptKeyHash);
    for (const l of lines) expect(l).not.toMatch(/mnemonic|PRIVATE_KEY|SEED|secret/i);
  });

  it("verify: chained and signed with the published key", () => {
    const c = verifyReceipts(lines, hexToBytes(info.receiptPublicKey));
    expect(c.ok).toBe(true);
  });

  it("a single edited line breaks the check", () => {
    const edited = [...lines];
    edited[3] = edited[3]!.replace('"landed"', '"refused"');
    const c = verifyReceipts(edited, hexToBytes(info.receiptPublicKey));
    expect(c).toMatchObject({ ok: false, line: 4 });
  });

  it("give the figures the landing page shows", () => {
    const c = verifyReceipts(lines, hexToBytes(info.receiptPublicKey));
    if (!c.ok) throw new Error("log broken");
    const events = toEvents(c.receipts, info.receiptKeyHash);
    expect(statsOf(events)).toMatchObject({ mandates: 2, refusedByAgent: 1, landed: 3, refusedByChain: 2, claims: 3 });
    const refused = events.find((e) => e.kind === "mandate-refused");
    expect(refused).toMatchObject({ code: "SIGNATURE_INVALID" });
    for (const e of events) if (e.kind === "mandate-accepted") expect(e.pinsKey).toBe(true);
  });
});
