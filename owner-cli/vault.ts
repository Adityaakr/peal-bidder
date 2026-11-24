/**
 * The owner's side of `BidderVault` (contracts/src/BidderVault.sol, NOT AUDITED,
 * testnet only): deploy it, set and revoke its policy, fund it, withdraw.
 *
 * Every control action is an ML-DSA-87 signature by the owner's registered key
 * over qore-pq-kit's `PqAuth` message (chain id, vault, owner, action, nonce,
 * deadline, argument hash). The transaction that carries it authorises nothing,
 * so it is sent from a separate GAS account that never holds a token: its
 * deployment window cannot be scoped, and the owner's account must never have
 * an unscoped window.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchEvmWindow, openEvmWindowMsg, type UnifiedAccount } from "@qorechain/sdk";
import { actionId, balances, broadcast, estimate, network, publicClient, sendEvm, signAuth } from "qore-pq-kit";
import { encodeAbiParameters, encodeDeployData, encodeFunctionData, keccak256, type Abi, type Address, type ContractFunctionArgs, type Hex } from "viem";
import { sealedAuctionAbi } from "../agent/auction-abi.ts";
import { bidderVaultAbi, readVault, type VaultClient, type VaultPolicy, type VaultView } from "../agent/vault.ts";
import { closeWindow, erc20Balance, openWindow, windowMaxValue, type TxOutcome } from "./chain.ts";

/** The contract refuses a deadline over an hour away; stay inside it whatever the clocks say. */
export const SIGNATURE_TTL = 50 * 60;

export interface VaultArtifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  /** Byte ranges of the runtime code that hold immutables, filled in at deployment. */
  immutables: { start: number; length: number }[];
}

export function vaultArtifact(): VaultArtifact {
  return JSON.parse(readFileSync(join(import.meta.dirname, "..", "contracts", "BidderVault.artifact.json"), "utf8")) as VaultArtifact;
}

const isAuctionAbi = [{ type: "function", name: "isAuction", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "bool" }] }] as const;

/** Whether code on chain is the committed artifact's, immutables aside. */
export function sameRuntime(onChain: Hex, a: Pick<VaultArtifact, "deployedBytecode" | "immutables">): boolean {
  const blank = (code: Hex) => {
    const b = Buffer.from(code.slice(2), "hex");
    for (const { start, length } of a.immutables) b.fill(0, start, start + length);
    return b;
  };
  return onChain.length === a.deployedBytecode.length && blank(onChain).equals(blank(a.deployedBytecode));
}

export interface Approval {
  auction: Address;
  configHash: Hex;
}

type AuctionConfig = Awaited<ReturnType<typeof readConfig>>;
function readConfig(client: VaultClient, auction: Address) {
  return client.readContract({ address: auction, abi: sealedAuctionAbi, functionName: "config" });
}

const CONFIG_OUTPUT = (sealedAuctionAbi.find((x) => x.type === "function" && x.name === "config") as { outputs: readonly [{ type: "tuple"; components: readonly { name: string; type: string }[] }] }).outputs;

/** `keccak256(abi.encode(config))`, as the vault computes it. */
export function configHash(c: AuctionConfig): Hex {
  return keccak256(encodeAbiParameters(CONFIG_OUTPUT as never, [c] as never));
}

/** The approvals for these auctions, each checked: made by the factory, paid in the vault's token. */
export async function approvalsFor(client: VaultClient, auctions: Address[], factory: Address, quote: Address): Promise<Approval[]> {
  const out: Approval[] = [];
  for (const auction of auctions) {
    if (!(await client.readContract({ address: factory, abi: isAuctionAbi, functionName: "isAuction", args: [auction] }))) throw new Error(`${auction} is not one of the factory's auctions`);
    const c = await readConfig(client, auction);
    if (c.quoteToken.toLowerCase() !== quote.toLowerCase()) throw new Error(`${auction} is paid in another token`);
    out.push({ auction, configHash: configHash(c) });
  }
  return out;
}

const POLICY_INPUTS = (bidderVaultAbi.find((x) => x.type === "function" && x.name === "setPolicy") as { inputs: readonly unknown[] }).inputs.slice(0, 2);

