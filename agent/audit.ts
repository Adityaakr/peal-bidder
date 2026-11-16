/**
 * The agent audits itself against the chain: `pnpm agent audit`.
 *
 * The receipts log says what the agent did, signed by its receipt key. This
 * checks it against what QoreChain recorded, through the QoreChain MCP server
 * (`qorechain-mcp.ts`), so that a receipt is never the only evidence:
 *
 * - every transaction a receipt names exists, and its outcome is the one the
 *   receipt recorded: `landed` is a successful transaction, `refused` one the
 *   chain refused (for a linked-key call, a code-0 transaction whose execution
 *   failed, with the chain's reason);
 * - an `unknown` outcome (the connection dropped after sending) is resolved
 *   from the chain, so the owner learns whether that money actually moved;
 * - every native transaction carries exactly one hybrid ML-DSA-87 layer and it
 *   verifies against the signer's registered key, checked by the MCP server
 *   with QoreSign, not read from a label; EVM transactions (the window path)
 *   are classical by design and are reported as such;
 * - when the expected signers are given (the relayer, the agent's account), no
 *   transaction was signed by anyone else;
 * - the owner the agent serves has an ML-DSA-87 key registered with proof of
 *   possession, the key every mandate is checked against.
 *
 * Read-only: the MCP server never signs or broadcasts.
 */
import type { ChainTools } from "./qorechain-mcp.ts";
import { ChainToolError } from "./qorechain-mcp.ts";
import type { Receipt } from "./receipts.ts";

export type RecordedStatus = "landed" | "refused" | "unknown";

export interface AuditLine {
  /** Receipt sequence number. */
  seq: number;
  kind: string;
  txHash: string;
  recorded: RecordedStatus;
  /** What the chain says: `success`, `refused` (included, execution refused), `not-found`, or `error` (could not ask). */
  chain: "success" | "refused" | "not-found" | "error";
  /** The chain's reason for a refusal. */
  chainReason: string | null;
  height: string | null;
  signer: string | null;
  /** `pqc` (hybrid), `classical`, ...; null when the transaction was not read. */
  tier: string | null;
  /** The hybrid layer verified against the signer's registered key; null when it does not apply or was not checked. */
  hybridVerified: boolean | null;
  /**
   * `ok`: the chain agrees with the receipt. `resolved`: an unknown outcome,
   * now known from the chain. `mismatch`: the chain disagrees with the receipt.
   * `unshielded`: a native transaction without a verifying ML-DSA-87 layer.
   * `foreign-signer`: signed by an account outside the expected signers.
   * `error`: the chain could not be asked.
   */
  verdict: "ok" | "resolved" | "mismatch" | "unshielded" | "foreign-signer" | "error";
  note: string;
}

export interface OwnerCheck {
  address: string;
  registered: boolean;
  algorithm: string | null;
  possessionProven: boolean;
  ok: boolean;
  note: string;
}

export interface AuditReport {
  ok: boolean;
  owner: OwnerCheck;
  transactions: AuditLine[];
  counts: Record<AuditLine["verdict"], number>;
}

export interface AuditOptions {
  /** Addresses allowed to sign the agent's transactions (qor1 form). Unchecked when empty. */
  signers?: string[];
}

interface TxRef {
  seq: number;
  kind: string;
  txHash: string;
  recorded: RecordedStatus;
  reason: string | null;
}

