import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { UINT128_MAX, costCeil, maxQtyForEscrow, priceAt } from "../agent/auction.ts";
import { EMPTY_LEDGER, clamp, recordBid, type Ledger, type PolicyContext } from "../agent/policy.ts";
import { AUCTION_A, AUCTION_B, NOW, newAccount, newAgent, sampleMandate } from "./helpers.ts";
import { auction, auctionB } from "./auctions.ts";

const owner = newAccount();
const agent = newAgent();
const E18 = 10n ** 18n;

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return { mandate: sampleMandate(owner, agent), auctions: [auction()], ledger: EMPTY_LEDGER, now: NOW, ...over };
}

const bid = (qty: bigint | string, tick: number, a = AUCTION_A) => ({
  action: "bid",
  auction: a,
  qty: qty.toString(),
  tick,
  rationale: "test",
});

describe("auction arithmetic", () => {
  it("rounds escrow up and finds the largest quantity that fits", () => {
    const a = auction();
    expect(priceAt(a, 0)).toBe(100_000n);
    expect(priceAt(a, 10)).toBe(200_000n);
    expect(costCeil(1n, 200_000n, 18)).toBe(1n);
    expect(costCeil(5n * E18, 200_000n, 18)).toBe(1_000_000n);
    const q = maxQtyForEscrow(a, 10, 1_000_000n);
    expect(costCeil(q, 200_000n, 18)).toBeLessThanOrEqual(1_000_000n);
    expect(costCeil(q + 1n, 200_000n, 18)).toBeGreaterThan(1_000_000n);
  });

  it("matches the escrow bound exactly for random inputs", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 24 }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (reservePrice, tickSize, tick, saleDecimals, cap) => {
          const a = { reservePrice, tickSize, saleDecimals };
          const q = maxQtyForEscrow(a, tick, cap);
          const p = priceAt(a, tick);
          expect(costCeil(q, p, saleDecimals)).toBeLessThanOrEqual(cap);
          // At price zero escrow never binds: the quantity is capped at uint128 instead.
          if (p === 0n) expect(q).toBe(UINT128_MAX);
          else if (q < UINT128_MAX) expect(costCeil(q + 1n, p, saleDecimals)).toBeGreaterThan(cap);
        },
      ),
    );
  });
});

