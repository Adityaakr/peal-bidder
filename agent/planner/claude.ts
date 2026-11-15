/**
 * The Claude planner: Claude Opus 5.5 at low effort with structured output,
 * and server-side refusal fallbacks enabled.
 *
 * The API key is read from ANTHROPIC_API_KEY only, never from a file in the
 * repository. Without it `claudePlannerFromEnv` returns undefined and the
 * agent runs on the rule-based planner.
 */
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, buildUserContent } from "./prompt.ts";
import { PROPOSAL_SCHEMA, type Planner, type PlannerInput, type PlannerOutput } from "./types.ts";

export const CLAUDE_MODEL = "claude-opus-5-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The part of the SDK client the planner uses, so tests can pass a recorded one. */
export interface MessagesClient {
  beta: { messages: { create(params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.Messages.BetaMessage> } };
}

export class PlannerUnavailable extends Error {
  override name = "PlannerUnavailable";
  constructor(
    readonly reason: "refusal" | "max_tokens" | "no_text" | "not_json" | "api_error",
    message: string,
  ) {
    super(message);
  }
}

/** The request the planner sends, exposed for tests and for the dashboard. */
export function buildRequest(input: PlannerInput, model = CLAUDE_MODEL): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 4096,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: PROPOSAL_SCHEMA as unknown as Record<string, unknown> } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserContent(input) }],
  };
}

export class ClaudePlanner implements Planner {
  readonly name = "claude" as const;

  constructor(
    private readonly client: MessagesClient,
    private readonly model = CLAUDE_MODEL,
  ) {}

  async propose(input: PlannerInput): Promise<PlannerOutput> {
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await this.client.beta.messages.create(buildRequest(input, this.model));
    } catch (err) {
      throw new PlannerUnavailable("api_error", `the Claude API call failed: ${(err as Error).message}`);
    }
    if (res.stop_reason === "refusal") {
      const category = res.stop_details?.category ?? "unknown";
      throw new PlannerUnavailable("refusal", `Claude declined (${category})`);
    }
    if (res.stop_reason === "max_tokens") throw new PlannerUnavailable("max_tokens", "Claude ran out of output tokens");
    const text = res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text) throw new PlannerUnavailable("no_text", "Claude returned no text");
    let proposal: unknown;
    try {
      proposal = JSON.parse(text);
    } catch {
      throw new PlannerUnavailable("not_json", "Claude's answer is not JSON");
    }
    return {
      proposal,
      model: res.model,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}

/** A Claude planner when ANTHROPIC_API_KEY is set, otherwise undefined. */
export function claudePlannerFromEnv(env: Record<string, string | undefined> = process.env): ClaudePlanner | undefined {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new ClaudePlanner(new Anthropic({ apiKey }));
}
