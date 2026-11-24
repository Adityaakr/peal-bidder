/**
 * Choosing how bids leave the agent:
 *
 * - `dry-run` (default): nothing is sent; the decision is recorded and counted.
 * - `smart-account`: `MsgExecuteEVM` signed with the agent's linked key, sent
 *   through the relayer; the call runs from the owner's account under the
 *   owner's spending rule. Proven by spike S2; the default for live runs.
 * - `window`: the fallback from design R1, retired by S2 and kept for
 *   comparison; the agent's own account sends
 *   `commitBid` inside a window the owner opened.
 *
 * Both live kinds can bid through the owner's vault (`--vault 0x…`, `vault.ts`):
 * the vault is then the bidder, and the account only calls `vault.bid`.
 */
import { parseAddress } from "@qorechain/qoresign";
import { fetchAuthNonce, resolveEvmAuthDigestVersion } from "@qorechain/sdk";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PEAL_REGISTRY_FROM_BLOCK, type Network } from "../common/network.ts";
import { DryRunExecutor, type BidExecutor } from "./agent.ts";
import { SealedBidEncoder } from "./bid-encoder.ts";
import type { AgentIdentity } from "./identity.ts";
import { HttpRelayClient, SmartAccountExecutor, type CallSender } from "./smart-account-executor.ts";
import { VaultBidEncoder } from "./vault.ts";
import { WindowExecutor, restWindow } from "./window-executor.ts";

export type ExecutorKind = "dry-run" | "smart-account" | "window";

/** EIP-1559 fee caps: the testnet answers eth_gasPrice with 112.5 gwei (qore-pq-kit `evm.ts`). */
const MAX_FEE_PER_GAS = 200_000_000_000n;
const MAX_PRIORITY_FEE_PER_GAS = 12_500_000_000n;

/** Which account makes the call: the owner's (through the linked key), or the agent's own. */
export function senderFor(kind: ExecutorKind, id: AgentIdentity): Address {
  return (kind === "window" ? id.account.evm : parseAddress(id.account.owner).hex) as Address;
}

/** The auction's bidder (`msg.sender` of the commit): the vault when there is one, else the calling account. */
export function bidderFor(kind: ExecutorKind, id: AgentIdentity, vault?: Address): Address {
  return vault ?? senderFor(kind, id);
}

export async function makeExecutor(
  kind: ExecutorKind,
  ctx: { id: AgentIdentity; net: Network; relayerUrl?: string; gasLimit?: bigint; vault?: Address },
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
  const bidder = bidderFor(kind, id, ctx.vault);
  const sealed = new SealedBidEncoder({
    client,
    rest: net.rest,
    evmChainId: net.evmChainId,
    sealChainId: net.chainId,
    bidder,
    fromBlock: PEAL_REGISTRY_FROM_BLOCK,
    ...(ctx.gasLimit ? { gasLimit: ctx.gasLimit } : {}),
  });
  const encoder = ctx.vault ? new VaultBidEncoder({ inner: sealed, vault: ctx.vault, operator: senderFor(kind, id), client }) : sealed;
  const vault = ctx.vault ? { vault: ctx.vault } : {};

  if (kind === "smart-account") {
    const relay = new HttpRelayClient(ctx.relayerUrl);
    const health = (await (await fetch(`${ctx.relayerUrl ?? "http://127.0.0.1:8787"}/health`)).json()) as { relayer: string; account: string };
    if (health.account !== id.account.owner) throw new Error("the relayer serves another owner");
    return new SmartAccountExecutor({
      privateKey: id.account.privateKey,
      chainId: net.chainId,
      owner: id.account.owner,
      relayer: health.relayer,
      ...vault,
      encoder,
      relay,
      authNonce: async () => (await fetchAuthNonce({ rest: net.rest, address: id.account.owner, pubkey: id.account.evm })).nonce,
      digestVersion: () => resolveEvmAuthDigestVersion({ rest: net.rest }),
    });
  }

  const account = privateKeyToAccount(id.account.privateKey);
  const wallet = createWalletClient({ account, chain: evmChain, transport: http(net.evmRpc) });
  return new WindowExecutor({
    ...vault,
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
