/**
 * live.ts - the owner's agent, as its receipts tell it.
 *
 * The agent publishes its receipts log (`pnpm web:receipts`); this module loads
 * it and checks it again here, in the visitor's browser: every line chains to
 * the one before, and every ML-DSA-87 signature verifies against the receipt
 * key whose hash the owner pinned in each mandate. Transaction hashes in the
 * receipts are then looked up on the chain, live.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { decodeMandate, type PealMandateV1 } from "../../../common/mandate.ts";
import { receiptKeyHash, verifyReceipts, type Receipt } from "../../../agent/receipts.ts";

export interface LiveAgentInfo {
  publishedAt: string;
  address: string;
  evm: string;
  owner: string;
  receiptPublicKey: string;
  receiptKeyHash: string;
}

export type LiveEvent =
  | { kind: "mandate-accepted"; seq: number; at: number; mandateHash: string; mandate: PealMandateV1; pinsKey: boolean }
  | { kind: "mandate-refused"; seq: number; at: number; mandateHash: string | null; code: string; message: string }
  | {
      kind: "decision";
      seq: number;
      at: number;
      mandateHash: string;
      source: string;
      model: string | null;
      tokens: { input: number; output: number } | null;
      rationale: string;
      proposal: { tick?: number; qty?: string; action?: string } | null;
      decision: { kind: string; tick?: number; qty?: string; outflow?: string; reason?: string; detail?: string; adjustments?: string[] };
    }
  | { kind: "submission"; seq: number; at: number; mandateHash: string; outflow: string; tick: number }
  | { kind: "result"; seq: number; at: number; mandateHash: string; status: string; txHash: string | null; reason: string | null; outflow: string; tick: number }
  | { kind: "claim"; seq: number; at: number; auction: string; bidId: string; allocation: string; status: string; txHash: string | null };

export interface LiveLog {
  info: LiveAgentInfo;
  receipts: Receipt[];
  events: LiveEvent[];
  check: { ok: true; head: string; count: number; ms: number } | { ok: false; line: number; error: string };
  stats: {
    mandates: number;
    refusedByAgent: number;
    landed: number;
    refusedByChain: number;
    claims: number;
    modelRounds: number;
    tokens: number;
  };
}

function obj(x: unknown): Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function parseRaw(raw: unknown): { rationale: string; proposal: { tick?: number; qty?: string; action?: string } | null } {
  if (typeof raw !== "string") return { rationale: "", proposal: null };
  try {
    const o = obj(JSON.parse(raw));
    return {
      rationale: typeof o.rationale === "string" ? o.rationale : "",
      proposal: {
        ...(typeof o.tick === "number" ? { tick: o.tick } : {}),
        ...(typeof o.qty === "string" ? { qty: o.qty } : {}),
        ...(typeof o.action === "string" ? { action: o.action } : {}),
      },
    };
  } catch {
    return { rationale: "", proposal: null };
  }
}

/** Turn verified receipts into events the page can show. Receipt data is untrusted text: only read, never rendered as markup. */
export function toEvents(receipts: Receipt[], pinnedKeyHash: string): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const r of receipts) {
    const b = r.body;
    const d = obj(b.data);
    const base = { seq: b.seq, at: b.at };
    if (b.kind === "mandate-accepted" && typeof d.text === "string") {
      let mandate: PealMandateV1;
      try {
        mandate = decodeMandate(d.text);
      } catch {
        continue;
      }
      out.push({ kind: "mandate-accepted", ...base, mandateHash: b.mandateHash ?? "", mandate, pinsKey: mandate.receiptKey === pinnedKeyHash });
    } else if (b.kind === "mandate-refused") {
      out.push({ kind: "mandate-refused", ...base, mandateHash: b.mandateHash, code: String(d.code ?? ""), message: String(d.message ?? "") });
    } else if (b.kind === "decision") {
      const raw = parseRaw(d.raw);
      const usage = obj(d.usage);
      const dec = obj(d.decision);
      out.push({
        kind: "decision",
        ...base,
        mandateHash: b.mandateHash ?? "",
        source: String(d.source ?? ""),
        model: typeof d.model === "string" ? d.model : null,
        tokens: typeof usage.inputTokens === "number" ? { input: usage.inputTokens, output: Number(usage.outputTokens ?? 0) } : null,
        rationale: raw.rationale,
        proposal: raw.proposal,
        decision: {
          kind: String(dec.kind ?? ""),
          ...(typeof dec.tick === "number" ? { tick: dec.tick } : {}),
          ...(typeof dec.qty === "string" ? { qty: dec.qty } : {}),
          ...(typeof dec.outflow === "string" ? { outflow: dec.outflow } : {}),
          ...(typeof dec.reason === "string" ? { reason: dec.reason } : {}),
          ...(typeof dec.detail === "string" ? { detail: dec.detail } : {}),
          adjustments: Array.isArray(dec.adjustments) ? dec.adjustments.map(String) : [],
        },
      });
    } else if (b.kind === "submission") {
      const dec = obj(d.decision);
      out.push({ kind: "submission", ...base, mandateHash: b.mandateHash ?? "", outflow: String(dec.outflow ?? "0"), tick: Number(dec.tick ?? 0) });
    } else if (b.kind === "result") {
      const dec = obj(d.decision);
      out.push({
        kind: "result",
        ...base,
        mandateHash: b.mandateHash ?? "",
        status: String(d.status ?? ""),
        txHash: typeof d.txHash === "string" ? d.txHash : null,
        reason: typeof d.reason === "string" ? d.reason : null,
        outflow: String(dec.outflow ?? "0"),
        tick: Number(dec.tick ?? 0),
      });
    } else if (b.kind === "claim") {
      out.push({
        kind: "claim",
        ...base,
        auction: String(d.auction ?? ""),
        bidId: String(d.bidId ?? ""),
        allocation: String(d.allocation ?? "0"),
        status: String(d.status ?? ""),
        txHash: typeof d.txHash === "string" ? d.txHash : null,
      });
    }
  }
  return out;
}

