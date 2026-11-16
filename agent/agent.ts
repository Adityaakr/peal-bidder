/**
 * The agent loop: receive mandates, and on each step read the mandate's
 * auctions, plan, clamp, submit, and write a receipt for every one of those.
 *
 * The receipts log is the agent's only memory of what it has spent: after a
 * restart the active mandate and its ledger are rebuilt from the log, so a
 * crash cannot reset the budget.
 */
import type { CanonicalValue } from "../common/canonical.ts";
import { decodeMandate, mandateHash, type PealMandateV1 } from "../common/mandate.ts";
import type { AuctionView } from "./auction.ts";
import { receiveMandate, type AcceptedMandate, type InboxDeps, type MandateRefusal } from "./inbox.ts";
import { decide, type PlanResult } from "./planner/decide.ts";
import type { Planner } from "./planner/types.ts";
import { EMPTY_LEDGER, recordBid, remainingCap, type Decision, type Ledger } from "./policy.ts";
import type { Receipt, ReceiptLog } from "./receipts.ts";

export type BidDecision = Extract<Decision, { kind: "bid" }>;

export interface AuctionReader {
  /** Read the given auctions; an auction that cannot be read is left out. */
  read(addresses: string[]): Promise<AuctionView[]>;
}

export interface SubmitResult {
  /**
   * `landed`: on chain and succeeded. `refused`: definitely not executed (the chain or the
   * executor said no). `unknown`: the outcome could not be established. `dry-run`: not sent.
   */
  status: "landed" | "refused" | "unknown" | "dry-run";
  txHash?: string;
  reason?: string;
}

export interface BidExecutor {
  submit(decision: BidDecision, mandate: PealMandateV1): Promise<SubmitResult>;
}

/** Sends nothing; reports what it would have sent. */
export class DryRunExecutor implements BidExecutor {
  readonly submitted: BidDecision[] = [];
  async submit(decision: BidDecision): Promise<SubmitResult> {
    this.submitted.push(decision);
    return { status: "dry-run", reason: "dry run: nothing was sent" };
  }
}

export interface AgentDeps {
  inbox: InboxDeps;
  receipts: ReceiptLog;
  /** The receipts written so far (already verified), to rebuild state after a restart. */
  history: Receipt[];
  planners: Planner[];
  reader: AuctionReader;
  executor: BidExecutor;
  /** Count dry-run submissions against the ledger, so a dry run behaves like the real thing. */
  countDryRuns?: boolean;
}

export type StepResult =
  | { kind: "idle"; why: string }
  | { kind: "decided"; plan: PlanResult; submit?: SubmitResult };

export function decisionJson(d: Decision): CanonicalValue {
  if (d.kind === "skip") return { kind: "skip", reason: d.reason, detail: d.detail };
  return {
    kind: "bid",
    auction: d.auction,
    qty: d.qty.toString(),
    tick: d.tick,
    escrow: d.escrow.toString(),
    bond: d.bond.toString(),
    outflow: d.outflow.toString(),
    adjustments: d.adjustments,
  };
}

/** Planner output kept in a receipt, at most this many characters. */
export const MAX_RAW_IN_RECEIPT = 8000;

function jsonSafe(x: unknown): CanonicalValue {
  // Planner output is untrusted and may hold anything; keep it as bounded text.
  let text: string | undefined;
  try {
    text = JSON.stringify(x);
  } catch {
    return "[unserialisable]";
  }
  if (text === undefined) return null;
  return text.length > MAX_RAW_IN_RECEIPT ? `${text.slice(0, MAX_RAW_IN_RECEIPT)}…[truncated]` : text;
}

function decisionFromJson(d: Record<string, CanonicalValue>): BidDecision {
  return {
    kind: "bid",
    auction: String(d.auction),
    qty: BigInt(String(d.qty)),
    tick: Number(d.tick),
    escrow: BigInt(String(d.escrow)),
    bond: BigInt(String(d.bond)),
    outflow: BigInt(String(d.outflow)),
    adjustments: [],
  };
}

export interface RecoveredState {
  mandate?: PealMandateV1;
  mandateHash?: string;
  ledger: Ledger;
  /** A bid that was submitted with no result recorded (the agent stopped in between): counted as spent. */
  dangling?: BidDecision;
}

/**
 * Rebuild the active mandate and its ledger from receipts. A `submission`
 * receipt is written before a bid is sent; one with no `result` after it means
 * the agent stopped in between, so the bid may have executed and is counted.
 */
