import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkValuePermissionRules, deriveUnifiedAccount, generateMnemonic, pqcVerify, ruleBoundsEveryDenom, validateSpendingRules } from "@qorechain/sdk";
import { authMessage, actionId } from "qore-pq-kit";
import { openShare } from "qore-pq-kit/threshold";
import { decodeFunctionData, hexToBytes, keccak256, toBytes, toFunctionSelector, toFunctionSignature, type Abi, type AbiFunction, type Address, type Hex } from "viem";
import { BidderAgent, type BidDecision } from "../agent/agent.ts";
import { SHARE_PURPOSE, sealedAuctionAbi } from "../agent/auction-abi.ts";
import { SealedBidEncoder } from "../agent/bid-encoder.ts";
import { ChainAuctionReader } from "../agent/chain-auction.ts";
import { claimAll } from "../agent/claims.ts";
import { bidderFor, senderFor } from "../agent/executors.ts";
import { StaticPqKeySource } from "../agent/keysource.ts";
import { RulePlanner } from "../agent/planner/index.ts";
import { MemorySink, ReceiptLog, receiptKeyHash, verifyReceipts } from "../agent/receipts.ts";
import { SmartAccountExecutor } from "../agent/smart-account-executor.ts";
import { MemoryMandateStore } from "../agent/store.ts";
import { VAULT_BID_SELECTOR, VaultBidEncoder, assertBidTarget, bidderVaultAbi, parseVaultAddress, readVault, vaultRefusal, wrapCommit, type VaultView } from "../agent/vault.ts";
import { WindowExecutor } from "../agent/window-executor.ts";
import { FBTC, FUSD, TESTNET_CHAIN_ID, TESTNET_EVM_CHAIN_ID } from "../common/network.ts";
import { sealMandate, signMandate } from "../owner-cli/mandate.ts";
import { toChainRule, vaultRuleFor } from "../owner-cli/smart-account.ts";
import { configHash, policyArgsHash, sameRuntime, signVaultAction, sweepArgsHash, vaultArtifact } from "../owner-cli/vault.ts";
import { Relayer, decodeExecuteEvm } from "../relayer/relayer.ts";
import { fakeChain } from "./fake-chain.ts";
import { AUCTION_A, AUCTION_B, newAccount, newAgent, sampleMandate } from "./helpers.ts";

const VAULT = "0x9A9A9a9a9A9a9A9A9a9A9A9a9a9A9a9A9a9A9A9A".toLowerCase() as Address;
const NOW = 1_795_000_000;
const owner = newAccount();
const agentKeys = newAgent();
const mandate = sampleMandate(owner, agentKeys);

function vaultState(over: Partial<Record<string, unknown>> = {}) {
  return {
    owner: [owner.hex, 3n],
    quote: FUSD,
    factory: "0x6666666666666666666666666666666666666666",
    epoch: 1n,
    policy: [owner.hex, BigInt(NOW + 3600), 3, 100_000_000n, 200_000_000n, 300_000_000n],
    approvedAuctions: [AUCTION_A],
    remaining: [200_000_000n, 300_000_000n, 3n],
    exitOpensAt: BigInt(NOW + 3600 + 14 * 86400),
    balanceOf: 300_000_000n,
    ...over,
  } as Record<string, unknown>;
}

/** The fake chain of the encoder tests, with a vault on it. */
function withVault(over: Partial<Record<string, unknown>> = {}) {
  const chain = fakeChain();
  const v = vaultState(over);
  const inner = chain.client.readContract;
  const readContract = async (a: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    if (a.address.toLowerCase() === VAULT || a.functionName === "balanceOf") return v[a.functionName];
    return inner(a);
  };
  return { ...chain, client: { ...chain.client, readContract } };
}

function vaultEncoder(chain: ReturnType<typeof withVault>, operator = owner.hex as Address) {
  return new VaultBidEncoder({
    inner: new SealedBidEncoder({
      client: chain.client as never,
      rest: "https://rest.test",
      evmChainId: TESTNET_EVM_CHAIN_ID,
      sealChainId: TESTNET_CHAIN_ID,
      bidder: VAULT,
      fetch: chain.fetch,
    }),
    vault: VAULT,
    operator,
    client: chain.client as never,
    now: () => NOW,
  });
}

// 100 sale tokens at tick 0 (0.10 fUSD): escrow 10 fUSD, bond 1.
const D: BidDecision = { kind: "bid", auction: AUCTION_A, qty: 100n * 10n ** 18n, tick: 0, escrow: 10_000_000n, bond: 1_000_000n, outflow: 11_000_000n, adjustments: [] };

