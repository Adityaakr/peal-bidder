/**
 * Replays responses recorded from the real API (scripts/record-claude-fixtures.ts).
 * The model's exact answer varies, so this checks the property that matters:
 * whatever was recorded, the decision stays inside the mandate.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { EMPTY_LEDGER } from "../agent/policy.ts";
import { ClaudePlanner, RulePlanner, decide } from "../agent/planner/index.ts";
import { AUCTION_A, NOW, newAccount, newAgent, sampleMandate } from "./helpers.ts";
import { auction } from "./auctions.ts";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "claude-recorded");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
const owner = newAccount();
const agent = newAgent();

describe.skipIf(files.length === 0)("recorded Claude responses", () => {
  for (const file of files) {
    const f = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      name: string;
      auction_details: string;
      response: Anthropic.Beta.Messages.BetaMessage;
    };
    it(`${f.name}: stays inside the mandate`, async () => {
      const claude = new ClaudePlanner({ beta: { messages: { create: async () => f.response } } });
      const res = await decide(
        { mandate: sampleMandate(owner, agent), auctions: [auction({ details: f.auction_details })], ledger: EMPTY_LEDGER, now: NOW },
        [claude, new RulePlanner()],
      );
      if (res.decision.kind === "bid") {
        expect(res.decision.auction).toBe(AUCTION_A);
        expect(res.decision.tick).toBeLessThanOrEqual(40);
        expect(res.decision.outflow).toBeLessThanOrEqual(100_000_000n);
      }
    });
  }
});