export function statsOf(events: LiveEvent[]): LiveLog["stats"] {
  let tokens = 0;
  let modelRounds = 0;
  for (const e of events) {
    if (e.kind === "decision" && e.tokens) {
      modelRounds += 1;
      tokens += e.tokens.input + e.tokens.output;
    }
  }
  return {
    mandates: events.filter((e) => e.kind === "mandate-accepted").length,
    refusedByAgent: events.filter((e) => e.kind === "mandate-refused").length,
    landed: events.filter((e) => e.kind === "result" && e.status === "landed").length,
    refusedByChain: events.filter((e) => e.kind === "result" && e.status === "refused").length,
    claims: events.filter((e) => e.kind === "claim" && e.status === "landed").length,
    modelRounds,
    tokens,
  };
}

let cache: Promise<LiveLog> | undefined;

/** Load the published log and check it here. Cached for the page's lifetime. */
export function loadLive(): Promise<LiveLog> {
  cache ??= (async () => {
    const [infoRes, logRes] = await Promise.all([fetch("/live/agent.json", { cache: "no-cache" }), fetch("/live/receipts.jsonl", { cache: "no-cache" })]);
    if (!infoRes.ok || !logRes.ok) throw new Error("the agent's receipts are not published here");
    const info = (await infoRes.json()) as LiveAgentInfo;
    const lines = (await logRes.text()).split("\n").filter((l) => l.length > 0);
    const key = hexToBytes(info.receiptPublicKey);
    if (receiptKeyHash(key) !== info.receiptKeyHash) throw new Error("the published receipt key does not match its hash");
    const t0 = performance.now();
    const res = verifyReceipts(lines, key);
    const ms = Math.round(performance.now() - t0);
    const check: LiveLog["check"] = res.ok ? { ok: true, head: res.head, count: res.count, ms } : res;
    const receipts = res.ok ? res.receipts : [];
    const events = toEvents(receipts, info.receiptKeyHash);
    return { info, receipts, events, check, stats: statsOf(events) };
  })();
  cache.catch(() => (cache = undefined));
  return cache;
}
