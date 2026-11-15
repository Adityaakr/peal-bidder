/**
 * The fallback path (design section 9, R1): the agent sends `commitBid` from
 * its OWN account, inside an EVM window the owner opened for it.
 *
 * Used if spike S2 shows the smart-account path does not work. The chain
 * limits are then: the window (targets: the auction only; transaction count;
 * value; duration), the fUSD the owner put on the agent's account and the
 * allowance the owner set from it, and the auction's own caps. The agent can
 * open no window itself: that needs the agent account's ML-DSA-87 key, which
 * the owner holds.
 */
import { fetchEvmWindow } from "@qorechain/sdk";
import type { Hex } from "viem";
import type { PealMandateV1 } from "../common/mandate.ts";
import type { BidDecision, BidExecutor, SubmitResult } from "./agent.ts";
import type { BidEncoder, CallSender, EncodedBid } from "./smart-account-executor.ts";

export interface WindowView {
  live: boolean;
  remainingTxs: bigint;
  allowedTargets: string[];
}

export interface WindowExecutorDeps {
  encoder: BidEncoder;
  /** The agent account's window, as the chain reports it. */
  window: () => Promise<WindowView>;
  /** Sign and send one EVM transaction from the agent's account; returns its hash. */
  send: (tx: { to: Hex; data: Hex; gas: bigint }) => Promise<Hex>;
  /** Wait for the receipt. Throws on timeout. */
  wait: (hash: Hex) => Promise<"success" | "reverted">;
}

/** Errors that leave it open whether the transaction reached the chain. */
const MAYBE_SENT = /timeout|timed out|ECONNRESET|socket hang up|fetch failed|network|ETIMEDOUT|EPIPE/i;

export class WindowExecutor implements BidExecutor, CallSender {
  constructor(private readonly deps: WindowExecutorDeps) {}

  private async windowRefusal(target: string): Promise<SubmitResult | undefined> {
    let w: WindowView;
    try {
      w = await this.deps.window();
    } catch (err) {
      return { status: "refused", reason: `not sent: the window cannot be read (${(err as Error).message})` };
    }
    if (!w.live || w.remainingTxs <= 0n) return { status: "refused", reason: "not sent: no live window (the owner opens it)" };
    if (!w.allowedTargets.map((t) => t.toLowerCase()).includes(target.toLowerCase())) {
      return { status: "refused", reason: "not sent: the window does not admit this contract" };
    }
    return undefined;
  }

  async submit(decision: BidDecision, mandate: PealMandateV1): Promise<SubmitResult> {
    const refused = await this.windowRefusal(decision.auction);
    if (refused) return refused;
    let tx: EncodedBid;
    try {
      tx = await this.deps.encoder.encode(decision, mandate);
    } catch (err) {
      return { status: "refused", reason: `not sent: ${(err as Error).message}` };
    }
    return this.send(tx);
  }

  /** Any other call from the agent's own account (for example `claim`), inside the window. */
  async sendCall(call: EncodedBid): Promise<SubmitResult> {
    const refused = await this.windowRefusal(call.to);
    if (refused) return refused;
    return this.send(call);
  }

  private async send(tx: EncodedBid): Promise<SubmitResult> {
    let hash: Hex;
    try {
      hash = await this.deps.send({ to: tx.to, data: tx.data, gas: tx.gasLimit });
    } catch (err) {
      const message = (err as Error).message;
      return MAYBE_SENT.test(message) ? { status: "unknown", reason: message } : { status: "refused", reason: message };
    }
    try {
      const status = await this.deps.wait(hash);
      return status === "success" ? { status: "landed", txHash: hash } : { status: "refused", txHash: hash, reason: "the call reverted" };
    } catch (err) {
      return { status: "unknown", txHash: hash, reason: `no receipt yet: ${(err as Error).message}` };
    }
  }
}

/** The window as the SDK reads it over REST. */
export function restWindow(rest: string, address: string): () => Promise<WindowView> {
  return async () => {
    const w = await fetchEvmWindow({ rest, address });
    return { live: w.found && w.live, remainingTxs: w.remainingTxs, allowedTargets: w.allowedTargets ?? [] };
  };
}
