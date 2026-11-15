/**
 * Where the agent gets the owner's ML-DSA-87 key: from the chain.
 *
 * `ChainPqKeySource` asks the `pqcKeyStatus` precompile through `eth_call`,
 * the same truth the contracts see. It fails closed: no key, another
 * algorithm, an unproven key, a wrong length, empty return data or an RPC
 * error all refuse.
 */
import { parseAddress } from "@qorechain/qoresign";
import { decodeFunctionResult, encodeFunctionData, hexToBytes, type Hex, type PublicClient } from "viem";
import { PQC_KEY_STATUS } from "../common/network.ts";

export const ML_DSA_87_ALGORITHM_ID = 1;
export const ML_DSA_87_PUBLIC_KEY_LENGTH = 2592;

/**
 * The live precompile returns four words: (registered, algorithm, key, possession proven).
 * The SDK's published ABI lists only three; the fourth was observed live (design report, Appendix A).
 */
export const PQC_KEY_STATUS_ABI = [
  {
    type: "function",
    name: "pqcKeyStatus",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "algorithm", type: "uint8" },
      { name: "publicKey", type: "bytes" },
      { name: "possessionProven", type: "bool" },
    ],
  },
] as const;

export type KeyErrorCode = "KEY_NOT_REGISTERED" | "KEY_WRONG_ALGORITHM" | "KEY_NOT_PROVEN" | "KEY_BAD_LENGTH" | "KEY_UNAVAILABLE";

export class PqKeyError extends Error {
  override name = "PqKeyError";
  constructor(
    readonly code: KeyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PqKeySource {
  /** The ML-DSA-87 public key registered for `address` (`qor1` or `0x`). Throws `PqKeyError`. */
  pqPublicKey(address: string): Promise<Uint8Array>;
}

/** Check a decoded `pqcKeyStatus` result and return the key. */
export function checkKeyStatus(status: {
  registered: boolean;
  algorithm: number;
  publicKey: Uint8Array;
  possessionProven: boolean;
}): Uint8Array {
  if (!status.registered) throw new PqKeyError("KEY_NOT_REGISTERED", "no ML-DSA-87 key is registered for the account");
  if (status.algorithm !== ML_DSA_87_ALGORITHM_ID) {
    throw new PqKeyError("KEY_WRONG_ALGORITHM", `the registered key uses algorithm ${status.algorithm}, not ML-DSA-87`);
  }
  if (!status.possessionProven) throw new PqKeyError("KEY_NOT_PROVEN", "possession of the registered key is not proven");
  if (status.publicKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH) {
    throw new PqKeyError("KEY_BAD_LENGTH", `the registered key is ${status.publicKey.length} bytes, not 2592`);
  }
  return status.publicKey;
}

export class ChainPqKeySource implements PqKeySource {
  constructor(private readonly client: Pick<PublicClient, "call">) {}

  async pqPublicKey(address: string): Promise<Uint8Array> {
    let hex: Hex;
    try {
      hex = parseAddress(address).hex as Hex;
    } catch {
      throw new PqKeyError("KEY_UNAVAILABLE", `not an address: ${address}`);
    }
    let data: Hex | undefined;
    try {
      const res = await this.client.call({
        to: PQC_KEY_STATUS,
        data: encodeFunctionData({ abi: PQC_KEY_STATUS_ABI, functionName: "pqcKeyStatus", args: [hex] }),
      });
      data = res.data;
    } catch (err) {
      throw new PqKeyError("KEY_UNAVAILABLE", `pqcKeyStatus call failed: ${(err as Error).message}`);
    }
    if (!data || data === "0x") throw new PqKeyError("KEY_UNAVAILABLE", "pqcKeyStatus returned no data");
    let decoded: readonly [boolean, number, Hex, boolean];
    try {
      decoded = decodeFunctionResult({ abi: PQC_KEY_STATUS_ABI, functionName: "pqcKeyStatus", data });
    } catch (err) {
      throw new PqKeyError("KEY_UNAVAILABLE", `pqcKeyStatus returned malformed data: ${(err as Error).message}`);
    }
    const [registered, algorithm, publicKey, possessionProven] = decoded;
    return checkKeyStatus({ registered, algorithm, publicKey: hexToBytes(publicKey), possessionProven });
  }
}

/** A fixed key per address, for tests and for local runs against mocks. */
export class StaticPqKeySource implements PqKeySource {
  private readonly keys = new Map<string, Uint8Array>();

  set(address: string, publicKey: Uint8Array): this {
    this.keys.set(parseAddress(address).hex.toLowerCase(), publicKey);
    return this;
  }

  async pqPublicKey(address: string): Promise<Uint8Array> {
    let key: Uint8Array | undefined;
    try {
      key = this.keys.get(parseAddress(address).hex.toLowerCase());
    } catch {
      throw new PqKeyError("KEY_UNAVAILABLE", `not an address: ${address}`);
    }
    if (!key) throw new PqKeyError("KEY_NOT_REGISTERED", "no ML-DSA-87 key is registered for the account");
    return key;
  }
}
