/**
 * The owner's brake: pause and resume a running agent with Sign In With
 * QoreChain (SIWQ, QoreSign's `createSiwqMessage` / `signSiwq` / `verifySiwq`).
 *
 * Why: revoking the agent's linked key (`pnpm owner revoke`) is final, costs a
 * hybrid transaction and needs a new link afterwards. An owner who only wants
 * the agent to hold off (the auction looks wrong, the mandate needs a second
 * thought) needs something instant, free and reversible, and no weaker than
 * the mandate: only the owner's on-chain ML-DSA-87 key may pull it.
 *
 * How: `pnpm agent serve --control-port 8789` answers on 127.0.0.1 only.
 *   GET  /siwq/nonce    a fresh nonce (single use, 10 minutes)
 *   POST /siwq/control  { message, signature }: a SIWQ message from the owner
 *                       whose resources name the action and this agent
 *   GET  /siwq/status   paused or not, since when
 * The agent verifies the sign-in exactly as a server verifies a SIWQ login:
 * its own domain, a nonce it issued and has not seen used, the chain id, a
 * fresh `issuedAt`, the classical signature over the ADR-36 document, and the
 * ML-DSA-87 signature against the key the owner registered on chain (read by
 * the same fail-closed key source that checks mandates: ML-DSA-87, possession
 * proven). A classical-only sign-in is refused, so a stolen secp256k1 key
 * cannot pause or resume the agent.
 *
 * Paused, the agent still opens and records mandates and still claims (a
 * claim only returns the owner's money), but makes no planning round, so it
 * places no bid. The state is kept in `agent/control.json`, so a restart stays
 * paused, and each change is a signed receipt.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseSiwqMessage, verifySiwq, type SiwqFields, type SiwqSignature } from "@qorechain/qoresign";
import type { PqKeySource } from "./keysource.ts";
import type { ReceiptLog } from "./receipts.ts";

export type ControlAction = "pause" | "resume";

/** Resource URIs the owner's message carries: the action, and the agent it is for. */
export const actionResource = (a: ControlAction) => `urn:peal-bidder:control:${a}`;
export const agentResource = (agent: string) => `urn:peal-bidder:agent:${agent}`;

export const NONCE_TTL_SECONDS = 600;
const MAX_OUTSTANDING_NONCES = 32;

export interface ControlState {
  paused: boolean;
  /** Unix seconds of the last change, or null if never changed. */
  since: number | null;
}

export class ControlError extends Error {
  constructor(
    readonly code:
      | "MALFORMED"
      | "NOT_OWNER"
      | "WRONG_AGENT"
      | "UNKNOWN_ACTION"
      | "NONCE_UNKNOWN"
      | "OWNER_KEY_UNAVAILABLE"
      | "SIGN_IN_INVALID",
    message: string,
  ) {
    super(message);
  }
}

export interface OwnerControlOptions {
  /** The owner the agent serves (qor1). */
  owner: string;
  /** This agent's address (qor1). */
  agent: string;
  chainId: string;
  /** The authority the owner signs in to, e.g. `127.0.0.1:8789`. */
  domain: string;
  /** Where the owner's ML-DSA-87 key comes from: the chain (`pqcKeyStatus`), as for mandates. */
  keys: PqKeySource;
  /** Where the state is kept; omitted: memory only. */
  statePath?: string;
  receipts?: ReceiptLog;
  now?: () => number;
}

/** The saved state; anything unreadable as "not paused" reads as paused (fail closed). */
export function readControlState(path: string): ControlState {
  if (!existsSync(path)) return { paused: false, since: null };
  let saved: Partial<ControlState> = {};
  try {
    saved = JSON.parse(readFileSync(path, "utf8")) as Partial<ControlState>;
  } catch {
    // unreadable: paused
  }
  return { paused: saved.paused !== false, since: typeof saved.since === "number" ? saved.since : null };
}

export class OwnerControl {
  private readonly nonces = new Map<string, number>();
  private s: ControlState = { paused: false, since: null };
  private readonly now: () => number;

  constructor(private readonly o: OwnerControlOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    if (o.statePath) this.s = readControlState(o.statePath);
  }

  get state(): ControlState {
    return { ...this.s };
  }

  get paused(): boolean {
    return this.s.paused;
  }

