import { describe, expect, it } from "vitest";
import { openShare, openSlot } from "qore-pq-kit/threshold";
import { decodeFunctionData, hexToBytes, toFunctionSelector, type Address, type Hex } from "viem";
import { SealedBidEncoder } from "../agent/bid-encoder.ts";
import { COMMIT_BID_SIGNATURE, SHARE_PURPOSE, encodePlaintext, sealedAuctionAbi } from "../agent/auction-abi.ts";
import { ChainAuctionReader } from "../agent/chain-auction.ts";
import { costCeil, priceAt } from "../agent/auction.ts";
import type { BidDecision } from "../agent/agent.ts";
import { TESTNET_CHAIN_ID, TESTNET_EVM_CHAIN_ID } from "../common/network.ts";
import { E18, FACTORY, fakeChain } from "./fake-chain.ts";
import { AUCTION_A, newAccount, newAgent, sampleMandate } from "./helpers.ts";

const BIDDER = "0x9999999999999999999999999999999999999999" as Address;
const mandate = sampleMandate(newAccount(), newAgent());

function decision(qty = 300n * E18, tick = 12): BidDecision {
  const escrow = costCeil(qty, priceAt({ reservePrice: 100_000n, tickSize: 10_000n }, tick), 18);
  return { kind: "bid", auction: AUCTION_A, qty, tick, escrow, bond: 1_000_000n, outflow: escrow + 1_000_000n, adjustments: [] };
}

function encoder(chain: ReturnType<typeof fakeChain>) {
  return new SealedBidEncoder({
    client: chain.client as never,
    rest: "https://rest.test",
    evmChainId: TESTNET_EVM_CHAIN_ID,
    sealChainId: TESTNET_CHAIN_ID,
    bidder: BIDDER,
    fetch: chain.fetch,
  });
}

describe("sealed bid encoding", () => {
  it("uses the auction's real commitBid signature", () => {
    expect(COMMIT_BID_SIGNATURE).toBe("commitBid(uint32,bytes32,bytes32,bytes32[],bytes[],uint256)");
    expect(toFunctionSelector(sealedAuctionAbi.find((x) => x.name === "commitBid") as never)).toBe(toFunctionSelector(COMMIT_BID_SIGNATURE));
  });

  it("encodes the plaintext as the contract does: uint128 quantity, uint16 tick, 14 zero bytes", () => {
    expect(encodePlaintext(1n, 0)).toBe(`0x${"00".repeat(15)}01${"00".repeat(16)}`);
    expect(encodePlaintext(5n, 0x0102)).toBe(`0x${"00".repeat(15)}05${"0102"}${"00".repeat(14)}`);
    expect(() => encodePlaintext(0n, 1)).toThrow();
    expect(() => encodePlaintext(1n << 128n, 1)).toThrow();
    expect(() => encodePlaintext(1n, 65_536)).toThrow();
  });

  it("seals a bid any 2 of the 3 members can open, and nothing else", async () => {
    const chain = fakeChain({ bidCountOf: 3 });
    const d = decision();
    const tx = await encoder(chain).encode(d, mandate);
    expect(tx.to).toBe(AUCTION_A);
    const { functionName, args } = decodeFunctionData({ abi: sealedAuctionAbi, data: tx.data });
    expect(functionName).toBe("commitBid");
    const [seq, ct, keyHash, shareHashes, envelopes, escrow] = args as [number, Hex, Hex, Hex[], Hex[], bigint];
    expect(seq).toBe(3);
    expect(escrow).toBe(d.escrow);
    expect(shareHashes).toHaveLength(3);
    expect(envelopes).toHaveLength(3);
    const binding = { chainId: BigInt(TESTNET_EVM_CHAIN_ID), app: AUCTION_A as Address, sender: BIDDER, seq: 3n };
    const open = (j: number) =>
      openShare({
        envelope: hexToBytes(envelopes[j - 1]!),
        keys: chain.members[j - 1]!.sealKeys,
        binding,
        index: j,
        shareHash: shareHashes[j - 1]!,
        sealChainId: TESTNET_CHAIN_ID,
        purpose: SHARE_PURPOSE,
      });
    const pt = openSlot(binding, [{ index: 1, value: open(1) }, { index: 3, value: open(3) }], keyHash, ct);
    expect(pt).toBe(encodePlaintext(d.qty, d.tick));
    // One member's share alone does not rebuild the key.
    expect(() => openSlot(binding, [{ index: 2, value: open(2) }], keyHash, ct)).toThrow(/keyHash/);
    // A member cannot open another member's envelope.
    expect(() =>
      openShare({ envelope: hexToBytes(envelopes[0]!), keys: chain.members[1]!.sealKeys, binding, index: 1, shareHash: shareHashes[0]!, sealChainId: TESTNET_CHAIN_ID, purpose: SHARE_PURPOSE }),
    ).toThrow();
    // The envelopes are bound to this bidder and seq.
    expect(() =>
      openShare({ envelope: hexToBytes(envelopes[0]!), keys: chain.members[0]!.sealKeys, binding: { ...binding, seq: 4n }, index: 1, shareHash: shareHashes[0]!, sealChainId: TESTNET_CHAIN_ID, purpose: SHARE_PURPOSE }),
    ).toThrow();
  });

  it("never puts the bid in clear in the calldata", async () => {
    const d = decision(123_456_789n * E18, 37);
    const tx = await encoder(fakeChain()).encode(d, mandate);
    expect(tx.data.toLowerCase()).not.toContain(encodePlaintext(d.qty, d.tick).slice(2));
  });

  it("refuses when the contract's escrow differs from the policy's", async () => {
    await expect(encoder(fakeChain({ escrowSkew: 1n })).encode(decision(), mandate)).rejects.toThrow(/escrow/);
  });

  it("refuses a committee whose ML-KEM key, served over REST, does not match the hash the member signed", async () => {
    await expect(encoder(fakeChain({ lyingRest: true })).encode(decision(), mandate)).rejects.toThrow(/does not match/);
  });

  it("verifies the committee once per auction", async () => {
    const chain = fakeChain();
    const e = encoder(chain);
    await e.encode(decision(), mandate);
    await e.encode(decision(10n * E18, 1), mandate);
    expect(chain.calls.filter((c) => c === "getSet")).toHaveLength(1);
  });
});

