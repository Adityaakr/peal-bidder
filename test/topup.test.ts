/**
 * `pnpm run owner topup`: QOR to fUSD on the AMM, converted to ERC-20 in the same
 * transaction, priced by the chain's own quote.
 */
import { describe, expect, it } from "vitest";
import { qorechainRegistryTypes } from "@qorechain/sdk";
import { festRegistry } from "qore-pq-kit";
import { findPool, planTopup, quoteExactIn, topupMsgs, type Quote } from "../owner-cli/topup.ts";

const FUSD = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";
const REST = "https://rest.example";
const OWNER = "qor14ndj6q3zp7hku9a4hkjnmhvsk3kegf46g002j5";
const OWNER_EVM = "0xaCdB2d02220FAf6e17B5bdA53DDd90B46d9426BA";

function fakeFetch(routes: Record<string, unknown>, status = 200) {
  const seen: string[] = [];
  const f = async (url: string) => {
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const body = key === undefined ? { message: "Not Implemented" } : routes[key];
    return { ok: key !== undefined && status === 200, status: key === undefined ? 501 : status, json: async () => body };
  };
  return { f, seen };
}

// The testnet's pools on 16 November (pool 2 is fUSD/QOR), plus a shallow duplicate and a paused one.
const pools = {
  pools: [
    { id: "1", pool_type: "constant_product", token_a: FETH, token_b: "uqor", reserve_a: "979164", reserve_b: "1021369", status: "active" },
    { id: "2", pool_type: "constant_product", token_a: FUSD, token_b: "uqor", reserve_a: "556237258", reserve_b: "8153301514", status: "active" },
    { id: "7", pool_type: "constant_product", token_a: "uqor", token_b: FUSD, reserve_a: "1000", reserve_b: "1000", status: "active" },
    { id: "9", pool_type: "constant_product", token_a: FUSD, token_b: "uqor", reserve_a: "999999999999", reserve_b: "1", status: "paused" },
  ],
};

const quote: Quote = { poolId: "2", denomIn: "uqor", amountIn: 2_000_000n, amountOut: 136_002n, fee: 6_000n, impactBps: 3 };

describe("owner top-up on the AMM", () => {
  it("picks the deepest active fUSD/QOR pool, whichever side fUSD is on", async () => {
    const { f } = fakeFetch({ [`${REST}/qorechain/amm/v1/pools`]: pools });
    expect(await findPool(REST, FUSD, "uqor", f)).toMatchObject({ id: "2", reserveA: 556_237_258n, reserveB: 8_153_301_514n });
    await expect(findPool(REST, FUSD, "erc20:0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A", f)).rejects.toThrow(/no active pool/);
  });

  it("asks the chain for the quote", async () => {
    const { f, seen } = fakeFetch({ [`${REST}/qorechain/amm/v1/quote/exact_in`]: { amount_out: "136002", fee: "6000", impact_bps: 3 } });
    expect(await quoteExactIn(REST, "2", "uqor", 2_000_000n, f)).toEqual(quote);
    expect(seen[0]).toBe(`${REST}/qorechain/amm/v1/quote/exact_in?pool_id=2&denom_in=uqor&amount_in=2000000`);
    const none = fakeFetch({});
    await expect(quoteExactIn(REST, "2", "uqor", 1n, none.f)).rejects.toThrow(/did not quote/);
  });

  it("sets the minimum out from the slippage tolerance, and refuses a high price impact or a zero minimum", () => {
    expect(planTopup(quote, { slippageBps: 100, maxImpactBps: 100 }).minOut).toBe(134_641n);
    expect(planTopup(quote, { slippageBps: 0, maxImpactBps: 100 }).minOut).toBe(136_002n);
    expect(() => planTopup({ ...quote, impactBps: 250 }, { slippageBps: 100, maxImpactBps: 100 })).toThrow(/impact is 250 bps/);
    expect(() => planTopup({ ...quote, amountOut: 1n }, { slippageBps: 100, maxImpactBps: 100 })).toThrow(/rounds to zero/);
    expect(() => planTopup(quote, { slippageBps: 10_000, maxImpactBps: 100 })).toThrow(/slippage/);
  });

  it("is one transaction: the swap with its minimum, then the minimum converted to ERC-20 on the owner's account", () => {
    const plan = planTopup(quote, { slippageBps: 100, maxImpactBps: 100 });
    const msgs = topupMsgs(OWNER, OWNER_EVM, FUSD, plan, true);
    expect(msgs.map((m) => m.typeUrl)).toEqual(["/qorechain.amm.v1.MsgSwapExactIn", "/cosmos.evm.erc20.v1.MsgConvertCoin"]);
    expect(msgs[0]?.value).toMatchObject({ sender: OWNER, poolId: "2", tokenIn: { denom: "uqor", amount: "2000000" }, denomOut: FUSD, minOut: "134641" });
    expect(msgs[1]?.value).toMatchObject({ sender: OWNER, receiver: OWNER_EVM, coin: { denom: FUSD, amount: "134641" } });
    expect(topupMsgs(OWNER, OWNER_EVM, FUSD, plan, false)).toHaveLength(1);
    // Both encode with the registry the transaction is signed with.
    const reg = festRegistry();
    for (const m of msgs) expect(reg.encodeAsAny(m).value.length).toBeGreaterThan(0);
    expect(new Map(qorechainRegistryTypes as Iterable<[string, unknown]>).has("/qorechain.amm.v1.MsgSwapExactIn")).toBe(true);
  });
});