export function policyArgsHash(p: VaultPolicy, approvals: Approval[]): Hex {
  return keccak256(encodeAbiParameters(POLICY_INPUTS as never, [p, approvals] as never));
}

export function sweepArgsHash(token: Address, amount: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, amount]));
}

export type VaultAction = "setPolicy" | "revoke" | "sweep";

/** The owner's signature for one action, checked locally before it is returned. */
export function signVaultAction(args: {
  owner: Pick<UnifiedAccount, "evm" | "pqc">;
  vault: Address;
  action: VaultAction;
  nonce: bigint;
  deadline: bigint;
  argsHash: Hex;
  chainId?: number;
}): Hex {
  return signAuth(args.owner.pqc, {
    chainId: BigInt(args.chainId ?? network().evmChainId),
    verifier: args.vault,
    signer: args.owner.evm as Address,
    action: actionId(`BidderVault.${args.action}`),
    nonce: args.nonce,
    deadline: args.deadline,
    argsHash: args.argsHash,
  });
}

/** The gas account must hold gas only: refuse one that could lose a token through its windows. */
export async function checkGasAccount(gas: Pick<UnifiedAccount, "cosmos" | "evm">, owner: string, tokens: string[]): Promise<void> {
  if (gas.cosmos === owner) throw new Error("the gas account must not be the owner's account");
  const other = Object.entries(await balances(gas.cosmos)).filter(([d, v]) => d !== "uqor" && v > 0n);
  if (other.length > 0) throw new Error(`the gas account holds ${other.map(([d]) => d).join(", ")}; it must hold gas only`);
  for (const t of tokens) if ((await erc20Balance(t, gas.evm)) > 0n) throw new Error(`the gas account holds tokens of ${t}; it must hold gas only`);
}

/** Open a window for the one contract, send the call, close the window even if it fails. */
async function inWindow(gas: UnifiedAccount, targets: string[], tx: { to?: Hex; data: Hex }, note: string): Promise<{ txs: TxOutcome[]; contractAddress?: Address }> {
  // The node estimates first, so a call that would revert costs nothing.
  const limit = await estimate(gas, tx);
  const txs: TxOutcome[] = [];
  if (tx.to) {
    txs.push(await openWindow(gas, { targets, blocks: 120, maxTxs: 1, gasPerTx: limit }));
  } else {
    // A scoped window refuses contract creation, so this one has no targets: one transaction, few blocks, an account that holds gas only.
    const maxValue = windowMaxValue({ targets: [], blocks: 60, maxTxs: 1, gasPerTx: limit });
    const res = await broadcast(gas, [openEvmWindowMsg({ sender: gas.cosmos, blocks: 60, maxTxs: 1, maxValue })]);
    txs.push({ txHash: res.transactionHash, note: "deployment window: unscoped, 1 transaction, 60 blocks" });
  }
  try {
    const receipt = await sendEvm(gas, { ...tx, gas: limit });
    txs.push({ txHash: receipt.transactionHash, note: `${note}; gas used ${receipt.gasUsed}` });
    return { txs, ...(receipt.contractAddress ? { contractAddress: receipt.contractAddress } : {}) };
  } finally {
    const closed = await closeWindow(gas);
    if (closed) txs.push({ ...closed, note: "window closed" });
  }
}

export async function deployVault(gas: UnifiedAccount, args: { owner: Address; quote: Address; factory: Address }): Promise<{ vault: Address; txs: TxOutcome[] }> {
  const a = vaultArtifact();
  const w = await fetchEvmWindow({ rest: network().rest, address: gas.cosmos });
  if (w.found && w.live) throw new Error("the gas account already has a live window; close it first");
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [args.owner, args.quote, args.factory] });
  const { txs, contractAddress } = await inWindow(gas, [], { data }, "deploy BidderVault");
  if (!contractAddress) throw new Error("the deployment has no contract address");
  await checkDeployed(contractAddress, args);
  return { vault: contractAddress, txs };
}

