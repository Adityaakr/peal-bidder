/**
 * The agent's memory of accepted mandates: the highest nonce per owner.
 *
 * Nonces are strictly increasing, so one number per owner refuses both a
 * replay of the current mandate and a rollback to an older one.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MandateRecord {
  nonce: number;
  mandateHash: string;
  acceptedAt: number;
}

export interface MandateStore {
  /** Record `nonce` for `owner` if it is above the last one; false (and no change) otherwise. */
  acceptNonce(owner: string, nonce: number, mandateHash: string): Promise<boolean>;
  current(owner: string): Promise<MandateRecord | undefined>;
}

export class MemoryMandateStore implements MandateStore {
  private readonly records = new Map<string, MandateRecord>();

  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async acceptNonce(owner: string, nonce: number, mandateHash: string): Promise<boolean> {
    const last = this.records.get(owner);
    if (last && nonce <= last.nonce) return false;
    this.records.set(owner, { nonce, mandateHash, acceptedAt: this.now() });
    return true;
  }

  async current(owner: string): Promise<MandateRecord | undefined> {
    return this.records.get(owner);
  }
}

/** A JSON file, written atomically with mode 0600. */
export class FileMandateStore implements MandateStore {
  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private load(): Record<string, MandateRecord> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    // A corrupt store must stop the agent, not reset the nonces.
    return JSON.parse(text) as Record<string, MandateRecord>;
  }

  async acceptNonce(owner: string, nonce: number, mandateHash: string): Promise<boolean> {
    const records = this.load();
    const last = records[owner];
    if (last && nonce <= last.nonce) return false;
    records[owner] = { nonce, mandateHash, acceptedAt: this.now() };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    return true;
  }

  async current(owner: string): Promise<MandateRecord | undefined> {
    return this.load()[owner];
  }
}
