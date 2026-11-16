import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mldsa87 } from "@qorechain/pqc";
import { pqKeyFromSeed, pqSign, pqVerify } from "@qorechain/qoresign";
import { MemorySink, ReceiptLog, generateReceiptKey, receiptSignBytes, verifyReceipts, type Receipt } from "../agent/receipts.ts";
import { FileSink } from "../agent/receipt-file.ts";

const key = generateReceiptKey();
const AGENT = "qor1agent";

function filled(n = 3) {
  const sink = new MemorySink();
  const log = new ReceiptLog(sink, key, AGENT, () => 1_795_000_000);
  for (let i = 0; i < n; i++) log.append("decision", "ab".repeat(32), { i, qty: `${i}000` });
  return sink;
}

describe("receipts log", () => {
  it("chains and signs every receipt", () => {
    const sink = filled();
    const check = verifyReceipts(sink.read(), key.publicKey);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.count).toBe(3);
      expect(check.receipts.map((r) => r.body.seq)).toEqual([0, 1, 2]);
    }
  });

  it("detects an edited receipt", () => {
    const lines = filled().read();
    lines[1] = (lines[1] as string).replace('"qty":"1000"', '"qty":"9000"');
    expect(verifyReceipts(lines, key.publicKey)).toMatchObject({ ok: false, line: 2, error: "signature does not verify" });
  });

  it("detects a deleted or reordered receipt", () => {
    const lines = filled().read();
    expect(verifyReceipts([lines[0] as string, lines[2] as string], key.publicKey)).toMatchObject({ ok: false, line: 2 });
    expect(verifyReceipts([lines[1] as string, lines[0] as string], key.publicKey)).toMatchObject({ ok: false, line: 1 });
  });

  it("detects receipts signed by another key", () => {
    expect(verifyReceipts(filled().read(), generateReceiptKey().publicKey)).toMatchObject({ ok: false, line: 1 });
  });

  it("detects junk lines", () => {
    expect(verifyReceipts(["{"], key.publicKey)).toMatchObject({ ok: false, error: "not JSON" });
    expect(verifyReceipts(["null"], key.publicKey)).toMatchObject({ ok: false, error: "not a receipt" });
  });

  it("resumes the chain from a file, which it writes with mode 0600", () => {
    const path = join(mkdtempSync(join(tmpdir(), "peal-bidder-")), "receipts.jsonl");
    new ReceiptLog(new FileSink(path), key, AGENT).append("mandate-accepted", null, { n: 1 });
    new ReceiptLog(new FileSink(path), key, AGENT).append("decision", null, { n: 2 });
    const check = verifyReceipts(new FileSink(path).read(), key.publicKey);
    expect(check).toMatchObject({ ok: true, count: 2 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to append to a broken log", () => {
    const path = join(mkdtempSync(join(tmpdir(), "peal-bidder-")), "receipts.jsonl");
    new ReceiptLog(new FileSink(path), key, AGENT).append("decision", null, { n: 1 });
    writeFileSync(path, readFileSync(path, "utf8").replace('"n":1', '"n":2'));
    expect(() => new ReceiptLog(new FileSink(path), key, AGENT)).toThrow(/broken at line 1/);
  });

  it("reports the first failing line, whether a signature or the structure failed first", () => {
    const lines = filled(5).read();
    const badSig = (l: string) => l.replace('"qty":"', '"qty":"9');
    // a bad signature on line 2 before a broken chain on line 4
    const a = [...lines];
    a[1] = badSig(a[1] as string);
    a[3] = a[4] as string;
    expect(verifyReceipts(a, key.publicKey)).toMatchObject({ ok: false, line: 2, error: "signature does not verify" });
    // a deleted line 2 before a bad signature on line 4
    const b = [lines[0] as string, lines[2] as string, lines[3] as string, badSig(lines[4] as string)];
    expect(verifyReceipts(b, key.publicKey)).toMatchObject({ ok: false, line: 2, error: "sequence 2, expected 1" });
  });
});

describe("receipt signatures with qorechain-pqc", () => {
  it("are the same bytes as QoreSign's ML-DSA-87, so older logs and their verifiers keep working", () => {
    const seed = new Uint8Array(32).fill(7);
    const ours = generateReceiptKey(seed);
    const theirs = pqKeyFromSeed(seed);
    expect(ours.publicKey).toEqual(theirs.publicKey);
    const sink = new MemorySink();
    const r = new ReceiptLog(sink, ours, AGENT, () => 1_795_000_000).append("decision", null, { x: "1" });
    const bytes = receiptSignBytes(r.body);
    expect(Buffer.from(r.sig, "hex")).toEqual(Buffer.from(pqSign(theirs.secretKey, bytes)));
    expect(pqVerify(theirs.publicKey, bytes, Buffer.from(r.sig, "hex"))).toBe(true);
    expect(mldsa87.verify(ours.publicKey, bytes, Buffer.from(r.sig, "hex"))).toBe(true);
  });

  it("check the published live log, signed before this change", () => {
    const dir = new URL("../apps/web/public/live/", import.meta.url);
    const lines = readFileSync(new URL("receipts.jsonl", dir), "utf8").split("\n").filter((l) => l.length > 0);
    const agent = JSON.parse(readFileSync(new URL("agent.json", dir), "utf8")) as { receiptPublicKey: string };
    const check = verifyReceipts(lines, Buffer.from(agent.receiptPublicKey, "hex"));
    expect(check.ok).toBe(true);
    if (check.ok) expect((check.receipts[0] as Receipt).body.seq).toBe(0);
  });
});
