/**
 * Submitting a bid through the owner's smart account: the agent signs a
 * `MsgExecuteEVM` with its linked key, and the relayer broadcasts it. The
 * chain runs the call from the OWNER's account, after checking the agent's
 * signature, the key's expiry and the owner's spending rule. Without a vault the
 * rule is fUSD only, per-bid and daily limits, only `commitBid` and `claim` on the
 * mandate's auctions; with one (`vault.ts`) it lists no token the account holds
 * and only `vault.bid` and `claim`.
 *
 * Proven by spike S2 (qore-pq-kit docs/spikes.md); signing comes from the
 * kit's `smart-account` module. The bid's calldata comes from a `BidEncoder`
 * (`bid-encoder.ts`).
 */
import type { EncodeObject, EvmAuthDigestVersion } from "@qorechain/sdk";
import { buildAgentCall } from "qore-pq-kit/smart-account";
import type { Address, Hex } from "viem";
import type { PealMandateV1 } from "../common/mandate.ts";
import { encodeExecuteEvmWire, type RelayOutcome } from "../relayer/relayer.ts";
import type { BidDecision, BidExecutor, SubmitResult } from "./agent.ts";
import { assertBidTarget } from "./vault.ts";

export interface EncodedBid {
  to: Hex;
  data: Hex;
  gasLimit: bigint;
}

/** Something that can send one contract call for the agent (both executors are). */
export interface CallSender {
  sendCall(call: EncodedBid): Promise<SubmitResult>;
}

/** Turns a clamped decision into the auction call (seal to the committee, encode `commitBid`). */
export interface BidEncoder {
  encode(decision: BidDecision, mandate: PealMandateV1): Promise<EncodedBid>;
}

export interface RelayClient {
  relay(m: EncodeObject): Promise<RelayOutcome>;
}

/** Talks to `pnpm relayer` on this machine. */
export class HttpRelayClient implements RelayClient {
  constructor(private readonly url = "http://127.0.0.1:8787") {}
  async relay(m: EncodeObject): Promise<RelayOutcome> {
    const res = await fetch(`${this.url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg: encodeExecuteEvmWire(m) }),
    });
    const body = (await res.json()) as RelayOutcome | { error: string };
    if (!res.ok || "error" in body) throw new Error(`relayer: ${"error" in body ? body.error : res.status}`);
    return body;
  }
}

export interface SmartAccountExecutorDeps {
  privateKey: Hex;
  chainId: string;
  /** The owner's `qor1` account, which the agent's key acts for. */
  owner: string;
  /** The relayer's `qor1` address (named inside the signed message). */
  relayer: string;
  encoder: BidEncoder;
  /** When bids go through the owner's vault: the only contract a bid may target. */
  vault?: Address;
  relay: RelayClient;
  /** The linked key's own sequence (SDK `fetchAuthNonce`), not the account's EVM nonce. */
  authNonce: () => Promise<bigint>;
  /** Which digest the chain verifies now (SDK `resolveEvmAuthDigestVersion`); never guessed. */
  digestVersion: () => Promise<EvmAuthDigestVersion>;
}

export class SmartAccountExecutor implements BidExecutor, CallSender {
  constructor(private readonly deps: SmartAccountExecutorDeps) {
  }

  /** Build and sign the message; exposed for tests and for inspection before sending. */
  async build(decision: BidDecision, mandate: PealMandateV1): Promise<EncodeObject> {
    const bid = await this.deps.encoder.encode(decision, mandate);
    assertBidTarget(bid, decision, this.deps.vault);
    return this.sign(bid);
  }

  /** Sign one call with the linked key (qore-pq-kit `buildAgentCall`: EIP-191 over the chain's EVM auth digest). */
  async sign(bid: EncodedBid): Promise<EncodeObject> {
    return buildAgentCall({
      // The nonce and digest version are passed in, so the kit never needs the REST endpoint here.
      rest: "",
      chainId: this.deps.chainId,
      owner: this.deps.owner,
      relayer: this.deps.relayer,
      agentPrivateKey: this.deps.privateKey,
      to: bid.to,
      data: bid.data,
      value: 0n,
      gasLimit: bid.gasLimit,
      nonce: await this.deps.authNonce(),
      digestVersion: await this.deps.digestVersion(),
    });
  }

  async submit(decision: BidDecision, mandate: PealMandateV1): Promise<SubmitResult> {
    let m: EncodeObject;
    try {
      m = await this.build(decision, mandate);
    } catch (err) {
      // Nothing was signed for the chain yet: nothing can have executed.
      return { status: "refused", reason: `not sent: ${(err as Error).message}` };
    }
    return this.relay(m);
  }

  /** Any other call through the owner's account (for example `claim`), under the same spending rule. */
  async sendCall(call: EncodedBid): Promise<SubmitResult> {
    let m: EncodeObject;
    try {
      m = await this.sign(call);
    } catch (err) {
      return { status: "refused", reason: `not sent: ${(err as Error).message}` };
    }
    return this.relay(m);
  }

  private async relay(m: EncodeObject): Promise<SubmitResult> {
    const r = await this.deps.relay.relay(m);
    return { status: r.status, ...(r.txHash ? { txHash: r.txHash } : {}), ...(r.reason ? { reason: r.reason } : {}) };
  }
}
