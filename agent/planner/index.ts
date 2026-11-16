/**
 * The planners: Claude (through OpenRouter or the Anthropic API) and the rules,
 * chosen from the environment. `decide` itself lives in `decide.ts`.
 */
import { claudePlannerFromEnv } from "./claude.ts";
import { openRouterPlannerFromEnv } from "./openrouter.ts";
import { RulePlanner } from "./rules.ts";
import type { Planner } from "./types.ts";
export { decide, type PlanAttempt, type PlanResult } from "./decide.ts";

export { ClaudePlanner, claudePlannerFromEnv, CLAUDE_MODEL, PlannerUnavailable } from "./claude.ts";
export { OpenRouterPlanner, openRouterPlannerFromEnv, OPENROUTER_MODEL } from "./openrouter.ts";

/**
 * The planners to try, in order: Claude Opus 5.5 through OpenRouter when its
 * key is present, else through the Anthropic API when that key is, then the
 * rules. `PEAL_BIDDER_PLANNER=rules` (set for every test run) uses the rules
 * only, so no test or CI run can call a paid model.
 */
export function defaultPlanners(env: Record<string, string | undefined> = process.env): Planner[] {
  const rules = new RulePlanner();
  if (env.PEAL_BIDDER_PLANNER === "rules") return [rules];
  const model = openRouterPlannerFromEnv(env) ?? claudePlannerFromEnv(env);
  return model ? [model, rules] : [rules];
}
export { RulePlanner } from "./rules.ts";
export type { Planner, PlannerInput, PlannerOutput } from "./types.ts";
