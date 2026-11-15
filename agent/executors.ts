/**
 * Choosing how bids leave the agent:
 *
 * - `dry-run` (default): nothing is sent; the decision is recorded and counted.
 * - `smart-account`: `MsgExecuteEVM` signed with the agent's linked key, sent
 *   through the relayer; the call runs from the owner's account under the
 *   owner's spending rule. Unproven until spike S2.
 * - `window`: the fallback (design R1); the agent's own account sends
 *   `commitBid` inside a window the owner opened.
 */
import { parseAddress } from "@qorechain/qoresign";
import { fetchAuthNonce, resolveEvmAuthDigestVersion } from "@qorechain/sdk";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Network } from "../common/network.ts";
import { DryRunExecutor, type BidExecutor } from "./agent.ts";
import { SealedBidEncoder } from "./bid-encoder.ts";
import type { AgentIdentity } from "./identity.ts";
import { HttpRelayClient, SmartAccountExecutor, type CallSender } from "./smart-account-executor.ts";
import { WindowExecutor, restWindow } from "./window-executor.ts";

export type ExecutorKind = "dry-run" | "smart-account" | "window";

/** EIP-1559 fee caps: the testnet answers eth_gasPrice with 112.5 gwei (qore-pq-kit `evm.ts`). */
const MAX_FEE_PER_GAS = 200_000_000_000n;
const MAX_PRIORITY_FEE_PER_GAS = 12_500_000_000n;

/** Whose account sends the commit (and so is `msg.sender`, the bidder): the owner's, or the agent's own. */
export function bidderFor(kind: ExecutorKind, id: AgentIdentity): Address {
  return (kind === "window" ? id.account.evm : parseAddress(id.account.owner).hex) as Address;
}

export async function makeExecutor(
  kind: ExecutorKind,
  ctx: { id: AgentIdentity; net: Network; relayerUrl?: string; gasLimit?: bigint },
): Promise<BidExecutor & Partial<CallSender>> {
  if (kind === "dry-run") return new DryRunExecutor();
  const { id, net } = ctx;
  const evmChain = {
    id: net.evmChainId,
    name: "QoreChain Testnet",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [net.evmRpc] } },
  } as const;
  const client = createPublicClient({ chain: evmChain, transport: http(net.evmRpc) });
  const ownerEvm = parseAddress(id.account.owner).hex as Address;

  if (kind === "smart-account") {
    const relay = new HttpRelayClient(ctx.relayerUrl);
    const health = (await (await fetch(`${ctx.relayerUrl ?? "http://127.0.0.1:8787"}/health`)).json()) as { relayer: string; account: string };
    if (health.account !== id.account.owner) throw new Error("the relayer serves another owner");
    const encoder = new SealedBidEncoder({
      client,
      rest: net.rest,
      evmChainId: net.evmChainId,
      sealChainId: net.chainId,
      bidder: ownerEvm,
      ...(ctx.gasLimit ? { gasLimit: ctx.gasLimit } : {}),
    });
    return new SmartAccountExecutor({
      privateKey: id.account.privateKey,
      chainId: net.chainId,
      owner: id.account.owner,
      relayer: health.relayer,
      encoder,
      relay,
      authNonce: async () => (await fetchAuthNonce({ rest: net.rest, address: id.account.owner, pubkey: id.account.evm })).nonce,
      digestVersion: () => resolveEvmAuthDigestVersion({ rest: net.rest }),
    });
  }

  const account = privateKeyToAccount(id.account.privateKey);
  const wallet = createWalletClient({ account, chain: evmChain, transport: http(net.evmRpc) });
  const encoder = new SealedBidEncoder({
    client,
    rest: net.rest,
    evmChainId: net.evmChainId,
    sealChainId: net.chainId,
    bidder: account.address,
    ...(ctx.gasLimit ? { gasLimit: ctx.gasLimit } : {}),
  });
  return new WindowExecutor({
    encoder,
    window: restWindow(net.rest, id.account.cosmos),
    send: (tx) =>
      wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        gas: tx.gas,
        maxFeePerGas: MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
      }) as Promise<Hex>,
    wait: async (hash) => (await client.waitForTransactionReceipt({ hash, timeout: 120_000 })).status,
  });
}
