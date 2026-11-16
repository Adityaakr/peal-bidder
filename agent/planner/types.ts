import type { PealMandateV1 } from "../../common/mandate.ts";
import type { AuctionView } from "../auction.ts";
import type { Ledger } from "../policy.ts";

export interface PlannerInput {
  mandate: PealMandateV1;
  /** The mandate's auctions as read from the chain. */
  auctions: AuctionView[];
  ledger: Ledger;
  /** Unix seconds. */
  now: number;
}

export interface PlannerOutput {
  /** A proposal for the policy to check. Untrusted: the policy validates and clamps it. */
  proposal: unknown;
  /** The model that answered, when a model did. */
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Planner {
  /** "simulated": a stand-in for a compromised model, used only by the web app's "try to break it" scenes. */
  readonly name: "claude" | "rules" | "simulated";
  /** Throws when the planner cannot answer; the caller then tries the next planner. */
  propose(input: PlannerInput): Promise<PlannerOutput>;
}

/** JSON schema of a proposal, used as Claude's structured output format. */
export const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["bid", "skip"], description: "bid to place one sealed bid now, skip to place none" },
    auction: { type: "string", description: "0x address of the auction, copied from the list given; empty when skipping" },
    qty: { type: "string", description: "sale-token base units as a decimal integer string; \"0\" when skipping" },
    tick: { type: "integer", description: "price tick, 0-based; 0 when skipping" },
    rationale: { type: "string", description: "one or two sentences on why" },
  },
  required: ["action", "auction", "qty", "tick", "rationale"],
} as const;
