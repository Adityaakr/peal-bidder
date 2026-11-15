import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CanonicalJsonError, canonicalize, parseCanonical } from "../common/canonical.ts";
import { MandateError, decodeMandate, encodeMandate, mandateHash, validateMandate } from "../common/mandate.ts";
import { newAccount, newAgent, sampleMandate } from "./helpers.ts";

describe("canonical JSON", () => {
  it("sorts keys and drops whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: { z: "1", y: -2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":-2,"z":"1"}}');
  });

  it("refuses values with no single encoding", () => {
    for (const bad of [1.5, NaN, Infinity, 2 ** 60, undefined, () => 1, new Date(0), { a: undefined }, { "é": 1 }, 10n]) {
      expect(() => canonicalize(bad)).toThrow(CanonicalJsonError);
    }
  });

  it("round-trips any canonical value, and parses only canonical text", () => {
    const key = fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz_0123456789".split("")), minLength: 1, maxLength: 6 });
    const value = fc.letrec((tie) => ({
      v: fc.oneof(
        { depthSize: "small" },
        fc.string(),
        fc.integer({ min: -(2 ** 40), max: 2 ** 40 }),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("v"), { maxLength: 4 }),
        fc.dictionary(key, tie("v"), { maxKeys: 4 }),
      ),
    })).v;
    fc.assert(
      fc.property(value, (v) => {
        const text = canonicalize(v);
        expect(canonicalize(parseCanonical(text))).toBe(text);
        expect(() => parseCanonical(` ${text}`)).toThrow(CanonicalJsonError);
      }),
    );
  });
});

describe("PealMandate v1", () => {
  const owner = newAccount();
  const agent = newAgent();
  const m = sampleMandate(owner, agent);

  it("encodes canonically and decodes back", () => {
    const text = encodeMandate(m);
    expect(decodeMandate(text)).toEqual(m);
    expect(mandateHash(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  const invalid: [string, Record<string, unknown>][] = [
    ["an upper-case auction address", { auctions: ["0xABCDEF0000000000000000000000000000000000"] }],
    ["no auctions", { auctions: [] }],
    ["a repeated auction", { auctions: [m.auctions[0], m.auctions[0]] }],
    ["a zero budget", { budget: "0", maxPerBid: "0" }],
    ["maxPerBid above budget", { maxPerBid: "500000001" }],
    ["a budget with a leading zero", { budget: "0500" }],
    ["a numeric budget", { budget: 500 }],
    ["a tick above uint16", { maxTick: 65_536 }],
    ["no bids allowed", { maxBids: 0 }],
    ["an end before the start", { expiresAt: m.notBefore }],
    ["a lifetime over 30 days", { expiresAt: m.notBefore + 30 * 86_400 + 1 }],
    ["nonce zero", { nonce: 0 }],
    ["a short receipt key", { receiptKey: "ab" }],
    ["owner equal to agent", { agent: m.owner }],
    ["a 0x owner", { owner: owner.hex }],
    ["over-long instructions", { instructions: "x".repeat(2001) }],
    ["another version", { version: 2 }],
    ["another type", { type: "PealOrder" }],
    ["an extra field", { extra: 1 }],
  ];
  for (const [what, over] of invalid) {
    it(`refuses ${what}`, () => {
      expect(() => validateMandate({ ...m, ...over })).toThrow(MandateError);
    });
  }

  it("refuses a missing field", () => {
    const { nonce: _n, ...rest } = m;
    expect(() => validateMandate(rest)).toThrow(MandateError);
  });
});
