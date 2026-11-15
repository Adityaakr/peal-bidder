/**
 * Planning: ask each planner in turn (Claude first when configured, then the
 * rules) until one returns a well-formed proposal, then let the policy clamp it.
 */
import { clamp, parseProposal, type Decision, type Proposal } from "../policy.ts";
import type { Planner, PlannerInput } from "./types.ts";

export interface PlanAttempt {
  planner: Planner["name"];
  /** Why this planner's answer was not used. */
  error: string;
}

export interface PlanResult {
  /** The planner whose proposal was used, or "none" when every planner failed. */
  source: Planner["name"] | "none";
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** The raw output of the planner that was used (as it came back, before the policy). */
  raw: unknown;
  proposal: Proposal | undefined;
  /** Planners that were tried before and failed. */
  attempts: PlanAttempt[];
  decision: Decision;
}

export async function decide(input: PlannerInput, planners: Planner[]): Promise<PlanResult> {
  const attempts: PlanAttempt[] = [];
  const ctx = { mandate: input.mandate, auctions: input.auctions, ledger: input.ledger, now: input.now };
  for (const planner of planners) {
    try {
      const out = await planner.propose(input);
      const proposal = parseProposal(out.proposal);
      if (!proposal) {
        attempts.push({ planner: planner.name, error: "the output is not a well-formed proposal" });
        continue;
      }
      return {
        source: planner.name,
        ...(out.model ? { model: out.model } : {}),
        ...(out.usage ? { usage: out.usage } : {}),
        raw: out.proposal,
        proposal,
        attempts,
        decision: clamp(proposal, ctx),
      };
    } catch (err) {
      attempts.push({ planner: planner.name, error: (err as Error).message });
    }
  }
  return {
    source: "none",
    raw: undefined,
    proposal: undefined,
    attempts,
    decision: { kind: "skip", reason: "PROPOSAL_MALFORMED", detail: "no planner returned a usable proposal" },
  };
}

export { ClaudePlanner, claudePlannerFromEnv, CLAUDE_MODEL, PlannerUnavailable } from "./claude.ts";
export { RulePlanner } from "./rules.ts";
export type { Planner, PlannerInput, PlannerOutput } from "./types.ts";
