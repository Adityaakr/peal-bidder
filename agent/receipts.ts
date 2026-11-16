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
 *
 * The signatures are ML-DSA-87 (FIPS 204) from qorechain-pqc (`@qorechain/pqc`),
 * QoreChain's own implementation, the same one QoreSign and the chain's
 * accounts use: deterministic signing, and a whole log checked with
 * `batchVerify`.
 */
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { batchVerify, mldsa87 } from "@qorechain/pqc";
import { canonicalize, type CanonicalValue } from "../common/canonical.ts";

export const RECEIPT_SIGN_PREFIX = "peal-bidder/receipt/v1\n";
export const GENESIS = "0".repeat(64);

export interface ReceiptKey {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateReceiptKey(seed: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(32))): ReceiptKey {
  const k = mldsa87.keygen(seed);
  return { publicKey: k.publicKey, secretKey: k.secretKey };
}

export function receiptKeyHash(publicKey: Uint8Array): string {
  return bytesToHex(sha3_256(publicKey));
}

export type ReceiptKind = "mandate-accepted" | "mandate-refused" | "decision" | "submission" | "result" | "claim" | "control";

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
    if (last.body.seq !== lines.length - 1 || !mldsa87.verify(this.key.publicKey, receiptSignBytes(last.body), hexToBytes(last.sig))) {
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
    const sig = bytesToHex(mldsa87.sign(this.key.secretKey, receiptSignBytes(body)));
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

/**
 * Check every line: well-formed, numbered in order, chained, and signed by
 * `publicKey`. The structure is checked line by line first; the signatures of
 * every well-formed line then go to one `batchVerify`. The first failing line
 * is reported, whichever check it failed.
 */
export function verifyReceipts(lines: string[], publicKey: Uint8Array): ReceiptCheck {
  let prev = GENESIS;
  const receipts: Receipt[] = [];
  const items: { publicKey: Uint8Array; message: Uint8Array; signature: Uint8Array }[] = [];
  let broken: { line: number; error: string } | null = null;
  for (let i = 0; i < lines.length && broken === null; i++) {
    const line = i + 1;
    let r: Receipt;
    try {
      r = JSON.parse(lines[i] as string) as Receipt;
    } catch {
      broken = { line, error: "not JSON" };
      break;
    }
    if (typeof r !== "object" || r === null || typeof r.sig !== "string" || typeof r.body !== "object" || r.body === null) {
      broken = { line, error: "not a receipt" };
      break;
    }
    if (r.body.v !== 1) broken = { line, error: "unknown version" };
    else if (r.body.seq !== i) broken = { line, error: `sequence ${String(r.body.seq)}, expected ${i}` };
    else if (r.body.prev !== prev) broken = { line, error: "does not chain to the previous receipt" };
    if (broken) break;
    try {
      items.push({ publicKey, message: receiptSignBytes(r.body), signature: hexToBytes(r.sig) });
    } catch (err) {
      broken = { line, error: `malformed: ${(err as Error).message}` };
      break;
    }
    prev = receiptHash(r.body);
    receipts.push(r);
  }
  const firstBad = batchVerify(mldsa87, items);
  if (firstBad >= 0) return { ok: false, line: firstBad + 1, error: "signature does not verify" };
  if (broken) return { ok: false, ...broken };
  return { ok: true, count: lines.length, head: prev, receipts };
}
