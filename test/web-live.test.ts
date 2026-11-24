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
import { ruleMeaning } from "../apps/web/src/rule.ts";
import { VAULT_BID_SELECTOR } from "../agent/vault.ts";
import { FBTC, FUSD } from "../common/network.ts";

const dir = join(import.meta.dirname, "..", "apps", "web", "public", "live");
const info = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")) as LiveAgentInfo;
const lines = readFileSync(join(dir, "receipts.jsonl"), "utf8").split("\n").filter((l) => l.length > 0);

describe("published receipts", () => {
  it("publish only public material", () => {
    expect(Object.keys(info).filter((k) => k !== "vault").sort()).toEqual(["address", "evm", "owner", "publishedAt", "receiptKeyHash", "receiptPublicKey", "v"]);
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
    expect(statsOf(events)).toMatchObject({ mandates: 4, refusedByAgent: 4, landed: 5, refusedByChain: 4, claims: 5 });
    const refused = events.find((e) => e.kind === "mandate-refused");
    expect(refused).toMatchObject({ code: "SIGNATURE_INVALID" });
    for (const e of events) if (e.kind === "mandate-accepted") expect(e.pinsKey).toBe(true);
  });
});

describe("the spending rule as the site reads it", () => {
  const VAULT = `0x${"9a".repeat(20)}`;
  const rule = (over: object) => ({ id: "r", enabled: true, perTxLimit: "0", dailyLimit: "0", allowedDenoms: [], allowedEvmCalls: [], denomLimits: [], ...over });
  const budget = rule({ allowedDenoms: [`erc20/${FUSD.toLowerCase()}`], denomLimits: [{ denom: `erc20/${FUSD.toLowerCase()}`, per_tx_limit: "100000000", daily_limit: "200000000" }], allowedEvmCalls: ["0x1/0x2", "0x1/0x3"] });
  const vault = rule({ allowedDenoms: [`erc20/${FBTC}`], denomLimits: [{ denom: `erc20/${FBTC}`, per_tx_limit: "1", daily_limit: "1" }], allowedEvmCalls: [`${VAULT}/${VAULT_BID_SELECTOR}`, "0x1/0x379607f5"] });

  it("reads the fUSD limits of a budget rule", () => {
    expect(ruleMeaning([budget])).toEqual({ kind: "budget", perBid: "100000000", daily: "200000000", calls: 2 });
  });

  it("never shows the unheld token's limit as fUSD", () => {
    expect(ruleMeaning([vault])).toEqual({ kind: "vault", vault: VAULT, lists: [`erc20/${FBTC}`], calls: 2 });
  });

  it("does not call an any-token rule a vault rule", () => {
    expect(ruleMeaning([{ ...vault, allowedDenoms: [], denomLimits: [] }])).toMatchObject({ kind: "other", denoms: [] });
    expect(ruleMeaning([{ ...vault, allowedDenoms: [`erc20/${FBTC}`, `erc20/${FUSD}`] }])).toMatchObject({ kind: "other" });
    expect(ruleMeaning([])).toEqual({ kind: "none" });
    expect(ruleMeaning([{ ...budget, enabled: false }, vault])).toMatchObject({ kind: "vault" });
  });
});
