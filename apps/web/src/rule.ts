/**
 * rule.ts - what the owner's spending rule means. The first denom limit is not
 * always the budget: with the vault, the rule lists a token the owner does not
 * hold, and the limits on fUSD are the vault's own.
 */
import { VAULT_BID_SELECTOR } from "../../../agent/vault.ts";
import type { SpendingRuleView } from "./chain.ts";
import { FUSD } from "../../../common/network.ts";

export type RuleMeaning =
  | { kind: "none" }
  /** The budget sits on the owner's account: the rule lists fUSD and bounds it. */
  | { kind: "budget"; perBid?: string; daily?: string; calls: number }
  /** The budget sits in the vault: no fUSD in the rule. */
  | { kind: "vault"; vault: string; lists: string[]; calls: number }
  | { kind: "other"; denoms: string[]; calls: number };

export function ruleMeaning(rules: SpendingRuleView[] | undefined): RuleMeaning {
  const r = rules?.find((x) => x.enabled) ?? rules?.[0];
  if (!r) return { kind: "none" };
  const calls = r.allowedEvmCalls.length;
  const isFusd = (d: string) => d.toLowerCase().endsWith(FUSD.toLowerCase());
  const lim = r.denomLimits.find((d) => isFusd(d.denom));
  // An empty list means any denom, so it is never "no fUSD".
  if (r.allowedDenoms.length > 0 && !r.allowedDenoms.some(isFusd)) {
    const bid = r.allowedEvmCalls.find((c) => c.toLowerCase().endsWith(`/${VAULT_BID_SELECTOR}`));
    if (bid) return { kind: "vault", vault: bid.slice(0, bid.indexOf("/")), lists: r.allowedDenoms, calls };
  }
  if (!lim) return { kind: "other", denoms: r.allowedDenoms, calls };
  const perBid = lim.per_tx_limit ?? lim.perTxLimit;
  const daily = lim.daily_limit ?? lim.dailyLimit;
  return { kind: "budget", ...(perBid ? { perBid } : {}), ...(daily ? { daily } : {}), calls };
}
