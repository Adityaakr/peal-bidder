/**
 * The agent as a long-running process: each tick it reads new sealed mandates
 * from its inbox, makes at most one planning round, and (with claims on) claims
 * its bids in auctions that have finished.
 *
 * Every tick prints one JSON line: addresses, hashes, codes and decisions, never
 * a key. A stop signal ends the loop after the current tick.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import type { BidderAgent, StepResult } from "./agent.ts";
import { auctionOutcome, claimAll, type ClaimsClient } from "./claims.ts";
import type { ReceiptLog } from "./receipts.ts";
import type { CallSender } from "./smart-account-executor.ts";

export interface InboxResult {
  file: string;
  accepted?: string;
  nonce?: number;
  refused?: string;
  message?: string;
}

/** Read every sealed mandate in `inbox` in name order and move each to `inbox/done`. */
export async function drainInbox(agent: BidderAgent, inbox: string): Promise<InboxResult[]> {
  if (!existsSync(inbox)) return [];
  mkdirSync(join(inbox, "done"), { recursive: true, mode: 0o700 });
  const out: InboxResult[] = [];
  for (const f of readdirSync(inbox).filter((x) => x.endsWith(".qoreseal")).sort()) {
    const res = await agent.receive(readFileSync(join(inbox, f), "utf8"));
    renameSync(join(inbox, f), join(inbox, "done", f));
    out.push(res.ok ? { file: f, accepted: res.mandateHash, nonce: res.mandate.nonce } : { file: f, refused: res.code, message: res.message });
  }
  return out;
}

export interface ServeContext {
  agent: BidderAgent;
  inbox: string;
  /** Claims, when on: where to read outcomes, whose bids, how to send, where to record. */
  claims?: { client: ClaimsClient; bidder: Address; sender: CallSender; receipts: ReceiptLog; vault?: Address };
  log?: (line: Record<string, unknown>) => void;
  /** True while the owner has paused the agent (agent/control.ts): no planning round, so no bid. */
  paused?: () => boolean;
}

export interface Tick {
  at: string;
  inbox: InboxResult[];
  step: StepResult | { kind: "error"; message: string };
  claims?: { auction: string; state: string; claimed: number }[];
}

function summarise(s: StepResult): Record<string, unknown> {
  if (s.kind === "idle") return { idle: s.why };
  const d = s.plan.decision;
  return {
    planner: s.plan.source,
    decision: d.kind === "bid" ? { bid: d.auction, tick: d.tick, outflow: d.outflow.toString(), adjustments: d.adjustments } : { skip: d.reason },
    ...(s.submit ? { submit: { status: s.submit.status, txHash: s.submit.txHash ?? null } } : {}),
  };
}

export async function tick(ctx: ServeContext): Promise<Tick> {
  const inbox = await drainInbox(ctx.agent, ctx.inbox);
  let step: Tick["step"];
  if (ctx.paused?.() === true) {
    step = { kind: "idle", why: "paused by the owner" };
  } else {
    try {
      step = await ctx.agent.step();
    } catch (err) {
      step = { kind: "error", message: (err as Error).message };
    }
  }
  const t: Tick = { at: new Date().toISOString(), inbox, step };
  const mandate = ctx.agent.state.mandate;
  if (ctx.claims && mandate) {
    t.claims = [];
    for (const a of mandate.auctions) {
      try {
        const o = await auctionOutcome(ctx.claims.client, a, ctx.claims.bidder);
        const done = await claimAll({ outcome: o, sender: ctx.claims.sender, receipts: ctx.claims.receipts, mandateHash: ctx.agent.state.mandateHash ?? null, ...(ctx.claims.vault ? { vault: ctx.claims.vault } : {}) });
        t.claims.push({ auction: a, state: o.state, claimed: done.filter((d) => d.result.status === "landed").length });
      } catch {
        t.claims.push({ auction: a, state: "unreadable", claimed: 0 });
      }
    }
  }
  ctx.log?.({
    at: t.at,
    inbox: t.inbox,
    step: t.step.kind === "error" ? { error: t.step.message } : summarise(t.step),
    ...(t.claims ? { claims: t.claims } : {}),
  });
  return t;
}

/** Tick every `intervalSeconds` until `signal` aborts (or `maxTicks` ticks have run). */
export async function serve(ctx: ServeContext, opts: { intervalSeconds: number; maxTicks?: number; signal?: AbortSignal }): Promise<number> {
  let n = 0;
  while (!opts.signal?.aborted && (opts.maxTicks === undefined || n < opts.maxTicks)) {
    await tick(ctx);
    n++;
    if (opts.signal?.aborted || (opts.maxTicks !== undefined && n >= opts.maxTicks)) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.intervalSeconds * 1000);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  return n;
}