describe("the vault's interface", () => {
  it("is the compiled contract's, function by function and error by error", () => {
    const abi = vaultArtifact().abi;
    const key = (x: Abi[number]) => `${x.type} ${toFunctionSignature({ ...x, type: "function" } as AbiFunction)}`;
    const compiled = new Set(abi.filter((x) => x.type === "function" || x.type === "error").map((x) => key(x)));
    for (const x of bidderVaultAbi) expect(compiled, key(x as Abi[number])).toContain(key(x as Abi[number]));
    for (const x of bidderVaultAbi.filter((y) => y.type === "function")) {
      const real = abi.find((y) => y.type === "function" && y.name === x.name) as AbiFunction;
      expect(real.stateMutability).toBe(x.stateMutability);
      expect(real.outputs.map((o) => o.type)).toEqual(x.outputs.map((o) => o.type));
    }
  });

  it("keeps the bid call the committee's reader decodes", () => {
    expect(VAULT_BID_SELECTOR).toBe("0xfc4c422a");
    expect(VAULT_BID_SELECTOR).toBe(toFunctionSelector("bid(address,uint32,bytes32,bytes32,bytes32[],bytes[],uint256)"));
  });

  it("hashes policies and auction configs as Solidity does (contracts/test/Vectors.t.sol)", () => {
    expect(
      policyArgsHash(
        { operator: "0x00000000000000000000000000000000000000A1", expiresAt: 1_800_000_000n, maxBids: 3, maxPerBid: 100_000_000n, dailyLimit: 200_000_000n, budget: 300_000_000n },
        [
          { auction: AUCTION_A as Address, configHash: keccak256(toBytes("a")) },
          { auction: AUCTION_B as Address, configHash: keccak256(toBytes("b")) },
        ],
      ),
    ).toBe("0xfcc6a6f8fe655d7df56d361d9a6fa4464c4d5bdddc410b2be80d404b770d7694");
    expect(
      configHash({
        issuer: "0x7777777777777777777777777777777777777777",
        saleToken: "0x8888888888888888888888888888888888888888",
        quoteToken: FUSD,
        totalSupply: 100n * 10n ** 18n,
        saleDecimals: 18,
        reservePrice: 1_000_000n,
        tickSize: 500_000n,
        numTicks: 48,
        startTime: 1_000n,
        endTime: 2_000_000_000n,
        releaseDeadline: 2_000_100_000n,
        minBidQuantity: 10n ** 18n,
        maxQuantityPerAddress: 0n,
        maxBids: 32,
        bidBond: 1_000_000n,
        protocolFeeBps: 100,
        feeRecipient: "0x9999999999999999999999999999999999999999",
        committeeSetId: `0x${"ab".padStart(64, "0")}`,
        metadataHash: `0x${"cd".padStart(64, "0")}`,
      }),
    ).toBe("0xf11d57d94760e2424c893998985bdb4eb572566dbe7cddf0466f6ccc5c5f4f36");
  });

  it("recognises the committed code on chain, immutables aside, and nothing else", () => {
    const a = vaultArtifact();
    const code = Buffer.from(a.deployedBytecode.slice(2), "hex");
    expect(a.immutables.length).toBeGreaterThan(0);
    for (const { start, length } of a.immutables) code.fill(0x5a, start, start + length);
    expect(sameRuntime(`0x${code.toString("hex")}`, a)).toBe(true);
    const i = a.immutables[0]!.start - 1;
    code[i] = code[i]! ^ 1;
    expect(sameRuntime(`0x${code.toString("hex")}`, a)).toBe(false);
    expect(sameRuntime("0x", a)).toBe(false);
    expect(sameRuntime(`${a.deployedBytecode}00`, a)).toBe(false);
  });

  it("is tested against unmodified auction contracts", () => {
    const dir = join(import.meta.dirname, "..", "contracts", "vendor", "peal-sealed-auction");
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
    expect(sums).toHaveLength(7);
    for (const line of sums) {
      const [sum, file] = line.split(/\s+/) as [string, string];
      expect(createHash("sha256").update(readFileSync(join(dir, file))).digest("hex"), file).toBe(sum);
    }
  });
});

