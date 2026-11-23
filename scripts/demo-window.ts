/**
 * The agent's own scoped EVM window on the testnet: what the chain lets the
 * agent account's classical key do inside a window the owner opened, and what
 * it refuses (target, transaction count, value, duration).
 *
 *   pnpm demo:window [--wait-blocks 40]
 *
 * The owner opens each window with the agent account's ML-DSA-87 key (held in
 * `owner/`); the agent sends with its classical key only (from `agent/`), as an
 * attacker holding that key would. Every call is harmless: `approve(factory, 0)`
 * on fUSD from the agent account, which holds no fUSD, and a read-only function
 * of the auction factory sent as a transaction. Written to owner/outbox/demo-window-<time>.json.
 *
 * Scenes:
 *   1. window A: target fUSD, 1 transaction. The in-target call lands.
 *   2. a call to the factory, which window A does not list: refused.
 *   3. a second in-target call: refused, window A's one transaction is used.
 *   4. window B: target fUSD, 2 transactions, a short duration. A call carrying
 *      more QOR than the window's value limit: refused.
 *   5. after window B's last block: an in-target call is refused.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchEvmWindow } from "@qorechain/sdk";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseEther, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountAddress, loadAccount } from "../common/accounts.ts";
import { int, main, out, parseFlags } from "../common/cli.ts";
import { agentPaths, bidderHome, ownerPaths } from "../common/home.ts";
import { FUSD, network } from "../common/network.ts";
import { loadAgentIdentity } from "../agent/identity.ts";
import { closeWindow, openWindow, windowMaxValue, type WindowOptions } from "../owner-cli/chain.ts";

const FACTORY = "0x1160ab95b570a65bbadb488c76e2f8515f3d6562" as Hex;

interface Attempt {
  scene: string;
  to: string;
  valueWei: string;
  result: "landed" | "reverted" | "refused";
  txHash?: string;
  block?: string;
  reason?: string;
}

async function run(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(2));
  const net = network();
  const home = bidderHome();
  const op = ownerPaths(home);
  const id = loadAgentIdentity(agentPaths(home));
  const agentAccountFull = await loadAccount(op.agentAccount);
  const agentAcc = accountAddress(op.agentAccount);
  if (agentAcc.cosmos !== id.account.cosmos) throw new Error("agent/ and owner/ name different agent accounts");

  const chain = { id: net.evmChainId, name: "QoreChain Testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [net.evmRpc] } } } as const;
  const client = createPublicClient({ chain, transport: http(net.evmRpc) });
  const wallet = createWalletClient({ account: privateKeyToAccount(id.account.privateKey), chain, transport: http(net.evmRpc) });

  const approveZero = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FACTORY, 0n] });
  const readOnly = toFunctionSelector("auctionCount()");

  const attempt = async (scene: string, to: Hex, data: Hex, value = 0n): Promise<Attempt> => {
    const base = { scene, to, valueWei: value.toString() };
    try {
      const hash = await wallet.sendTransaction({ to, data, value, gas: 100_000n, maxFeePerGas: 200_000_000_000n, maxPriorityFeePerGas: 12_500_000_000n });
      const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return { ...base, result: r.status === "success" ? "landed" : "reverted", txHash: hash, block: r.blockNumber.toString() };
    } catch (err) {
      // The first line of the node's answer only: it carries the reason, never a key.
      const e = err as { details?: string; shortMessage?: string; message: string };
      return { ...base, result: "refused", reason: (e.details ?? e.shortMessage ?? e.message).split("\n")[0]!.slice(0, 300) };
    }
  };
  const windowState = async () => {
    const w = await fetchEvmWindow({ rest: net.rest, address: agentAcc.cosmos });
    return { found: w.found, live: w.live, remainingTxs: w.remainingTxs?.toString(), allowedTargets: w.allowedTargets, raw: w };
  };

  const results: Record<string, unknown> = { agentAccount: agentAcc.cosmos, agentEvm: agentAcc.evm, startedAt: new Date().toISOString() };
  if ((await windowState()).found) results.closedStale = await closeWindow(agentAccountFull);

  const a: WindowOptions = { targets: [FUSD], blocks: 300, maxTxs: 1, gasPerTx: 100_000n };
  results.windowA = { ...(await openWindow(agentAccountFull, a)), maxValueUqor: windowMaxValue(a).toString() };
  const attempts: Attempt[] = [];
  attempts.push(await attempt("1: in target, inside window A", FUSD as Hex, approveZero));
  attempts.push(await attempt("2: off target (the factory)", FACTORY, readOnly));
  attempts.push(await attempt("3: in target, window A's one transaction used", FUSD as Hex, approveZero));
  results.windowAAfter = await windowState();
  const closedA = await closeWindow(agentAccountFull);
  if (closedA) results.windowAClosed = closedA;

  const waitBlocks = int(flags, "wait-blocks", 40);
  const b: WindowOptions = { targets: [FUSD], blocks: waitBlocks, maxTxs: 2, gasPerTx: 100_000n };
  const openedB = await openWindow(agentAccountFull, b);
  const openedAt = await client.getBlockNumber();
  results.windowB = { ...openedB, maxValueUqor: windowMaxValue(b).toString(), openedNearBlock: openedAt.toString() };
  attempts.push(await attempt("4: value over window B's limit", FUSD as Hex, approveZero, parseEther("1")));
  // Wait past the window's last block.
  for (;;) {
    const h = await client.getBlockNumber();
    if (h > openedAt + BigInt(waitBlocks) + 3n) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  results.windowBBeforeExpiredCall = await windowState();
  attempts.push(await attempt("5: in target, after window B expired", FUSD as Hex, approveZero));
  results.attempts = attempts;
  results.windowEnd = await windowState();
  results.finishedAt = new Date().toISOString();

  mkdirSync(op.outbox, { recursive: true, mode: 0o700 });
  const file = join(op.outbox, `demo-window-${Date.now()}.json`);
  const json = JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(file, `${json}\n`);
  out({ file, results: JSON.parse(json) });
}

await main(run);
