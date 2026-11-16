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
 * Broadcasting and decoding are qore-pq-kit's `relay` (smart-account module),
 * proven by spike S2: `success = false` in a code-0 transaction is final (the
 * key's nonce is spent), and a replay is refused at delivery while the relayer
 * still pays its fee. What stays here is the relayer's own policy.
 */
import { decodeAuthenticatorExecutions, qorechainTypes, type EncodeObject, type UnifiedAccount } from "@qorechain/sdk";
import { broadcast } from "qore-pq-kit";
import type { RelayOutcome as KitRelayOutcome } from "qore-pq-kit/smart-account";

export const EXECUTE_EVM_TYPE_URL = "/qorechain.abstractaccount.v1.MsgExecuteEVM";
const { MsgExecuteEVM } = qorechainTypes.abstractaccount;
export type ExecuteEvm = ReturnType<typeof MsgExecuteEVM.fromPartial>;

/** The kit's native fee rate: 150,000 uqor for 1,000,000 gas. */
export const UQOR_PER_GAS_NUM = 15n;
export const UQOR_PER_GAS_DEN = 100n;
/** Gas the outer transaction needs on top of the calls' own limits (hybrid signature checks, transaction bytes). */
export const RELAY_OVERHEAD_GAS = 400_000n;
export const MIN_RELAY_GAS = 1_000_000n;

/** Outer gas and fee for relaying `msgs`: the calls' own limits plus overhead (chain v3.2.3 refuses a transaction that provisions less than the call). */
export function relayFee(msgs: EncodeObject[]): { amount: { denom: string; amount: string }[]; gas: string } {
  let inner = 0n;
  for (const m of msgs) inner += BigInt(decodeExecuteEvm(m).gasLimit.toString());
  let gas = inner + RELAY_OVERHEAD_GAS;
  if (gas < MIN_RELAY_GAS) gas = MIN_RELAY_GAS;
  const fee = (gas * UQOR_PER_GAS_NUM + UQOR_PER_GAS_DEN - 1n) / UQOR_PER_GAS_DEN;
  return { amount: [{ denom: "uqor", amount: fee.toString() }], gas: gas.toString() };
}

/**
 * Broadcast from the relayer's account with a fee sized to the calls, then
 * decode every execution: qore-pq-kit `relay`, with the fee as a parameter
 * (the kit's relay always sends 1,000,000 gas, too little for a sealed commit).
 */
export function sizedRelay(relayer: UnifiedAccount): Broadcaster {
  return async (msgs) => {
    try {
      const res = (await broadcast(relayer, msgs, "hybrid", relayFee(msgs))) as unknown as Parameters<typeof decodeAuthenticatorExecutions>[0] & { transactionHash: string };
      return { txHash: res.transactionHash, delivered: true, results: decodeAuthenticatorExecutions(res, msgs) };
    } catch (e) {
      const message = (e as Error).message;
      return { txHash: /transaction ([0-9A-F]{64})/.exec(message)?.[1] ?? "", delivered: false, results: [], error: message };
    }
  };
}

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

/** Broadcasts from the relayer's account and decodes the executions: qore-pq-kit `relay` in production. */
export type Broadcaster = (msgs: EncodeObject[]) => Promise<KitRelayOutcome>;

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

/** The linked key's current sequence on chain (SDK `fetchAuthNonce`). */
export type NonceReader = (account: string, pubkey: Uint8Array) => Promise<bigint>;

export class Relayer {
  constructor(
    private readonly policy: RelayPolicy,
    private readonly send: Broadcaster,
    /** When given, a message whose nonce is not the key's current one is refused before broadcasting (a replay still costs the relayer its fee, spike S2). */
    private readonly nonceOf?: NonceReader,
  ) {}

  async relay(m: EncodeObject): Promise<RelayOutcome> {
    const refusal = checkRelayable(m, this.policy);
    if (refusal) return { status: "refused", reason: `relayer: ${refusal}` };
    if (this.nonceOf) {
      const x = decodeExecuteEvm(m);
      let current: bigint;
      try {
        current = await this.nonceOf(x.account, x.pubkey);
      } catch (err) {
        return { status: "refused", reason: `relayer: the key's nonce cannot be read (${(err as Error).message})` };
      }
      const nonce = BigInt(x.nonce.toString());
      if (nonce !== current) return { status: "refused", reason: `relayer: nonce ${nonce} is not the key's current ${current} (a replay or a stale message)` };
    }
    let res: KitRelayOutcome;
    try {
      res = await this.send([m]);
    } catch (err) {
      return { status: "unknown", reason: (err as Error).message };
    }
    if (!res.delivered) {
      // Refused with a code (a replay, a nonce mismatch): nothing executed. Anything else
      // (a timeout, a dropped connection after broadcast) may have.
      const message = res.error ?? "not delivered";
      return CODE_FAILURE.test(message)
        ? { status: "refused", ...(res.txHash ? { txHash: res.txHash } : {}), reason: message }
        : { status: "unknown", ...(res.txHash ? { txHash: res.txHash } : {}), reason: message };
    }
    const [exec] = res.results;
    if (!exec) return { status: "unknown", txHash: res.txHash, reason: "no execution result in the transaction" };
    if (!exec.success) {
      // Final: the chain consumed the key's nonce, so this signature can never be relayed again.
      return { status: "refused", txHash: res.txHash, reason: exec.reason || exec.vmError || "success=false", gasUsed: exec.gasUsed.toString() };
    }
    return { status: "landed", txHash: res.txHash, gasUsed: exec.gasUsed.toString() };
  }
}

/** Wire form of a `MsgExecuteEVM` (protobuf, base64), for the relayer's HTTP endpoint. */
export function encodeExecuteEvmWire(m: EncodeObject): string {
  return Buffer.from(MsgExecuteEVM.encode(decodeExecuteEvm(m)).finish()).toString("base64");
}

export function decodeExecuteEvmWire(b64: string): EncodeObject {
  return { typeUrl: EXECUTE_EVM_TYPE_URL, value: MsgExecuteEVM.decode(new Uint8Array(Buffer.from(b64, "base64"))) };
}
