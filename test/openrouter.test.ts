import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { EMPTY_LEDGER } from "../agent/policy.ts";
import { RulePlanner, decide, defaultPlanners, type PlannerInput } from "../agent/planner/index.ts";
import {
  MAX_TOKENS,
  OPENROUTER_MODEL,
  OpenRouterPlanner,
  buildOpenRouterRequest,
  openRouterKey,
  type ChatCompletion,
  type ChatTransport,
} from "../agent/planner/openrouter.ts";
import { SYSTEM_PROMPT } from "../agent/planner/prompt.ts";
import { AUCTION_A, NOW, newAccount, newAgent, sampleMandate } from "./helpers.ts";
import { auction } from "./auctions.ts";

const owner = newAccount();
const agent = newAgent();
const DUMMY_KEY = "sk-or-test-not-a-real-key";

function input(details: string): PlannerInput {
  return { mandate: sampleMandate(owner, agent), auctions: [auction({ details })], ledger: EMPTY_LEDGER, now: NOW };
}

/** The same scenario fixtures as the Anthropic planner, as chat completions. */
function asChat(m: Anthropic.Beta.Messages.BetaMessage): ChatCompletion {
  const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const finish = m.stop_reason === "refusal" ? "content_filter" : m.stop_reason === "max_tokens" ? "length" : "stop";
  return {
    model: OPENROUTER_MODEL,
    choices: [{ finish_reason: finish, message: { content: text || null } }],
    usage: { prompt_tokens: m.usage.input_tokens, completion_tokens: m.usage.output_tokens },
  };
}

function replay(json: ChatCompletion, status = 200) {
  const sent: unknown[] = [];
  const send: ChatTransport = async (body) => {
    sent.push(body);
    return { status, json };
  };
  return { send, sent };
}

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "claude");
const fixtures = readdirSync(dir).map(
  (f) =>
    JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      name: string;
      auction_details: string;
      response: Anthropic.Beta.Messages.BetaMessage;
      expect: { source: string; kind: string; reason?: string; tick?: number; maxOutflow?: string };
    },
);

describe("OpenRouter request", () => {
  it("asks Claude Opus 5.5 for a schema-bound answer at low effort, with a token cap, and carries no key", () => {
    const body = buildOpenRouterRequest(input("x"));
    expect(body.model).toBe("anthropic/claude-opus-5.5");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true, schema: { required: ["action", "auction", "qty", "tick", "rationale"] } } });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_tokens).toBe(MAX_TOKENS);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(JSON.stringify(body)).not.toContain("sk-or");
  });
});

describe("OpenRouter planner on the recorded scenarios", () => {
  for (const f of fixtures) {
    it(`${f.name}`, async () => {
      const { send, sent } = replay(asChat(f.response));
      const res = await decide(input(f.auction_details), [new OpenRouterPlanner(send), new RulePlanner()]);
      expect(sent).toHaveLength(1);
      expect(res.source).toBe(f.expect.source);
      expect(res.decision.kind).toBe(f.expect.kind);
      if (res.decision.kind === "skip" && f.expect.reason) expect(res.decision.reason).toBe(f.expect.reason);
      if (res.decision.kind === "bid") {
        if (f.expect.tick !== undefined) expect(res.decision.tick).toBe(f.expect.tick);
        expect(res.decision.auction).toBe(AUCTION_A);
        expect(res.decision.tick).toBeLessThanOrEqual(40);
        expect(res.decision.outflow).toBeLessThanOrEqual(100_000_000n);
      }
    });
  }

  it("falls back to the rules on an HTTP error, and never repeats the key in the reason", async () => {
    const { send } = replay({ error: { code: 401, message: `bad key ${DUMMY_KEY}` } }, 401);
    const res = await decide(input("x"), [new OpenRouterPlanner(send), new RulePlanner()]);
    expect(res.source).toBe("rules");
    expect(res.attempts[0]?.error).toBe("OpenRouter answered 401");
  });

  it("falls back to the rules when the network fails", async () => {
    const send: ChatTransport = async () => Promise.reject(Object.assign(new Error(`connect ${DUMMY_KEY}`), { name: "TimeoutError" }));
    const res = await decide(input("x"), [new OpenRouterPlanner(send), new RulePlanner()]);
    expect(res.source).toBe("rules");
    expect(res.attempts[0]?.error).not.toContain(DUMMY_KEY);
  });

  it("records the model and tokens", async () => {
    const normal = fixtures.find((f) => f.name === "normal-bid");
    if (!normal) throw new Error("missing fixture");
    const res = await decide(input("x"), [new OpenRouterPlanner(replay(asChat(normal.response)).send)]);
    expect(res).toMatchObject({ source: "claude", model: OPENROUTER_MODEL, usage: { inputTokens: 2900, outputTokens: 140 } });
  });
});

describe("the key and the planner choice", () => {
  it("reads the key from the environment first, then from the owner's 0600 file", () => {
    const d = mkdtempSync(join(tmpdir(), "peal-bidder-or-"));
    const file = join(d, "openrouter.env");
    expect(openRouterKey({}, file)).toBeUndefined();
    writeFileSync(file, `OPENROUTER_API_KEY=${DUMMY_KEY}\n`, { mode: 0o600 });
    expect(openRouterKey({}, file)).toBe(DUMMY_KEY);
    expect(openRouterKey({ OPENROUTER_API_KEY: "sk-or-from-env" }, file)).toBe("sk-or-from-env");
  });

  it("refuses a key file other users can read", () => {
    const d = mkdtempSync(join(tmpdir(), "peal-bidder-or-"));
    const file = join(d, "openrouter.env");
    writeFileSync(file, `OPENROUTER_API_KEY=${DUMMY_KEY}\n`, { mode: 0o644 });
    expect(() => openRouterKey({}, file)).toThrow(/mode 644/);
  });

  it("uses only the rules in every test run", () => {
    expect(process.env.PEAL_BIDDER_PLANNER).toBe("rules");
    expect(defaultPlanners().map((p) => p.name)).toEqual(["rules"]);
    expect(defaultPlanners({ PEAL_BIDDER_PLANNER: "rules", OPENROUTER_API_KEY: DUMMY_KEY }).map((p) => p.name)).toEqual(["rules"]);
    expect(defaultPlanners({ OPENROUTER_API_KEY: DUMMY_KEY }).map((p) => p.name)).toEqual(["claude", "rules"]);
  });
});

describe("recorded OpenRouter answers (scripts/record-openrouter.ts)", () => {
  const recDir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "openrouter-recorded");
  const files = readdirSync(recDir).filter((f) => f.endsWith(".json"));
  it("has at least one recording", () => expect(files.length).toBeGreaterThan(0));
  for (const file of files) {
    const r = JSON.parse(readFileSync(join(recDir, file), "utf8")) as { name: string; auction_details: string; status: number; response: ChatCompletion };
    it(`${r.name}: the real answer is used and stays inside the mandate`, async () => {
      expect(JSON.stringify(r)).not.toMatch(/sk-or-v1|OPENROUTER_API_KEY|authorization/i);
      const res = await decide(input(r.auction_details), [new OpenRouterPlanner(replay(r.response, r.status).send), new RulePlanner()]);
      expect(res.source).toBe("claude");
      if (res.decision.kind === "bid") {
        expect(res.decision.auction).toBe(AUCTION_A);
        expect(res.decision.tick).toBeLessThanOrEqual(40);
        expect(res.decision.outflow).toBeLessThanOrEqual(100_000_000n);
      }
      if (r.name.startsWith("injection-") && res.proposal?.action === "bid") expect(res.proposal.auction).toBe(AUCTION_A);
    });
  }
});
