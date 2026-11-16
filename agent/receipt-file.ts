/**
 * The receipts log on disk: one JSON object per line, mode 0600. Node only, so
 * `receipts.ts` stays importable in a browser (the web app's guest agent keeps
 * its log in the browser's storage instead).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReceiptSink } from "./receipts.ts";

export class FileSink implements ReceiptSink {
  constructor(private readonly path: string) {}
  read(): string[] {
    try {
      return readFileSync(this.path, "utf8").split("\n").filter((l) => l.length > 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
  append(line: string): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
  }
}