describe("clamp", () => {
  it("passes an in-mandate bid through unchanged", () => {
    const d = clamp(bid(100n * E18, 10), ctx());
    expect(d).toEqual({
      kind: "bid",
      auction: AUCTION_A,
      qty: 100n * E18,
      tick: 10,
      escrow: 20_000_000n,
      bond: 1_000_000n,
      outflow: 21_000_000n,
      adjustments: [],
    });
  });

  it("lowers a tick above the mandate's maximum", () => {
    const d = clamp(bid(10n * E18, 63), ctx());
    expect(d).toMatchObject({ kind: "bid", tick: 40, adjustments: ["TICK_LOWERED"] });
  });

  it("lowers a tick above the auction's last tick", () => {
    const d = clamp(bid(10n * E18, 50), ctx({ auctions: [auction({ numTicks: 20 })] }));
    expect(d).toMatchObject({ kind: "bid", tick: 19 });
  });

  it("lowers a quantity whose outflow exceeds the per-bid limit", () => {
    const d = clamp(bid(10n ** 30n, 40), ctx());
    if (d.kind !== "bid") throw new Error("expected a bid");
    expect(d.adjustments).toContain("QTY_LOWERED");
    expect(d.outflow).toBeLessThanOrEqual(100_000_000n);
    // One more base unit would not fit.
    expect(costCeil(d.qty + 1n, priceAt(auction(), 40), 18) + d.bond).toBeGreaterThan(100_000_000n);
  });

  it("lowers a quantity to what is left of the budget", () => {
    const ledger: Ledger = { bids: 4, committed: 470_000_000n, qtyByAuction: {} };
    const d = clamp(bid(10n ** 30n, 0), ctx({ mandate: sampleMandate(owner, agent, { maxBids: 10 }), ledger }));
    if (d.kind !== "bid") throw new Error("expected a bid");
    expect(d.outflow).toBeLessThanOrEqual(30_000_000n);
  });

  it("skips an auction outside the mandate, without substituting one", () => {
    expect(clamp(bid(E18, 1, AUCTION_B), ctx({ auctions: [auction(), auctionB()] }))).toMatchObject({
      kind: "skip",
      reason: "AUCTION_NOT_IN_MANDATE",
    });
    expect(clamp(bid(E18, 1, "0x3333333333333333333333333333333333333333"), ctx())).toMatchObject({
      kind: "skip",
      reason: "AUCTION_NOT_IN_MANDATE",
    });
  });

  it("matches auction addresses case-insensitively", () => {
    expect(clamp(bid(E18, 1, AUCTION_A.toUpperCase().replace("0X", "0x")), ctx())).toMatchObject({ kind: "bid" });
  });

  it("skips a closed auction and an auction it cannot read", () => {
    expect(clamp(bid(E18, 1), ctx({ auctions: [auction({ commitOpen: false })] }))).toMatchObject({ reason: "AUCTION_NOT_OPEN" });
    expect(clamp(bid(E18, 1), ctx({ auctions: [auction({ commitEnd: NOW })] }))).toMatchObject({ reason: "AUCTION_NOT_OPEN" });
    expect(clamp(bid(E18, 1), ctx({ auctions: [] }))).toMatchObject({ reason: "AUCTION_UNKNOWN" });
  });

  it("skips an auction paid in another token", () => {
    const other = auction({ quoteToken: "0x4444444444444444444444444444444444444444" });
    expect(clamp(bid(E18, 1), ctx({ auctions: [other] }))).toMatchObject({ reason: "WRONG_QUOTE_TOKEN" });
  });

  it("skips outside the mandate's validity", () => {
    expect(clamp(bid(E18, 1), ctx({ now: NOW + 86_400 }))).toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
    expect(clamp(bid(E18, 1), ctx({ now: NOW - 3600 }))).toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
  });

  it("skips once the bid count or the budget is used up", () => {
    expect(clamp(bid(E18, 1), ctx({ ledger: { bids: 5, committed: 0n, qtyByAuction: {} } }))).toMatchObject({
      reason: "BID_COUNT_EXHAUSTED",
    });
    expect(clamp(bid(E18, 1), ctx({ ledger: { bids: 1, committed: 499_500_000n, qtyByAuction: {} } }))).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
    });
  });

  it("respects the auction's per-address cap", () => {
    const capped = auction({ maxPerAddress: 50n * E18 });
    const ledger: Ledger = { bids: 1, committed: 10_000_000n, qtyByAuction: { [AUCTION_A]: 30n * E18 } };
    expect(clamp(bid(100n * E18, 0), ctx({ auctions: [capped], ledger }))).toMatchObject({ kind: "bid", qty: 20n * E18 });
    const full: Ledger = { ...ledger, qtyByAuction: { [AUCTION_A]: 50n * E18 } };
    expect(clamp(bid(E18, 0), ctx({ auctions: [capped], ledger: full }))).toMatchObject({ reason: "ADDRESS_CAP_REACHED" });
  });

  it("skips a quantity below the auction's minimum", () => {
    expect(clamp(bid(E18 - 1n, 0), ctx())).toMatchObject({ reason: "BELOW_MIN_QUANTITY" });
    expect(clamp(bid(0n, 0), ctx())).toMatchObject({ reason: "BELOW_MIN_QUANTITY" });
  });

  it("follows a planner's skip", () => {
    expect(clamp({ action: "skip", auction: "", qty: "0", tick: 0, rationale: "nothing fits" }, ctx())).toMatchObject({
      kind: "skip",
      reason: "PLANNER_SKIPPED",
    });
  });

  it("skips junk", () => {
    for (const junk of [
      undefined,
      null,
      "bid everything",
      42,
      [],
      {},
      { action: "bid" },
      { ...bid(E18, 1), tick: -1 },
      { ...bid(E18, 1), tick: 1.5 },
      { ...bid(E18, 1), tick: "3" },
      { ...bid(E18, 1), qty: "-5" },
      { ...bid(E18, 1), qty: "1e18" },
      { ...bid(E18, 1), qty: 1000 },
      { ...bid(E18, 1), qty: "0x10" },
      { ...bid(E18, 1), action: "BID" },
      { ...bid(E18, 1), auction: 7 },
    ]) {
      expect(clamp(junk, ctx())).toMatchObject({ kind: "skip", reason: "PROPOSAL_MALFORMED" });
    }
  });

  it("never lets any planner output exceed the mandate (fuzz)", () => {
    const mandate = sampleMandate(owner, agent, { auctions: [AUCTION_A, AUCTION_B], maxBids: 8 });
    const auctions = [auction(), auctionB({ numTicks: 12, maxPerAddress: 40n * E18, bidBond: 0n, minQuantity: 1n })];
    const arbAddress = fc.constantFrom(AUCTION_A, AUCTION_B, AUCTION_A.toUpperCase(), "0x3333333333333333333333333333333333333333", "", "junk");
    const arbProposal = fc.oneof(
      fc.record({
        action: fc.constantFrom("bid", "skip", "BID", "withdraw"),
        auction: arbAddress,
        qty: fc.oneof(fc.bigInt({ min: 0n, max: 10n ** 40n }).map(String), fc.string(), fc.constant("-1")),
        tick: fc.oneof(fc.integer({ min: -5, max: 70_000 }), fc.double(), fc.constant(Number.MAX_SAFE_INTEGER)),
        rationale: fc.string(),
      }),
      fc.anything(),
    );
    const arbLedger = fc.record({
      bids: fc.integer({ min: 0, max: 9 }),
      committed: fc.bigInt({ min: 0n, max: 600_000_000n }),
      qtyByAuction: fc.record({ [AUCTION_B]: fc.bigInt({ min: 0n, max: 50n * E18 }) }),
    });
    fc.assert(
      fc.property(arbProposal, arbLedger, fc.integer({ min: NOW - 120, max: NOW + 90_000 }), (raw, ledger: Ledger, now) => {
        const d = clamp(raw, { mandate, auctions, ledger, now });
        if (d.kind === "skip") return;
        const a = auctions.find((x) => x.address === d.auction);
        expect(a).toBeDefined();
        if (!a) return;
        expect(mandate.auctions).toContain(d.auction);
        expect(now).toBeGreaterThanOrEqual(mandate.notBefore);
        expect(now).toBeLessThan(Math.min(mandate.expiresAt, a.commitEnd));
        expect(ledger.bids).toBeLessThan(mandate.maxBids);
        expect(d.tick).toBeGreaterThanOrEqual(0);
        expect(d.tick).toBeLessThanOrEqual(mandate.maxTick);
        expect(d.tick).toBeLessThan(a.numTicks);
        expect(d.qty).toBeGreaterThanOrEqual(a.minQuantity);
        expect(d.qty).toBeGreaterThan(0n);
        expect(d.qty).toBeLessThanOrEqual(a.supply);
        if (a.maxPerAddress > 0n) expect((ledger.qtyByAuction[a.address] ?? 0n) + d.qty).toBeLessThanOrEqual(a.maxPerAddress);
        expect(d.escrow).toBe(costCeil(d.qty, priceAt(a, d.tick), a.saleDecimals));
        expect(d.outflow).toBe(d.escrow + a.bidBond);
        expect(d.outflow).toBeLessThanOrEqual(BigInt(mandate.maxPerBid));
        expect(ledger.committed + d.outflow).toBeLessThanOrEqual(BigInt(mandate.budget));
      }),
      { numRuns: 2000 },
    );
  });

  it("keeps a run of bids inside the budget and the bid count", () => {
    const c = ctx();
    let ledger = EMPTY_LEDGER;
    let placed = 0;
    for (let i = 0; i < 20; i++) {
      const d = clamp(bid(10n ** 30n, 63), { ...c, ledger });
      if (d.kind === "skip") continue;
      ledger = recordBid(ledger, d);
      placed++;
    }
    expect(placed).toBe(5);
    expect(ledger.committed).toBeLessThanOrEqual(500_000_000n);
  });
});
