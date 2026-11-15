/**
 * Submitting a bid through the owner's smart account: the agent signs a
 * `MsgExecuteEVM` with its linked key, and the relayer broadcasts it. The
 * chain runs the call from the OWNER's account, after checking the agent's
 * signature, the key's expiry and the owner's spending rule (fUSD only, per-bid
 * and daily limits, only `commitBid` on the mandate's auctions).
 *
 * NOT YET PROVEN END TO END: see spike S2 in docs/spikes.md. The bid's
 * calldata (sealing it to the auction committee and encoding `commitBid`)
 * comes from a `BidEncoder`, written once Peal Sealed Auction's ABI and
 * committee are deployed; until then the agent runs with the dry-run executor.
 */
import { buildMetaMaskExecuteEvm, type EncodeObject, type Eip1193Provider, type EvmAuthDigestVersion } from "@qorechain/sdk";
import { hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PealMandateV1 } from "../common/mandate.ts";
import { encodeExecuteEvmWire, type RelayOutcome } from "../relayer/relayer.ts";
import type { BidDecision, BidExecutor, SubmitResult } from "./agent.ts";

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

/** A minimal EIP-1193 provider over a local key: only `personal_sign`, only for its own address. */
export function localSigner(privateKey: Hex): Eip1193Provider & { address: Hex } {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    async request({ method, params }) {
      if (method !== "personal_sign") throw new Error(`unsupported method ${method}`);
      const [data, address] = params as [Hex, string];
      if (address.toLowerCase() !== account.address.toLowerCase()) throw new Error("personal_sign for another address");
      return account.signMessage({ message: { raw: hexToBytes(data) } });
    },
  };
}

export interface SmartAccountExecutorDeps {
  privateKey: Hex;
  chainId: string;
  /** The owner's `qor1` account, which the agent's key acts for. */
  owner: string;
  /** The relayer's `qor1` address (named inside the signed message). */
  relayer: string;
  encoder: BidEncoder;
  relay: RelayClient;
  /** The linked key's own sequence (SDK `fetchAuthNonce`), not the account's EVM nonce. */
  authNonce: () => Promise<bigint>;
  /** Which digest the chain verifies now (SDK `resolveEvmAuthDigestVersion`); never guessed. */
  digestVersion: () => Promise<EvmAuthDigestVersion>;
}

export class SmartAccountExecutor implements BidExecutor, CallSender {
  private readonly signer: ReturnType<typeof localSigner>;

  constructor(private readonly deps: SmartAccountExecutorDeps) {
    this.signer = localSigner(deps.privateKey);
  }

  /** Build and sign the message; exposed for tests and for inspection before sending. */
  async build(decision: BidDecision, mandate: PealMandateV1): Promise<EncodeObject> {
    const bid = await this.deps.encoder.encode(decision, mandate);
    if (bid.to.toLowerCase() !== decision.auction) throw new Error("the encoder targets another contract than the decision");
    return this.sign(bid);
  }

  /** Sign one call with the linked key. */
  async sign(bid: EncodedBid): Promise<EncodeObject> {
    return buildMetaMaskExecuteEvm({
      provider: this.signer,
      address: this.signer.address,
      relayer: this.deps.relayer,
      chainId: this.deps.chainId,
      account: this.deps.owner,
      to: bid.to,
      value: "0",
      data: hexToBytes(bid.data),
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
