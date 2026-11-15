import { describe, expect, it } from "vitest";
import { bytesToHex, encodeFunctionResult, toFunctionSelector, type Hex } from "viem";
import { ChainPqKeySource, PQC_KEY_STATUS_ABI } from "../agent/keysource.ts";
import { PQC_KEY_STATUS } from "../common/network.ts";
import { newAccount } from "./helpers.ts";

const owner = newAccount();

function status(registered: boolean, algorithm: number, key: Uint8Array, proven: boolean): Hex {
  return encodeFunctionResult({
    abi: PQC_KEY_STATUS_ABI,
    functionName: "pqcKeyStatus",
    result: [registered, algorithm, bytesToHex(key), proven],
  });
}

function source(reply: Hex | undefined | Error) {
  const calls: { to?: string; data?: string }[] = [];
  const client = {
    async call(args: { to?: string | null; data?: Hex }) {
      calls.push({ to: args.to ?? undefined, data: args.data });
      if (reply instanceof Error) throw reply;
      return { data: reply };
    },
  };
  return { src: new ChainPqKeySource(client as never), calls };
}

describe("ChainPqKeySource", () => {
  it("calls pqcKeyStatus(address) on the precompile with the account's 0x form", async () => {
    expect(toFunctionSelector("pqcKeyStatus(address)")).toBe("0x850dfe51");
    const { src, calls } = source(status(true, 1, owner.pqKey.publicKey, true));
    const key = await src.pqPublicKey(owner.address);
    expect(key).toEqual(owner.pqKey.publicKey);
    expect(calls[0]?.to).toBe(PQC_KEY_STATUS);
    expect(calls[0]?.data?.slice(0, 10)).toBe("0x850dfe51");
    expect(calls[0]?.data?.toLowerCase()).toContain(owner.hex.slice(2).toLowerCase());
  });

  it("decodes the 2,752-byte reply the live precompile returns", () => {
    // Four head words, the length word, then 2,592 key bytes (81 words): 2,752 bytes (design report, Appendix A).
    const hex = status(true, 1, owner.pqKey.publicKey, true);
    expect((hex.length - 2) / 2).toBe(2752);
  });

  const refusals: [string, Hex | undefined | Error, string][] = [
    ["no key registered", status(false, 0, new Uint8Array(), false), "KEY_NOT_REGISTERED"],
    ["another algorithm", status(true, 2, owner.pqKey.publicKey, true), "KEY_WRONG_ALGORITHM"],
    ["possession not proven", status(true, 1, owner.pqKey.publicKey, false), "KEY_NOT_PROVEN"],
    ["a key of the wrong length", status(true, 1, owner.pqKey.publicKey.slice(0, 1312), true), "KEY_BAD_LENGTH"],
    ["empty return data", "0x", "KEY_UNAVAILABLE"],
    ["no return data", undefined, "KEY_UNAVAILABLE"],
    ["malformed return data", "0x1234", "KEY_UNAVAILABLE"],
    ["an RPC error", new Error("ECONNREFUSED"), "KEY_UNAVAILABLE"],
  ];
  for (const [what, reply, code] of refusals) {
    it(`fails closed on ${what}`, async () => {
      const { src } = source(reply);
      await expect(src.pqPublicKey(owner.address)).rejects.toMatchObject({ code });
    });
  }

  it("refuses something that is not an address", async () => {
    const { src, calls } = source(status(true, 1, owner.pqKey.publicKey, true));
    await expect(src.pqPublicKey("not-an-address")).rejects.toMatchObject({ code: "KEY_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
  });
});