describe("the rule that lists no token the account holds", () => {
  const args = { vault: VAULT, auctions: [AUCTION_A, AUCTION_B], unheldToken: FBTC, quoteToken: FUSD };

  it("allows vault.bid and claim only, and lists one token with a limit of one unit", () => {
    const rule = toChainRule(vaultRuleFor(args));
    expect(rule).toMatchObject({
      id: "peal-bidder-vault",
      enabled: true,
      perTxLimit: "0",
      dailyLimit: "0",
      allowedDenoms: [`erc20/${FBTC}`],
      denomLimits: [{ denom: `erc20/${FBTC}`, perTxLimit: "1", dailyLimit: "1" }],
      allowedEvmCalls: [`${VAULT}/${VAULT_BID_SELECTOR}`, `${AUCTION_A}/0x379607f5`, `${AUCTION_B}/0x379607f5`],
    });
    expect(ruleBoundsEveryDenom(rule)).toBe(true);
    expect(JSON.stringify(rule).toLowerCase()).not.toContain(FUSD.toLowerCase());
  });

  it("is never an empty token list: that would mean any token", () => {
    const rule = { ...toChainRule(vaultRuleFor(args)), allowedDenoms: [], denomLimits: [] };
    expect(ruleBoundsEveryDenom(rule)).toBe(false);
    expect(() => {
      validateSpendingRules([rule]);
      checkValuePermissionRules(["evm"], [rule]);
    }).toThrow();
  });

  it("refuses to list the budget token or the vault, or no auction", () => {
    expect(() => vaultRuleFor({ ...args, unheldToken: FUSD.toLowerCase() as Address })).toThrow(/budget token/);
    expect(() => vaultRuleFor({ ...args, unheldToken: VAULT })).toThrow(/vault/);
    expect(() => vaultRuleFor({ ...args, auctions: [] })).toThrow(/auctions/);
  });
});

describe("the owner's signature", () => {
  it("is ML-DSA-87 over PqAuth's message, bound to the vault, the action, the nonce and the arguments", async () => {
    const acc = await deriveUnifiedAccount(generateMnemonic(256), 0);
    const base = { owner: acc, vault: VAULT, action: "sweep", nonce: 4n, deadline: 99n, argsHash: sweepArgsHash(FUSD, 5n), chainId: 9800 } as const;
    const sig = hexToBytes(signVaultAction(base));
    expect(sig).toHaveLength(4627);
    const message = (over: Partial<Parameters<typeof authMessage>[0]> = {}) =>
      hexToBytes(authMessage({ chainId: 9800n, verifier: VAULT, signer: acc.evm as Address, action: actionId("BidderVault.sweep"), nonce: 4n, deadline: 99n, argsHash: sweepArgsHash(FUSD, 5n), ...over }));
    expect(pqcVerify(acc.pqc.publicKey, message(), sig)).toBe(true);
    for (const other of [
      { chainId: 1n },
      { verifier: AUCTION_A as Address },
      { action: actionId("BidderVault.setPolicy") },
      { nonce: 5n },
      { deadline: 100n },
      { argsHash: sweepArgsHash(FUSD, 6n) },
      { argsHash: sweepArgsHash(FBTC, 5n) },
    ]) {
      expect(pqcVerify(acc.pqc.publicKey, message(other), sig)).toBe(false);
    }
  });
});

describe("what the agent checks before it signs", () => {
  const read = async (over = {}): Promise<VaultView> => readVault(withVault(over).client as never, VAULT);
  const refusal = async (over: Partial<Record<string, unknown>>, d: Partial<BidDecision> = {}, sender = owner.hex as Address, quote = FUSD as string) =>
    vaultRefusal(await read(over), { ...D, ...d }, sender, quote, NOW);

  it("lets a bid inside every limit through", async () => {
    expect(await refusal({})).toBeUndefined();
    expect(await refusal({ remaining: [11_000_000n, 11_000_000n, 1n], balanceOf: 11_000_000n })).toBeUndefined();
  });

  it("names the limit that would refuse", async () => {
    expect(await refusal({}, {}, agentKeys.hex as Address)).toMatch(/operator/);
    expect(await refusal({ policy: [`0x${"0".repeat(40)}`, BigInt(NOW + 1), 3, 1n, 1n, 1n] })).toMatch(/operator/);
    expect(await refusal({ policy: [owner.hex, BigInt(NOW), 3, 100_000_000n, 200_000_000n, 300_000_000n] })).toMatch(/expired/);
    expect(await refusal({}, { auction: AUCTION_B })).toMatch(/not approved/);
    expect(await refusal({ remaining: [200_000_000n, 300_000_000n, 0n] })).toMatch(/bid count/);
    expect(await refusal({}, { outflow: 100_000_001n })).toMatch(/a bid$/);
    expect(await refusal({ remaining: [10_999_999n, 300_000_000n, 3n] })).toMatch(/left today/);
    expect(await refusal({ remaining: [200_000_000n, 10_999_999n, 3n] })).toMatch(/budget left/);
    expect(await refusal({ balanceOf: 10_999_999n })).toMatch(/the vault holds/);
    expect(await refusal({}, {}, undefined, AUCTION_B)).toMatch(/another token/);
  });

  it("reads --vault as an address or not at all", () => {
    expect(parseVaultAddress(VAULT).toLowerCase()).toBe(VAULT);
    for (const bad of ["", "0x12", `${VAULT}00`, "vault"]) expect(() => parseVaultAddress(bad)).toThrow();
  });
});