  /** A fresh nonce for one sign-in: 24 alphanumeric characters, single use, valid for 10 minutes. */
  issueNonce(): string {
    const t = this.now();
    for (const [n, exp] of this.nonces) if (exp <= t) this.nonces.delete(n);
    while (this.nonces.size >= MAX_OUTSTANDING_NONCES) this.nonces.delete(this.nonces.keys().next().value as string);
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const nonce = [...randomBytes(24)].map((b) => alphabet[b % alphabet.length]).join("");
    this.nonces.set(nonce, t + NONCE_TTL_SECONDS);
    return nonce;
  }

  /** Check the owner's signed message and apply it. Throws `ControlError`; the nonce is spent either way. */
  async apply(message: string, signature: SiwqSignature): Promise<ControlState & { action: ControlAction }> {
    if (typeof message !== "string" || message.length > 4096 || typeof signature !== "object" || signature === null) {
      throw new ControlError("MALFORMED", "expected { message, signature }");
    }
    let claimed: SiwqFields;
    try {
      claimed = parseSiwqMessage(message);
    } catch (err) {
      throw new ControlError("MALFORMED", `not a Sign In With QoreChain message: ${(err as Error).message}`);
    }
    const nonce = claimed.nonce;
    const exp = this.nonces.get(nonce);
    if (exp === undefined || exp <= this.now()) {
      throw new ControlError("NONCE_UNKNOWN", "the nonce was not issued by this agent, was used already, or expired");
    }
    this.nonces.delete(nonce);
    if (claimed.address !== this.o.owner) throw new ControlError("NOT_OWNER", "only the owner this agent serves may pause or resume it");
    let pqPublicKey: Uint8Array;
    try {
      pqPublicKey = await this.o.keys.pqPublicKey(this.o.owner);
    } catch (err) {
      throw new ControlError("OWNER_KEY_UNAVAILABLE", `the owner's ML-DSA-87 key could not be read: ${(err as Error).message}`);
    }
    let fields: SiwqFields;
    try {
      fields = verifySiwq({
        message,
        signature,
        domain: this.o.domain,
        nonce,
        chainId: this.o.chainId,
        pqPublicKey,
        requirePq: true,
        now: new Date(this.now() * 1000),
      });
    } catch (err) {
      throw new ControlError("SIGN_IN_INVALID", (err as Error).message);
    }
    if (fields.address !== this.o.owner) throw new ControlError("NOT_OWNER", "only the owner this agent serves may pause or resume it");
    const resources = fields.resources ?? [];
    if (!resources.includes(agentResource(this.o.agent))) throw new ControlError("WRONG_AGENT", "the message is for another agent");
    const actions = (["pause", "resume"] as const).filter((a) => resources.includes(actionResource(a)));
    if (actions.length !== 1) throw new ControlError("UNKNOWN_ACTION", "the message must name exactly one of pause or resume");
    const action = actions[0] as ControlAction;
    this.s = { paused: action === "pause", since: this.now() };
    if (this.o.statePath) writeFileSync(this.o.statePath, `${JSON.stringify(this.s)}\n`, { mode: 0o600 });
    this.o.receipts?.append("control", null, { action, owner: this.o.owner, nonce, issuedAt: fields.issuedAt, statement: fields.statement ?? null });
    return { ...this.s, action };
  }
}

async function body(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new ControlError("MALFORMED", "request too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(`${JSON.stringify(value)}\n`);
}

/** The control endpoint, on 127.0.0.1 only. */
export function controlServer(control: OwnerControl): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/siwq/nonce") return send(res, 200, { nonce: control.issueNonce() });
        if (req.method === "GET" && req.url === "/siwq/status") return send(res, 200, control.state);
        if (req.method === "POST" && req.url === "/siwq/control") {
          let parsed: { message?: unknown; signature?: unknown };
          try {
            parsed = JSON.parse(await body(req)) as typeof parsed;
          } catch (err) {
            if (err instanceof ControlError) throw err;
            throw new ControlError("MALFORMED", "not JSON");
          }
          return send(res, 200, await control.apply(parsed.message as string, parsed.signature as SiwqSignature));
        }
        send(res, 404, { error: "not found" });
      } catch (err) {
        if (err instanceof ControlError) return send(res, err.code === "OWNER_KEY_UNAVAILABLE" ? 503 : 403, { error: err.code, message: err.message });
        send(res, 500, { error: "INTERNAL" });
      }
    })();
  });
}