export function stateFromReceipts(history: Receipt[]): RecoveredState {
  let mandate: PealMandateV1 | undefined;
  let hash: string | undefined;
  let ledger = EMPTY_LEDGER;
  let pending: BidDecision | undefined;
  for (const r of history) {
    const data = r.body.data as Record<string, CanonicalValue>;
    if (r.body.kind === "mandate-accepted" && typeof data.text === "string") {
      if (pending) ledger = recordBid(ledger, pending); // belongs to the old mandate's ledger, which is then dropped
      pending = undefined;
      mandate = decodeMandate(data.text);
      hash = mandateHash(data.text);
      ledger = EMPTY_LEDGER;
    } else if (r.body.kind === "submission" && hash && r.body.mandateHash === hash) {
      if (pending) ledger = recordBid(ledger, pending); // two submissions in a row: the first never got a result
      pending = decisionFromJson(data.decision as Record<string, CanonicalValue>);
    } else if (r.body.kind === "result" && hash && r.body.mandateHash === hash) {
      pending = undefined;
      if (data.counted === true) ledger = recordBid(ledger, decisionFromJson(data.decision as Record<string, CanonicalValue>));
    }
  }
  if (pending) ledger = recordBid(ledger, pending);
  return { ...(mandate ? { mandate } : {}), ...(hash ? { mandateHash: hash } : {}), ledger, ...(pending ? { dangling: pending } : {}) };
}

export class BidderAgent {
  private mandate: PealMandateV1 | undefined;
  private hash: string | undefined;
  private ledger: Ledger;

  constructor(private readonly deps: AgentDeps) {
    const s = stateFromReceipts(deps.history);
    this.mandate = s.mandate;
    this.hash = s.mandateHash;
    this.ledger = s.ledger;
    if (s.dangling && s.mandateHash) {
      // Say so in the log: the outcome of the last submission was never recorded.
      deps.receipts.append("result", s.mandateHash, {
        status: "unknown",
        txHash: null,
        reason: "the agent stopped after submitting this bid; its outcome was not recorded, so it is counted as spent",
        counted: true,
        decision: decisionJson(s.dangling),
      });
    }
  }

  get state(): { mandate?: PealMandateV1; mandateHash?: string; ledger: Ledger } {
    return { ...(this.mandate ? { mandate: this.mandate } : {}), ...(this.hash ? { mandateHash: this.hash } : {}), ledger: this.ledger };
  }

  /** Check a sealed mandate; on success it replaces the active one and starts a fresh ledger. */
  async receive(envelopeText: string): Promise<AcceptedMandate | MandateRefusal> {
    const res = await receiveMandate(envelopeText, this.deps.inbox);
    if (!res.ok) {
      this.deps.receipts.append("mandate-refused", res.mandateHash ?? null, { code: res.code, message: res.message });
      return res;
    }
    this.deps.receipts.append("mandate-accepted", res.mandateHash, { text: res.text, nonce: res.mandate.nonce });
    this.mandate = res.mandate;
    this.hash = res.mandateHash;
    this.ledger = EMPTY_LEDGER;
    return res;
  }

  /** One planning round: at most one bid. */
  async step(): Promise<StepResult> {
    const mandate = this.mandate;
    const hash = this.hash;
    if (!mandate || !hash) return { kind: "idle", why: "no mandate" };
    const now = this.deps.inbox.now();
    if (now >= mandate.expiresAt) return { kind: "idle", why: "the mandate has expired" };
    if (now < mandate.notBefore) return { kind: "idle", why: "the mandate has not started" };
    // Nothing can be bid: do not ask the planner (and pay for a model call) for nothing.
    if (this.ledger.bids >= mandate.maxBids) return { kind: "idle", why: "the mandate's bid count is used up" };
    if (remainingCap(mandate, this.ledger) === 0n) return { kind: "idle", why: "the mandate's budget is used up" };

    const auctions = await this.deps.reader.read(mandate.auctions);
    if (!auctions.some((a) => a.commitOpen && now < a.commitEnd)) return { kind: "idle", why: "no auction of the mandate is taking bids" };
    const plan = await decide({ mandate, auctions, ledger: this.ledger, now }, this.deps.planners);
    this.deps.receipts.append("decision", hash, {
      source: plan.source,
      model: plan.model ?? null,
      usage: plan.usage ? { inputTokens: plan.usage.inputTokens, outputTokens: plan.usage.outputTokens } : null,
      attempts: plan.attempts.map((a) => ({ planner: a.planner, error: a.error })),
      raw: jsonSafe(plan.raw),
      decision: decisionJson(plan.decision),
      ledgerBefore: { bids: this.ledger.bids, committed: this.ledger.committed.toString() },
    });
    if (plan.decision.kind !== "bid") return { kind: "decided", plan };

    // Written before anything leaves the agent, so a crash mid-submission is counted on restart.
    this.deps.receipts.append("submission", hash, { decision: decisionJson(plan.decision) });
    let submit: SubmitResult;
    try {
      submit = await this.deps.executor.submit(plan.decision, mandate);
    } catch (err) {
      submit = { status: "unknown", reason: `executor error: ${(err as Error).message}` };
    }
    // An unknown outcome counts as spent: the budget must never be under-counted.
    const counted =
      submit.status === "landed" || submit.status === "unknown" || (submit.status === "dry-run" && this.deps.countDryRuns === true);
    if (counted) this.ledger = recordBid(this.ledger, plan.decision);
    this.deps.receipts.append("result", hash, {
      status: submit.status,
      txHash: submit.txHash ?? null,
      reason: submit.reason ?? null,
      counted,
      decision: decisionJson(plan.decision),
    });
    return { kind: "decided", plan, submit };
  }
}