/** The contract at `vault` is the committed code, for this owner, token and factory. */
export async function checkDeployed(vault: Address, args: { owner: Address; quote: Address; factory: Address }): Promise<VaultView> {
  const client = publicClient();
  const code = await client.getCode({ address: vault });
  if (!code || !sameRuntime(code, vaultArtifact())) throw new Error(`the code at ${vault} is not contracts/BidderVault.artifact.json`);
  const v = await readVault(client, vault);
  for (const k of ["owner", "quote", "factory"] as const) {
    if (v[k].toLowerCase() !== args[k].toLowerCase()) throw new Error(`the vault's ${k} is ${v[k]}, expected ${args[k]}`);
  }
  return v;
}

type OwnerCall = {
  [K in VaultAction]: { fn: K; argsHash: Hex; args: (deadline: bigint, sig: Hex) => ContractFunctionArgs<typeof bidderVaultAbi, "nonpayable", K> };
}[VaultAction];

async function ownerAction(owner: UnifiedAccount, gas: UnifiedAccount, vault: Address, c: OwnerCall, note: string): Promise<TxOutcome[]> {
  const client = publicClient();
  const v = await readVault(client, vault);
  if (v.owner.toLowerCase() !== owner.evm.toLowerCase()) throw new Error(`the vault's owner is ${v.owner}`);
  const deadline = (await client.getBlock()).timestamp + BigInt(SIGNATURE_TTL);
  const sig = signVaultAction({ owner, vault, action: c.fn, nonce: v.nonce, deadline, argsHash: c.argsHash });
  const data = encodeFunctionData({ abi: bidderVaultAbi, functionName: c.fn, args: c.args(deadline, sig) } as never);
  return (await inWindow(gas, [vault], { to: vault, data }, note)).txs;
}

export function setVaultPolicy(owner: UnifiedAccount, gas: UnifiedAccount, vault: Address, p: VaultPolicy, approvals: Approval[]): Promise<TxOutcome[]> {
  return ownerAction(owner, gas, vault, { fn: "setPolicy", argsHash: policyArgsHash(p, approvals), args: (d, s) => [p, approvals, d, s] }, "setPolicy, signed with the owner's ML-DSA-87 key");
}

export function revokeVault(owner: UnifiedAccount, gas: UnifiedAccount, vault: Address): Promise<TxOutcome[]> {
  return ownerAction(owner, gas, vault, { fn: "revoke", argsHash: `0x${"00".repeat(32)}`, args: (d, s) => [d, s] }, "revoke, signed with the owner's ML-DSA-87 key");
}

export function sweepVault(owner: UnifiedAccount, gas: UnifiedAccount, vault: Address, token: Address, amount: bigint): Promise<TxOutcome[]> {
  return ownerAction(owner, gas, vault, { fn: "sweep", argsHash: sweepArgsHash(token, amount), args: (d, s) => [token, amount, d, s] }, `sweep ${amount} of ${token} to the owner, signed with the owner's ML-DSA-87 key`);
}

/** The permissionless exit, once it is open. */
export async function exitVault(gas: UnifiedAccount, vault: Address, token: Address): Promise<TxOutcome[]> {
  const data = encodeFunctionData({ abi: bidderVaultAbi, functionName: "sweepAfterExit", args: [token] });
  return (await inWindow(gas, [vault], { to: vault, data }, "sweepAfterExit")).txs;
}

/**
 * The rule's listed token must be one the owner holds in no form: not as an
 * ERC-20 balance (what the linked key could move) and not as bank coins (which
 * it cannot, but which the owner could convert later without thinking of this).
 */
export async function checkUnheld(token: Address, owner: { cosmos: string; evm: string }): Promise<void> {
  const erc20 = await erc20Balance(token, owner.evm);
  if (erc20 > 0n) throw new Error(`the owner holds ${erc20} of ${token}: the rule must list a token it does not hold`);
  const bank = Object.entries(await balances(owner.cosmos)).find(([d, v]) => v > 0n && d.toLowerCase() === `erc20:${token.toLowerCase()}`);
  if (bank) throw new Error(`the owner holds ${bank[1]} of ${token} as bank coins: the rule must list a token it does not hold`);
}