/** The transactions a receipts log names: results of bids, and claims. */
export function transactionsIn(receipts: Receipt[]): TxRef[] {
  const out: TxRef[] = [];
  for (const r of receipts) {
    if (r.body.kind !== "result" && r.body.kind !== "claim") continue;
    const d = r.body.data as { status?: unknown; txHash?: unknown; reason?: unknown } | null;
    if (!d || typeof d.txHash !== "string" || d.txHash.length === 0) continue;
    const status = d.status;
    if (status !== "landed" && status !== "refused" && status !== "unknown") continue;
    out.push({ seq: r.body.seq, kind: r.body.kind, txHash: d.txHash, recorded: status, reason: typeof d.reason === "string" ? d.reason : null });
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

async function checkOwner(chain: ChainTools, owner: string): Promise<OwnerCheck> {
  try {
    const r = await chain.call("get_pq_status", { target: owner });
    const s = (r.address_status ?? {}) as Record<string, unknown>;
    const registered = s.registered === true;
    const algorithm = str(s.algorithm);
    const possessionProven = s.possession_proven === true;
    const ok = registered && s.algorithm_id === 1 && possessionProven;
    const note = ok
      ? "ML-DSA-87 key registered with proof of possession: the key every mandate is checked against"
      : !registered
        ? "no ML-DSA-87 key registered: the agent refuses every mandate"
        : !possessionProven
          ? "key registered without proof of possession: the agent refuses it"
          : `key of algorithm ${algorithm ?? "?"}: the agent accepts only ML-DSA-87`;
    return { address: owner, registered, algorithm, possessionProven, ok, note };
  } catch (err) {
    return { address: owner, registered: false, algorithm: null, possessionProven: false, ok: false, note: `could not ask the chain: ${(err as Error).message}` };
  }
}

async function checkTx(chain: ChainTools, t: TxRef, signers: Set<string>): Promise<AuditLine> {
  const line: AuditLine = {
    seq: t.seq,
    kind: t.kind,
    txHash: t.txHash,
    recorded: t.recorded,
    chain: "error",
    chainReason: null,
    height: null,
    signer: null,
    tier: null,
    hybridVerified: null,
    verdict: "error",
    note: "",
  };
  let tx: Record<string, unknown>;
  try {
    tx = await chain.call("get_transaction", { hash: t.txHash });
  } catch (err) {
    if (err instanceof ChainToolError && err.code === "NOT_FOUND") {
      line.chain = "not-found";
      if (t.recorded === "landed") {
        line.verdict = "mismatch";
        line.note = "the receipt says it landed, but the chain has no such transaction";
      } else {
        line.verdict = t.recorded === "unknown" ? "resolved" : "ok";
        line.note = t.recorded === "unknown" ? "not on chain: the unknown outcome did not land" : "not on chain, as the refusal says";
      }
      return line;
    }
    line.note = `could not ask the chain: ${(err as Error).message}`;
    return line;
  }

  const success = tx.success === true;
  const failure = (tx.failure ?? null) as { message?: unknown } | null;
  const execFailures = Array.isArray(tx.execution_failures) ? (tx.execution_failures as { reason?: unknown }[]) : [];
  line.chain = success ? "success" : "refused";
  line.chainReason = success ? null : (str(execFailures[0]?.reason) ?? str(failure?.message) ?? "refused");
  line.height = str(tx.height);
  const signers0 = Array.isArray(tx.signers) ? (tx.signers as { address?: unknown }[]) : [];
  line.signer = str(signers0[0]?.address);
  const security = (tx.security ?? {}) as { tier?: unknown };
  line.tier = str(security.tier);

  // Outcome: does the chain agree with the receipt?
  const chainStatus: RecordedStatus = success ? "landed" : "refused";
  if (t.recorded === "unknown") {
    line.verdict = "resolved";
    line.note = success ? "the unknown outcome landed: count it as spent" : `the unknown outcome was refused: ${line.chainReason}`;
  } else if (t.recorded !== chainStatus) {
    line.verdict = "mismatch";
    line.note = `the receipt says ${t.recorded}, the chain says ${chainStatus}${line.chainReason ? ` (${line.chainReason})` : ""}`;
    return line;
  } else {
    line.verdict = "ok";
    line.note = success ? "landed, as recorded" : `refused by the chain, as recorded: ${line.chainReason}`;
  }

  // Who signed it.
  if (signers.size > 0 && (line.signer === null || !signers.has(line.signer))) {
    line.verdict = "foreign-signer";
    line.note = `signed by ${line.signer ?? "an unknown account"}, not one of the expected signers`;
    return line;
  }

  // The post-quantum layer: native transactions must carry one that verifies.
  const evmLane = t.txHash.startsWith("0x");
  if (evmLane && line.tier !== "pqc") {
    line.note += "; an EVM transaction inside the owner's window, classical by design";
    return line;
  }
  try {
    const pq = await chain.call("get_pq_status", { target: t.txHash });
    const s = (pq.transaction_status ?? {}) as { has_exactly_one_pqc_layer?: unknown; verification?: { checked?: unknown; verified?: unknown; reason?: unknown } };
    line.hybridVerified = s.has_exactly_one_pqc_layer === true && s.verification?.checked === true && s.verification.verified === true;
    if (!line.hybridVerified) {
      line.verdict = "unshielded";
      line.note = `no verifying ML-DSA-87 layer (${str(s.verification?.reason) ?? `tier ${line.tier ?? "?"}`})`;
    } else {
      line.note += "; hybrid ML-DSA-87 layer verified against the signer's registered key";
    }
  } catch (err) {
    line.verdict = "error";
    line.note = `could not check the hybrid layer: ${(err as Error).message}`;
  }
  return line;
}

export async function auditReceipts(receipts: Receipt[], owner: string, chain: ChainTools, opts: AuditOptions = {}): Promise<AuditReport> {
  const signers = new Set(opts.signers ?? []);
  const ownerCheck = await checkOwner(chain, owner);
  const transactions: AuditLine[] = [];
  for (const t of transactionsIn(receipts)) transactions.push(await checkTx(chain, t, signers));
  const counts: AuditReport["counts"] = { ok: 0, resolved: 0, mismatch: 0, unshielded: 0, "foreign-signer": 0, error: 0 };
  for (const l of transactions) counts[l.verdict] += 1;
  const ok = ownerCheck.ok && counts.mismatch === 0 && counts.unshielded === 0 && counts["foreign-signer"] === 0 && counts.error === 0;
  return { ok, owner: ownerCheck, transactions, counts };
}
