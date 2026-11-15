/**
 * The rule-based planner: used when Claude is unavailable, refuses, or returns
 * something unusable. It ignores the free-text instructions and bids, in the
 * first open auction of the mandate, the most the limits allow at a tick
 * `bidTickFraction` of the way up to the highest allowed tick.
 */
import { maxQty, tickCeiling } from "../policy.ts";
import type { Planner, PlannerInput, PlannerOutput } from "./types.ts";

export class RulePlanner implements Planner {
  readonly name = "rules" as const;

  /** `bidTickFraction` in [0, 1]: 1 bids at the ceiling, 0.5 halfway (rounded down). */
  constructor(private readonly bidTickFraction = 0.5) {
    if (!(bidTickFraction >= 0 && bidTickFraction <= 1)) throw new Error("bidTickFraction must be in [0, 1]");
  }

  async propose(input: PlannerInput): Promise<PlannerOutput> {
    const ctx = { mandate: input.mandate, auctions: input.auctions, ledger: input.ledger, now: input.now };
    for (const address of input.mandate.auctions) {
      const a = input.auctions.find((x) => x.address === address);
      if (!a || !a.commitOpen || input.now >= a.commitEnd || a.numTicks < 1) continue;
      if (a.quoteToken !== input.mandate.quoteToken) continue;
      const tick = Math.floor(tickCeiling(input.mandate, a) * this.bidTickFraction);
      const qty = maxQty(ctx, a, tick);
      if (qty === 0n || qty < a.minQuantity) continue;
      return {
        proposal: {
          action: "bid",
          auction: a.address,
          qty: qty.toString(),
          tick,
          rationale: `rule-based: the most the limits allow at tick ${tick} in the first open auction`,
        },
      };
    }
    return {
      proposal: { action: "skip", auction: "", qty: "0", tick: 0, rationale: "rule-based: no open auction fits the limits" },
    };
  }
}