describe("a bid through the vault", () => {
  it("is the sealed commit, sealed to the vault's address and wrapped in vault.bid", async () => {
    const chain = withVault();
    const enc = await vaultEncoder(chain).encode(D, mandate);
    expect(enc.to).toBe(VAULT);
    const { functionName, args } = decodeFunctionData({ abi: bidderVaultAbi, data: enc.data });
    expect(functionName).toBe("bid");
    const [auction, seq, , , shareHashes, envelopes, escrow] = args as readonly [Address, number, Hex, Hex, Hex[], Hex[], bigint];
    expect([auction.toLowerCase(), seq, shareHashes.length, escrow]).toEqual([AUCTION_A, 0, 3, D.escrow]);
    // The shares open for the vault as the bidder, and for nobody else: a seal to the owner would be worthless.
    const open = (sender: Address) =>
      openShare({
        envelope: hexToBytes(envelopes[0]!),
        keys: chain.members[0]!.sealKeys,
        binding: { chainId: BigInt(TESTNET_EVM_CHAIN_ID), app: AUCTION_A as Address, sender, seq: 0n },
        index: 1,
        shareHash: shareHashes[0]!,
        sealChainId: TESTNET_CHAIN_ID,
        purpose: SHARE_PURPOSE,
      });
    expect(() => open(VAULT)).not.toThrow();
    expect(() => open(owner.hex as Address)).toThrow();
  });

  it("is not sent when the vault would refuse it", async () => {
    await expect(vaultEncoder(withVault({ approvedAuctions: [AUCTION_B] })).encode(D, mandate)).rejects.toThrow(/not approved/);
    await expect(vaultEncoder(withVault(), agentKeys.hex as Address).encode(D, mandate)).rejects.toThrow(/operator/);
  });

  it("wraps commitBid and nothing else", async () => {
    expect(() => wrapCommit(AUCTION_A as Address, "0x379607f50000000000000000000000000000000000000000000000000000000000000001")).toThrow();
    const commit = (await new SealedBidEncoder({ client: fakeChain().client as never, rest: "", evmChainId: 9800, sealChainId: TESTNET_CHAIN_ID, bidder: VAULT, verify: (async () => newAgent().recipient) as never }).encode(D, mandate)).data;
    const a = decodeFunctionData({ abi: sealedAuctionAbi, data: commit }).args as readonly unknown[];
    const b = decodeFunctionData({ abi: bidderVaultAbi, data: wrapCommit(AUCTION_A as Address, commit) }).args as readonly unknown[];
    expect(b.slice(1)).toEqual(a);
  });

  it("may target only the vault, naming only the decision's auction", async () => {
    const good = await vaultEncoder(withVault()).encode(D, mandate);
    expect(() => assertBidTarget(good, D, VAULT)).not.toThrow();
    expect(() => assertBidTarget(good, { auction: AUCTION_B }, VAULT)).toThrow(/another auction/);
    expect(() => assertBidTarget({ ...good, to: AUCTION_A as Address }, D, VAULT)).toThrow(/than the vault/);
    expect(() => assertBidTarget(good, D)).toThrow(/than the decision/); // without --vault, only the auction
    const sweep = { ...good, data: `0x${"00".repeat(4)}` as Hex };
    expect(() => assertBidTarget(sweep, D, VAULT)).toThrow();
  });

  it("runs end to end: mandate, plan, seal, vault.bid signed by the linked key, relayed; the receipts name the vault", async () => {
    const chain = withVault();
    const acc = await deriveUnifiedAccount(generateMnemonic(256), 0);
    const relayerAcc = newAccount();
    const relayed: { to: string; data: Hex }[] = [];
    const policy = { relayer: relayerAcc.address, account: owner.address, targets: [VAULT, AUCTION_A], maxGas: 3_000_000n };
    const relayer = new Relayer(policy, async (msgs) => {
      const x = decodeExecuteEvm(msgs[0]!);
      relayed.push({ to: x.to.toLowerCase(), data: `0x${Buffer.from(x.data).toString("hex")}` });
      return { txHash: `TX${relayed.length}`, delivered: true, results: [{ success: true, gasUsed: 1n, reason: "", vmError: "" }] } as never;
    });
    const executor = new SmartAccountExecutor({
      privateKey: acc.privateKey as Hex,
      chainId: TESTNET_CHAIN_ID,
      owner: owner.address,
      relayer: relayerAcc.address,
      vault: VAULT,
      encoder: vaultEncoder(chain),
      relay: { relay: (m) => relayer.relay(m) },
      authNonce: async () => 0n,
      digestVersion: async () => "v2",
    });
    const sink = new MemorySink();
    const receipts = new ReceiptLog(sink, agentKeys.receiptKey, agentKeys.address, () => NOW);
    const agent = new BidderAgent({
      inbox: {
        network: { chainId: TESTNET_CHAIN_ID, evmChainId: TESTNET_EVM_CHAIN_ID },
        identity: { address: agentKeys.address, owner: owner.address, sealKeys: agentKeys.sealKeys, receiptKeyHash: receiptKeyHash(agentKeys.receiptKey.publicKey) },
        keys: new StaticPqKeySource().set(owner.address, owner.pqKey.publicKey),
        store: new MemoryMandateStore(() => NOW),
        now: () => NOW,
      },
      receipts,
      history: [],
      planners: [new RulePlanner(1)],
      reader: new ChainAuctionReader(chain.client as never),
      executor,
      vault: VAULT,
    });
    const { envelope } = sealMandate({
      signed: signMandate(mandate, { address: owner.address, classicalKey: owner.classicalKey, pqKey: owner.pqKey }, new Date((NOW - 30) * 1000)),
      mandate,
      recipient: agentKeys.recipient,
    });
    expect((await agent.receive(envelope)).ok).toBe(true);
    expect(await agent.step()).toMatchObject({ kind: "decided", submit: { status: "landed", txHash: "TX1" } });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.to).toBe(VAULT);
    expect(relayed[0]!.data.slice(0, 10)).toBe(VAULT_BID_SELECTOR);
    await claimAll({
      outcome: { auction: AUCTION_A, state: "Settled", clearingPrice: 1n, claimable: true, bids: [{ auction: AUCTION_A, bidId: 0n, seq: 0, escrow: 1n, status: "Opened", exclusion: "None", claimed: false, allocation: 1n, quantity: 1n, tick: 0 }] },
      sender: executor,
      receipts,
      mandateHash: null,
      vault: VAULT,
    });
    expect(relayed[1]!.to).toBe(AUCTION_A);
    const check = verifyReceipts(sink.read(), agentKeys.receiptKey.publicKey);
    if (!check.ok) throw new Error(check.error);
    const named = check.receipts.filter((r) => (r.body.data as { vault?: string }).vault === VAULT).map((r) => r.body.kind);
    expect(named).toEqual(["submission", "result", "claim"]);
  });

  it("on the window lane needs a window that admits the vault", async () => {
    const sent: unknown[] = [];
    const ex = (allowedTargets: string[]) =>
      new WindowExecutor({
        vault: VAULT,
        encoder: vaultEncoder(withVault({ policy: [agentKeys.hex, BigInt(NOW + 3600), 3, 100_000_000n, 200_000_000n, 300_000_000n] }), agentKeys.hex as Address),
        window: async () => ({ live: true, remainingTxs: 1n, allowedTargets }),
        send: async (tx) => {
          sent.push(tx.to);
          return "0xhash";
        },
        wait: async () => "success",
      });
    expect(await ex([AUCTION_A]).submit(D, mandate)).toMatchObject({ status: "refused" });
    expect(sent).toEqual([]);
    expect(await ex([VAULT]).submit(D, mandate)).toMatchObject({ status: "landed" });
    expect(sent).toEqual([VAULT]);
  });

  it("makes the vault the bidder everywhere, whichever account calls it", () => {
    const id = { account: { owner: owner.address, evm: agentKeys.hex } } as never;
    expect(bidderFor("smart-account", id, VAULT)).toBe(VAULT);
    expect(bidderFor("window", id, VAULT)).toBe(VAULT);
    expect(senderFor("smart-account", id).toLowerCase()).toBe(owner.hex.toLowerCase());
    expect(senderFor("window", id)).toBe(agentKeys.hex);
    expect(bidderFor("smart-account", id).toLowerCase()).toBe(owner.hex.toLowerCase());
  });
});
