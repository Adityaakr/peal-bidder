/**
 * The planner through OpenRouter: Claude Opus 5.5 (`anthropic/claude-opus-5.5`)
 * on OpenRouter's OpenAI-compatible chat API, with a JSON-schema structured
 * output, low reasoning effort and a token cap. The owner chose OpenRouter for
 * the live run; the Anthropic-SDK planner (`claude.ts`) stays for an
 * Anthropic key.
 *
 * Spend is kept small: one short request per planning round, at most
 * `MAX_TOKENS` out, and the agent asks only when a bid is possible (see
 * `BidderAgent.step`). Tests and CI never call it: they replay recorded
 * responses.
 *
 * The key is read from OPENROUTER_API_KEY or from `~/.qore-bidder/openrouter.env`
 * (mode 0600), never from the repository, and is never logged.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSecrets } from "qore-pq-kit";
import { SYSTEM_PROMPT, buildUserContent } from "./prompt.ts";
import { PlannerUnavailable } from "./claude.ts";
import { PROPOSAL_SCHEMA, type Planner, type PlannerInput, type PlannerOutput } from "./types.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODEL = "anthropic/claude-opus-5.5";
export const MAX_TOKENS = 1024;
export const TIMEOUT_MS = 60_000;

/** The request the planner sends (no key in it). */
export function buildOpenRouterRequest(input: PlannerInput, model = OPENROUTER_MODEL) {
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserContent(input) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "bid_proposal", strict: true, schema: PROPOSAL_SCHEMA } },
    reasoning: { effort: "low" },
    max_tokens: MAX_TOKENS,
    // Only route to providers that honour the structured output and the effort setting.
    provider: { require_parameters: true },
  };
}

/** The part of an OpenAI-style chat completion the planner reads. */
export interface ChatCompletion {
  model?: string;
  choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number | string };
}

export type ChatTransport = (body: unknown) => Promise<{ status: number; json: ChatCompletion }>;

export function httpTransport(apiKey: string, url = OPENROUTER_URL): ChatTransport {
  return async (body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: ChatCompletion = {};
    try {
      json = (await res.json()) as ChatCompletion;
    } catch {
      // keep {}
    }
    return { status: res.status, json };
  };
}

export class OpenRouterPlanner implements Planner {
  readonly name = "claude" as const;

  constructor(
    private readonly send: ChatTransport,
    private readonly model = OPENROUTER_MODEL,
  ) {}

  async propose(input: PlannerInput): Promise<PlannerOutput> {
    let res: Awaited<ReturnType<ChatTransport>>;
    try {
      res = await this.send(buildOpenRouterRequest(input, this.model));
    } catch (err) {
      throw new PlannerUnavailable("api_error", `the OpenRouter call failed: ${(err as Error).name}`);
    }
    if (res.status !== 200 || res.json.error) {
      const code = res.json.error?.code ?? res.status;
      throw new PlannerUnavailable("api_error", `OpenRouter answered ${String(code)}`);
    }
    const choice = res.json.choices?.[0];
    if (!choice) throw new PlannerUnavailable("no_text", "OpenRouter returned no choice");
    if (choice.message?.refusal || choice.finish_reason === "content_filter") throw new PlannerUnavailable("refusal", "the model declined");
    if (choice.finish_reason === "length") throw new PlannerUnavailable("max_tokens", "the model ran out of output tokens");
    const text = choice.message?.content;
    if (!text) throw new PlannerUnavailable("no_text", "the model returned no text");
    let proposal: unknown;
    try {
      proposal = JSON.parse(text);
    } catch {
      throw new PlannerUnavailable("not_json", "the model's answer is not JSON");
    }
    const usage = res.json.usage;
    return {
      proposal,
      model: res.json.model ?? this.model,
      ...(usage ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } } : {}),
    };
  }
}

export const OPENROUTER_KEY_FILE = join(homedir(), ".qore-bidder", "openrouter.env");

/** The key from OPENROUTER_API_KEY, else from the owner's 0600 file; undefined when neither is there. */
export function openRouterKey(env: Record<string, string | undefined> = process.env, file = OPENROUTER_KEY_FILE): string | undefined {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(file)) return undefined;
  return loadSecrets(file).OPENROUTER_API_KEY?.trim() || undefined;
}

export function openRouterPlannerFromEnv(env: Record<string, string | undefined> = process.env, file?: string): OpenRouterPlanner | undefined {
  const key = openRouterKey(env, file);
  return key ? new OpenRouterPlanner(httpTransport(key)) : undefined;
}
