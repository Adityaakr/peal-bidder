/**
 * The receipts log: one signed, hash-chained line per decision.
 *
 * Each receipt records what the agent saw, what the planner proposed, what
 * the policy let through and what the chain said. It is signed with the
 * agent's ML-DSA-87 receipt key, a standalone key that is not registered on
 * any account and so gives no power on chain. The owner pins its hash in every
 * mandate (`receiptKey`), so a receipt verifies against a key the owner chose.
 *
 * `prev` chains each receipt to the one before it, so a deleted, reordered or
 * edited line is detected. The log proves what the agent says it did; the
 * chain's own records (transaction hashes in the receipts) prove what happened.
 */
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { pqKeyFromSeed, pqSign, pqVerify } from "@qorechain/qoresign";
import { canonicalize, type CanonicalValue } from "../common/canonical.ts";

export const RECEIPT_SIGN_PREFIX = "peal-bidder/receipt/v1\n";
export const GENESIS = "0".repeat(64);

export interface ReceiptKey {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateReceiptKey(seed: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(32))): ReceiptKey {
  const k = pqKeyFromSeed(seed);
  return { publicKey: k.publicKey, secretKey: k.secretKey };
}

export function receiptKeyHash(publicKey: Uint8Array): string {
  return bytesToHex(sha3_256(publicKey));
}

export type ReceiptKind = "mandate-accepted" | "mandate-refused" | "decision" | "submission" | "result" | "claim";

export interface ReceiptBody {
  v: 1;
  seq: number;
  /** Hash of the previous receipt's body, or 64 zeros for the first. */
  prev: string;
  /** Unix seconds. */
  at: number;
  agent: string;
  kind: ReceiptKind;
  mandateHash: string | null;
  data: CanonicalValue;
}

export interface Receipt {
  body: ReceiptBody;
  /** Hex ML-DSA-87 signature over `RECEIPT_SIGN_PREFIX + canonical(body)`. */
  sig: string;
}

export function receiptSignBytes(body: ReceiptBody): Uint8Array {
  return utf8ToBytes(RECEIPT_SIGN_PREFIX + canonicalize(body));
}

export function receiptHash(body: ReceiptBody): string {
  return bytesToHex(sha3_256(utf8ToBytes(canonicalize(body))));
}

/** Where receipt lines go: a file (`receipt-file.ts`, Node only), memory, or a browser's storage. */
export interface ReceiptSink {
  read(): string[];
  append(line: string): void;
}

export class MemorySink implements ReceiptSink {
  readonly lines: string[] = [];
  read(): string[] {
    return [...this.lines];
  }
  append(line: string): void {
    this.lines.push(line);
  }
}

export class ReceiptLog {
  private seq: number;
  private prev: string;

  constructor(
    private readonly sink: ReceiptSink,
    private readonly key: ReceiptKey,
    private readonly agent: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    // Resume the chain from the log on disk, after checking it.
    const check = verifyReceipts(sink.read(), key.publicKey);
    if (!check.ok) throw new Error(`the receipts log is broken at line ${check.line}: ${check.error}`);
    this.seq = check.count;
    this.prev = check.head;
  }

  /**
   * Continue from the log's last line, so that several `ReceiptLog`s on one
   * file in one process (the agent's decisions and its claims, say) extend one
   * chain instead of forking it. The log was verified in full when opened; the
   * last line is checked again here, so a line written by anything else stops
   * the agent rather than being chained onto.
   */
  private resync(): void {
    const lines = this.sink.read();
    if (lines.length === this.seq) return;
    if (lines.length < this.seq) throw new Error("the receipts log was truncated under the agent");
    const last = JSON.parse(lines[lines.length - 1] as string) as Receipt;
    if (last.body.seq !== lines.length - 1 || !pqVerify(this.key.publicKey, receiptSignBytes(last.body), hexToBytes(last.sig))) {
      throw new Error("the receipts log changed under the agent and its last line does not verify");
    }
    this.seq = lines.length;
    this.prev = receiptHash(last.body);
  }

  append(kind: ReceiptKind, mandateHash: string | null, data: CanonicalValue): Receipt {
    this.resync();
    const body: ReceiptBody = {
      v: 1,
      seq: this.seq,
      prev: this.prev,
      at: this.now(),
      agent: this.agent,
      kind,
      mandateHash,
      data,
    };
    const sig = bytesToHex(pqSign(this.key.secretKey, receiptSignBytes(body)));
    const receipt: Receipt = { body, sig };
    this.sink.append(JSON.stringify(receipt));
    this.seq += 1;
    this.prev = receiptHash(body);
    return receipt;
  }
}

export type ReceiptCheck =
  | { ok: true; count: number; head: string; receipts: Receipt[] }
  | { ok: false; line: number; error: string };

/** Check every line: well-formed, numbered in order, chained, and signed by `publicKey`. */
export function verifyReceipts(lines: string[], publicKey: Uint8Array): ReceiptCheck {
  let prev = GENESIS;
  const receipts: Receipt[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    let r: Receipt;
    try {
      r = JSON.parse(lines[i] as string) as Receipt;
    } catch {
      return { ok: false, line, error: "not JSON" };
    }
    if (typeof r !== "object" || r === null || typeof r.sig !== "string" || typeof r.body !== "object" || r.body === null) {
      return { ok: false, line, error: "not a receipt" };
    }
    if (r.body.v !== 1) return { ok: false, line, error: "unknown version" };
    if (r.body.seq !== i) return { ok: false, line, error: `sequence ${String(r.body.seq)}, expected ${i}` };
    if (r.body.prev !== prev) return { ok: false, line, error: "does not chain to the previous receipt" };
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = receiptSignBytes(r.body);
      sig = hexToBytes(r.sig);
    } catch (err) {
      return { ok: false, line, error: `malformed: ${(err as Error).message}` };
    }
    if (!pqVerify(publicKey, bytes, sig)) return { ok: false, line, error: "signature does not verify" };
    prev = receiptHash(r.body);
    receipts.push(r);
  }
  return { ok: true, count: lines.length, head: prev, receipts };
}
