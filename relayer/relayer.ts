/**
 * The relayer: broadcasts the agent's signed `MsgExecuteEVM` and reports what
 * the chain did with it. It holds only gas (its own account pays the fee and
 * signs the outer transaction, hybrid); the authority is the agent's linked-key
 * signature inside the message, which the chain checks against the owner's
 * spending rule.
 *
 * It refuses, before spending gas, anything that is not a `MsgExecuteEVM` for
 * the configured owner account, naming this relayer, to an allowed target,
 * with a sane gas limit. It cannot change the message: the signature covers
 * the target, value, data, nonce and (digest v2) gas limit.
 *
 * NOT YET PROVEN END TO END: see spike S2 in docs/spikes.md.
 */
import { decodeAuthenticatorExecutions, qorechainTypes, type BroadcastResult, type EncodeObject } from "@qorechain/sdk";

export const EXECUTE_EVM_TYPE_URL = "/qorechain.abstractaccount.v1.MsgExecuteEVM";
const { MsgExecuteEVM } = qorechainTypes.abstractaccount;
export type ExecuteEvm = ReturnType<typeof MsgExecuteEVM.fromPartial>;

export interface RelayPolicy {
  /** This relayer's `qor1` address. */
  relayer: string;
  /** The owner account the agent's key acts for. */
  account: string;
  /** Lower-case 0x targets the relayer will pay for (the auctions). */
  targets: string[];
  /** Largest gas limit the relayer will provision. */
  maxGas: bigint;
}

/** What happened: `landed` and `refused` are final; `unknown` means it may have executed. */
export interface RelayOutcome {
  status: "landed" | "refused" | "unknown";
  txHash?: string;
  reason?: string;
  gasUsed?: string;
}

/** Sends one hybrid-signed transaction from the relayer's account (qore-pq-kit `broadcast` in production). */
export type Broadcaster = (msgs: EncodeObject[]) => Promise<Pick<BroadcastResult, "transactionHash" | "code" | "rawLog" | "msgResponses" | "events">>;

export function decodeExecuteEvm(m: EncodeObject): ExecuteEvm {
  if (m.typeUrl !== EXECUTE_EVM_TYPE_URL) throw new Error(`not a MsgExecuteEVM: ${m.typeUrl}`);
  return MsgExecuteEVM.fromPartial(m.value as object);
}

/** The policy check. Returns the reason to refuse, or undefined. */
export function checkRelayable(m: EncodeObject, policy: RelayPolicy): string | undefined {
  let x: ExecuteEvm;
  try {
    x = decodeExecuteEvm(m);
  } catch (err) {
    return (err as Error).message;
  }
  if (x.relayer !== policy.relayer) return "the message names another relayer";
  if (x.account !== policy.account) return "the message acts for another account";
  if (x.scheme !== "secp256k1") return `unexpected key scheme ${x.scheme}`;
  if (!policy.targets.includes(x.to.toLowerCase())) return `target ${x.to || "(contract creation)"} is not allowed`;
  if (x.value !== "" && x.value !== "0") return "the relayer does not relay native value";
  const gas = BigInt(x.gasLimit.toString());
  if (gas === 0n || gas > policy.maxGas) return `gas limit ${gas} is outside (0, ${policy.maxGas}]`;
  return undefined;
}

/** The chain refused the whole transaction (non-zero code): nothing executed. */
const CODE_FAILURE = /failed with code (\d+)/;

export class Relayer {
  constructor(
    private readonly policy: RelayPolicy,
    private readonly send: Broadcaster,
  ) {}

  async relay(m: EncodeObject): Promise<RelayOutcome> {
    const refusal = checkRelayable(m, this.policy);
    if (refusal) return { status: "refused", reason: `relayer: ${refusal}` };
    let res: Awaited<ReturnType<Broadcaster>>;
    try {
      res = await this.send([m]);
    } catch (err) {
      const message = (err as Error).message;
      // A transaction refused with a code did not execute; anything else (timeouts, a dropped
      // connection after broadcast) may have.
      if (CODE_FAILURE.test(message)) return { status: "refused", reason: message };
      return { status: "unknown", reason: message };
    }
    if (res.code !== 0) return { status: "refused", txHash: res.transactionHash, reason: res.rawLog ?? `code ${res.code}` };
    const [exec] = decodeAuthenticatorExecutions(res, [m]);
    if (!exec) return { status: "unknown", txHash: res.transactionHash, reason: "no execution result in the transaction" };
    if (!exec.success) {
      // Final: the chain consumed the key's nonce, so this signature can never be relayed again.
      return {
        status: "refused",
        txHash: res.transactionHash,
        reason: exec.reason || exec.vmError || "success=false",
        gasUsed: exec.gasUsed.toString(),
      };
    }
    return { status: "landed", txHash: res.transactionHash, gasUsed: exec.gasUsed.toString() };
  }
}

/** Wire form of a `MsgExecuteEVM` (protobuf, base64), for the relayer's HTTP endpoint. */
export function encodeExecuteEvmWire(m: EncodeObject): string {
  return Buffer.from(MsgExecuteEVM.encode(decodeExecuteEvm(m)).finish()).toString("base64");
}

export function decodeExecuteEvmWire(b64: string): EncodeObject {
  return { typeUrl: EXECUTE_EVM_TYPE_URL, value: MsgExecuteEVM.decode(new Uint8Array(Buffer.from(b64, "base64"))) };
}
