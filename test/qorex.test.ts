/**
 * The web app's QoreX connection, through the QoreX integrations kit
 * (`@qorechain/qorex-types`), against a stand-in for what QoreX injects.
 */
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QOREX_RDNS, type QorexSignAndBroadcastRequest } from "@qorechain/qorex-types";

const OWNER = "qor14ndj6q3zp7hku9a4hkjnmhvsk3kegf46g002j5";
const GUEST = "qor1k7at260yd632szpqt8fguukwuf3l52fpfz8lur";

type Qorex = typeof import("../apps/web/src/wallet/qorex.ts");
let qorex: Qorex;

function fakeNative(over: Record<string, unknown> = {}) {
  const sent: QorexSignAndBroadcastRequest[] = [];
  const native = {
    capabilities: ["signAndBroadcast"],
    enable: vi.fn(async () => undefined),
    getKey: vi.fn(async () => ({ name: "QoreX", algo: "secp256k1", pubKey: [], address: [], bech32Address: OWNER, isNanoLedger: false })),
    signDirect: vi.fn(async () => {
      throw new Error("not used");
    }),
    signAndBroadcast: vi.fn(async (req: QorexSignAndBroadcastRequest) => {
      sent.push(req);
      return { txHash: "AB".repeat(32), code: 0, height: 10, shield: "shielded" };
    }),
    ...over,
  };
  return { native, sent };
}

function install(native: unknown, evm?: unknown) {
  const listeners = new Map<string, ((e: Event) => void)[]>();
  vi.stubGlobal("window", {
    qorex: { native, evm },
    addEventListener: (t: string, f: (e: Event) => void) => listeners.set(t, [...(listeners.get(t) ?? []), f]),
    removeEventListener: () => undefined,
    dispatchEvent: (e: Event) => {
      if (e.type === "eip6963:requestProvider" && evm) {
        for (const f of listeners.get("eip6963:announceProvider") ?? []) {
          f(Object.assign(new Event("eip6963:announceProvider"), { detail: { info: { uuid: "1", name: "QoreX", icon: "", rdns: QOREX_RDNS }, provider: evm } }));
        }
      }
      return true;
    },
  });
}

beforeAll(async () => {
  vi.stubGlobal("location", { origin: "http://localhost:5173" });
  vi.stubGlobal("window", {});
  qorex = await import("../apps/web/src/wallet/qorex.ts");
});

afterEach(() => {
  vi.stubGlobal("window", {});
});

describe("QoreX through the integrations kit", () => {
  it("is not available when nothing is injected", () => {
    expect(qorex.available()).toBe(false);
  });

  it("connects on the testnet and reads the EVM account from QoreX's EIP-6963 announcement", async () => {
    const { native } = fakeNative();
    const evm = { request: vi.fn(async () => ["0xaCdB2d02220FAf6e17B5bdA53DDd90B46d9426BA"]) };
    install(native, evm);
    expect(qorex.available()).toBe(true);
    const acc = await qorex.connect();
    expect(native.enable).toHaveBeenCalledWith("qorechain-diana");
    expect(acc).toEqual({ cosmos: OWNER, evm: "0xaCdB2d02220FAf6e17B5bdA53DDd90B46d9426BA" });
  });

  it("asks the visitor to switch networks when QoreX is on another chain", async () => {
    install(fakeNative({ enable: vi.fn(async () => Promise.reject(new Error("Unsupported chain qorechain-diana"))) }).native);
    await expect(qorex.connect()).rejects.toThrow(/Switch QoreX to the QoreChain testnet/);
  });

  it("sends QOR with signAndBroadcast: one MsgSend, for QoreX to show and hybrid-sign", async () => {
    const { native, sent } = fakeNative();
    install(native);
    const res = await qorex.sendQor(OWNER, GUEST, 2_000_000n);
    expect(res).toEqual({ txHash: "AB".repeat(32), warning: null });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.chainId).toBe("qorechain-diana");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    const msg = MsgSend.decode(req.messages[0]!.value as Uint8Array);
    expect(msg).toMatchObject({ fromAddress: OWNER, toAddress: GUEST, amount: [{ denom: "uqor", amount: "2000000" }] });
  });

  it("warns when QoreX reports the committed transaction without its ML-DSA-87 layer", async () => {
    const { native } = fakeNative({ signAndBroadcast: vi.fn(async () => ({ txHash: "CD".repeat(32), code: 0, shield: "downgraded" })) });
    install(native);
    const res = await qorex.sendQor(OWNER, GUEST, 1n);
    expect(res.warning).toMatch(/without its ML-DSA-87 layer/);
    expect(qorex.shieldWarning({ txHash: "x", shield: "pending" })).toBeNull();
    expect(qorex.shieldWarning({ txHash: "x", shield: "classical" })).toMatch(/classical/);
  });

  it("refuses a failed transfer, and a QoreX that does not declare signAndBroadcast", async () => {
    install(fakeNative({ signAndBroadcast: vi.fn(async () => ({ txHash: "EF".repeat(32), code: 5, shield: "pending" })) }).native);
    await expect(qorex.sendQor(OWNER, GUEST, 1n)).rejects.toThrow(/code 5/);
    install(fakeNative({ capabilities: ["enable", "getKey"] }).native);
    await expect(qorex.sendQor(OWNER, GUEST, 1n)).rejects.toThrow(/update QoreX/);
  });

});
