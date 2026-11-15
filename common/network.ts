/**
 * The one network Peal Bidder runs on: QoreChain testnet `qorechain-diana`.
 *
 * Endpoints can be overridden by environment variables (for a local proxy or
 * a local node); the chain ids cannot, because every signature and seal binds
 * them.
 */
import type { Address } from "viem";

export interface Network {
  /** Cosmos chain id, bound into every QoreSign signature and QoreSeal envelope. */
  chainId: string;
  /** EVM chain id, bound into every mandate. */
  evmChainId: number;
  rest: string;
  evmRpc: string;
}

export const TESTNET_CHAIN_ID = "qorechain-diana";
export const TESTNET_EVM_CHAIN_ID = 9800;

export function network(env: Record<string, string | undefined> = process.env): Network {
  const name = env.QORE_NETWORK?.trim() || "testnet";
  if (name !== "testnet") throw new Error(`Peal Bidder runs on the testnet only (QORE_NETWORK=${name})`);
  return {
    chainId: TESTNET_CHAIN_ID,
    evmChainId: TESTNET_EVM_CHAIN_ID,
    rest: env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host",
    evmRpc: env.QORE_EVM_RPC_URL?.trim() || "https://evm-testnet.qore.host",
  };
}

/**
 * QoreChain's PQC precompiles, lower-cased (viem rejects the SDK's mixed-case
 * spelling as a bad EIP-55 checksum).
 */
export const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as Address;
export const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as Address;

/** The fest token fUSD (6 decimals): ERC-20 contract and its bank denomination. */
export const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as Address;
export const FUSD_DECIMALS = 6;
export const FUSD_DENOM = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
