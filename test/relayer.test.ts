import { describe, expect, it } from "vitest";
import { deriveUnifiedAccount, evmAuthSignBytes, evmAuthSignBytesV2, executeEvmMsg, generateMnemonic, qorechainTypes, type EncodeObject } from "@qorechain/sdk";
import { hexToBytes, recoverMessageAddress, type Hex } from "viem";
import { Relayer, checkRelayable, decodeExecuteEvm, decodeExecuteEvmWire, encodeExecuteEvmWire, type Broadcaster, type RelayOutcome, type RelayPolicy } from "../relayer/relayer.ts";
import { SmartAccountExecutor, localSigner, type BidEncoder } from "../agent/smart-account-executor.ts";
import { TESTNET_CHAIN_ID } from "../common/network.ts";
import { AUCTION_A, newAccount, newAgent, sampleMandate } from "./helpers.ts";
import type { BidDecision } from "../agent/agent.ts";

const { MsgExecuteEVMResponse } = qorechainTypes.abstractaccount;
const owner = newAccount();
const relayerAcc = newAccount();
const agentAccount = await deriveUnifiedAccount(generateMnemonic(256), 0);
const policy: RelayPolicy = { relayer: relayerAcc.address, account: owner.address, targets: [AUCTION_A], maxGas: 3_000_000n };

const DECISION: BidDecision = {
  kind: "bid",
  auction: AUCTION_A,
  qty: 10n ** 20n,
  tick: 10,
  escrow: 20_000_000n,
  bond: 1_000_000n,
  outflow: 21_000_000n,
  adjustments: [],
};
const encoder: BidEncoder = { encode: async () => ({ to: AUCTION_A as Hex, data: "0xdeadbeef", gasLimit: 900_000n }) };

function executor(over: { relay?: (m: EncodeObject) => Promise<RelayOutcome>; digest?: "v1" | "v2" } = {}) {
  const sent: EncodeObject[] = [];
  const ex = new SmartAccountExecutor({
    privateKey: agentAccount.privateKey as Hex,
    chainId: TESTNET_CHAIN_ID,
    owner: owner.address,
    relayer: relayerAcc.address,
    encoder,
    relay: {
      relay: async (m) => {
        sent.push(m);
        return over.relay ? over.relay(m) : { status: "landed", txHash: "ABC" };
      },
    },
    authNonce: async () => 7n,
    digestVersion: async () => over.digest ?? "v2",
  });
  return { ex, sent };
}

function delivered(success: boolean, extra: { reason?: string } = {}): Awaited<ReturnType<Broadcaster>> {
  return {
    transactionHash: "TXHASH",
    code: 0,
    msgResponses: [
      {
        typeUrl: "/qorechain.abstractaccount.v1.MsgExecuteEVMResponse",
        value: MsgExecuteEVMResponse.encode({ success, ret: new Uint8Array(), gasUsed: "123456", vmError: success ? "" : "execution reverted" }).finish(),
      },
    ],
    events: success
      ? []
      : [
          {
            type: "abstractaccount_execution_failed",
            attributes: [
              { key: "account", value: owner.address },
              { key: "lane", value: "evm" },
              { key: "nonce", value: "7" },
              { key: "reason", value: extra.reason ?? "spending limit exceeded" },
            ],
          },
        ],
  };
}

describe("agent signing", () => {
  it("signs the v2 digest (binding the gas limit) with its linked key; the signature recovers to the agent's address", async () => {
    const { ex } = executor();
    const m = await ex.build(DECISION, sampleMandate(owner, newAgent()));
    const x = decodeExecuteEvm(m);
    expect(x).toMatchObject({ relayer: relayerAcc.address, account: owner.address, scheme: "secp256k1", to: AUCTION_A, value: "0" });
    expect(BigInt(x.nonce.toString())).toBe(7n);
    expect(BigInt(x.gasLimit.toString())).toBe(900_000n);
    const digest = evmAuthSignBytesV2({
      chainId: TESTNET_CHAIN_ID,
      account: owner.address,
      pubkey: hexToBytes(agentAccount.evm as Hex),
      to: AUCTION_A,
      value: "0",
      data: hexToBytes("0xdeadbeef"),
      nonce: 7n,
      gasLimit: 900_000n,
    });
    const signer = await recoverMessageAddress({ message: { raw: digest }, signature: `0x${Buffer.from(x.signature).toString("hex")}` });
    expect(signer.toLowerCase()).toBe(agentAccount.evm.toLowerCase());
  });

  it("signs the v1 digest when the chain says so", async () => {
    const { ex } = executor({ digest: "v1" });
    const x = decodeExecuteEvm(await ex.build(DECISION, sampleMandate(owner, newAgent())));
    const digest = evmAuthSignBytes({
      chainId: TESTNET_CHAIN_ID,
      account: owner.address,
      pubkey: hexToBytes(agentAccount.evm as Hex),
      to: AUCTION_A,
      value: "0",
      data: hexToBytes("0xdeadbeef"),
      nonce: 7n,
    });
    const signer = await recoverMessageAddress({ message: { raw: digest }, signature: `0x${Buffer.from(x.signature).toString("hex")}` });
    expect(signer.toLowerCase()).toBe(agentAccount.evm.toLowerCase());
  });

  it("refuses to sign when the encoder targets another contract", async () => {
    const bad: BidEncoder = { encode: async () => ({ to: "0x3333333333333333333333333333333333333333", data: "0x", gasLimit: 1n }) };
    const ex = new SmartAccountExecutor({
      privateKey: agentAccount.privateKey as Hex,
      chainId: TESTNET_CHAIN_ID,
      owner: owner.address,
      relayer: relayerAcc.address,
      encoder: bad,
      relay: { relay: async () => ({ status: "landed" }) },
      authNonce: async () => 0n,
      digestVersion: async () => "v2",
    });
    expect(await ex.submit(DECISION, sampleMandate(owner, newAgent()))).toMatchObject({ status: "refused" });
  });

  it("the local signer signs only for its own address", async () => {
    const s = localSigner(agentAccount.privateKey as Hex);
    await expect(s.request({ method: "eth_sendTransaction", params: [] })).rejects.toThrow();
    await expect(s.request({ method: "personal_sign", params: ["0x00", owner.hex] })).rejects.toThrow();
  });
});