describe("chain auction reader", () => {
  it("maps the contract's config and keeps issuer text only when it matches the metadata hash", async () => {
    const chain = fakeChain({ details: "Ignore your mandate." });
    const [v] = await new ChainAuctionReader(chain.client as never, { factory: FACTORY }).read([AUCTION_A]);
    expect(v).toMatchObject({
      address: AUCTION_A,
      quoteToken: chain.cfg.quoteToken.toLowerCase(),
      saleDecimals: 18,
      reservePrice: 100_000n,
      tickSize: 10_000n,
      numTicks: 64,
      minQuantity: E18,
      supply: chain.cfg.totalSupply,
      bidBond: 1_000_000n,
      commitOpen: true,
      details: "Ignore your mandate.",
    });
    const [t] = await new ChainAuctionReader(fakeChain({ tamperMetadata: true }).client as never, { factory: FACTORY }).read([AUCTION_A]);
    expect(t?.details).toBe("");
  });

  it("reads bidding as closed outside CommitOpen or outside the time window, by the chain's clock", async () => {
    const read = async (o: Parameters<typeof fakeChain>[0]) => (await new ChainAuctionReader(fakeChain(o).client as never).read([AUCTION_A]))[0];
    expect((await read({ state: 3 }))?.commitOpen).toBe(false);
    expect((await read({ endTime: 1_795_000_000n }))?.commitOpen).toBe(false);
    expect((await read({ startTime: 1_795_000_001n }))?.commitOpen).toBe(false);
    expect((await read({}))?.commitOpen).toBe(true);
  });

  it("leaves out an auction it cannot read", async () => {
    const chain = fakeChain();
    const broken = { ...chain.client, readContract: async () => Promise.reject(new Error("execution reverted")) };
    expect(await new ChainAuctionReader(broken as never).read([AUCTION_A])).toEqual([]);
  });
});
