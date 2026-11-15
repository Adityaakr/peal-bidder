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
import { decide, type Planner, type PlanResult } from "./planner/index.ts";
import { EMPTY_LEDGER, recordBid, type Decision, type Ledger } from "./policy.ts";
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

function jsonSafe(x: unknown): CanonicalValue {
  // Planner output is untrusted and may hold anything; keep it as text.
  try {
    return JSON.stringify(x) ?? null;
  } catch {
    return "[unserialisable]";
  }
}

/** Rebuild the active mandate and its ledger from receipts. */
export function stateFromReceipts(history: Receipt[]): { mandate?: PealMandateV1; mandateHash?: string; ledger: Ledger } {
  let mandate: PealMandateV1 | undefined;
  let hash: string | undefined;
  let ledger = EMPTY_LEDGER;
  for (const r of history) {
    const data = r.body.data as Record<string, CanonicalValue>;
    if (r.body.kind === "mandate-accepted" && typeof data.text === "string") {
      mandate = decodeMandate(data.text);
      hash = mandateHash(data.text);
      ledger = EMPTY_LEDGER;
    } else if (r.body.kind === "result" && hash && r.body.mandateHash === hash && data.counted === true) {
      const d = data.decision as Record<string, CanonicalValue>;
      ledger = recordBid(ledger, {
        kind: "bid",
        auction: String(d.auction),
        qty: BigInt(String(d.qty)),
        tick: Number(d.tick),
        escrow: BigInt(String(d.escrow)),
        bond: BigInt(String(d.bond)),
        outflow: BigInt(String(d.outflow)),
        adjustments: [],
      });
    }
  }
  return { ...(mandate ? { mandate } : {}), ...(hash ? { mandateHash: hash } : {}), ledger };
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

    const auctions = await this.deps.reader.read(mandate.auctions);
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