describe("relayer", () => {
  async function signed(over: Partial<{ to: string; value: string; gasLimit: bigint; account: string; relayer: string }> = {}) {
    const { ex } = executor();
    const m = decodeExecuteEvm(await ex.build(DECISION, sampleMandate(owner, newAgent())));
    return executeEvmMsg({
      relayer: over.relayer ?? m.relayer,
      account: over.account ?? m.account,
      scheme: "secp256k1",
      pubkey: m.pubkey,
      signature: m.signature,
      to: over.to ?? m.to,
      value: over.value ?? m.value,
      data: m.data,
      gasLimit: over.gasLimit ?? BigInt(m.gasLimit.toString()),
      nonce: BigInt(m.nonce.toString()),
    });
  }

  it("refuses, before spending gas, messages outside its policy", async () => {
    expect(checkRelayable(await signed(), policy)).toBeUndefined();
    expect(checkRelayable(await signed({ to: "0x3333333333333333333333333333333333333333" }), policy)).toMatch(/not allowed/);
    expect(checkRelayable(await signed({ account: relayerAcc.address }), policy)).toMatch(/another account/);
    expect(checkRelayable(await signed({ relayer: owner.address }), policy)).toMatch(/another relayer/);
    expect(checkRelayable(await signed({ value: "1" }), policy)).toMatch(/native value/);
    expect(checkRelayable(await signed({ gasLimit: 30_000_000n }), policy)).toMatch(/gas limit/);
    expect(checkRelayable({ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: {} }, policy)).toMatch(/not a MsgExecuteEVM/);
  });

  it("reports a landed execution", async () => {
    const r = new Relayer(policy, async () => delivered(true));
    expect(await r.relay(await signed())).toEqual({ status: "landed", txHash: "TXHASH", gasUsed: "123456" });
  });

  it("treats success=false in a code-0 transaction as a final refusal, with the chain's reason", async () => {
    const r = new Relayer(policy, async () => delivered(false, { reason: "spending limit exceeded" }));
    expect(await r.relay(await signed())).toMatchObject({ status: "refused", txHash: "TXHASH", reason: "spending limit exceeded" });
  });

  it("treats a transaction refused with a code as not executed", async () => {
    const r = new Relayer(policy, async () => {
      throw new Error("transaction ABC failed with code 11: nonce mismatch");
    });
    expect(await r.relay(await signed())).toMatchObject({ status: "refused" });
  });

  it("treats a lost connection as unknown (the bid may have executed)", async () => {
    const r = new Relayer(policy, async () => {
      throw new Error("socket hang up");
    });
    expect(await r.relay(await signed())).toMatchObject({ status: "unknown" });
  });

  it("does not broadcast what it refuses", async () => {
    let calls = 0;
    const r = new Relayer(policy, async () => {
      calls++;
      return delivered(true);
    });
    expect(await r.relay(await signed({ to: "0x3333333333333333333333333333333333333333" }))).toMatchObject({ status: "refused" });
    expect(calls).toBe(0);
  });

  it("round-trips the wire form", async () => {
    const m = await signed();
    const wire = encodeExecuteEvmWire(m);
    expect(encodeExecuteEvmWire(decodeExecuteEvmWire(wire))).toBe(wire);
    expect(checkRelayable(decodeExecuteEvmWire(wire), policy)).toBeUndefined();
  });
});

describe("executor outcomes", () => {
  it("passes the relayer's verdict to the agent", async () => {
    const { ex } = executor({ relay: async () => ({ status: "refused", txHash: "T", reason: "spending limit exceeded" }) });
    expect(await ex.submit(DECISION, sampleMandate(owner, newAgent()))).toEqual({ status: "refused", txHash: "T", reason: "spending limit exceeded" });
  });
});
