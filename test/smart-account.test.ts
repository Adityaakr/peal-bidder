import { describe, expect, it } from "vitest";
import { deriveUnifiedAccount, generateMnemonic, qorechainTypes, ruleBoundsEveryDenom } from "@qorechain/sdk";

const { MsgRegisterAuthenticator, MsgRevokeAuthenticator, MsgUpdateSpendingRules } = qorechainTypes.abstractaccount;
import { toFunctionSelector, type Hex } from "viem";
import {
  COMMIT_BID_SIGNATURE,
  linkAgentMsgs,
  revokeAgentMsg,
  selectorOf,
  setRulesMsg,
  spendingRuleFor,
  toChainRule,
} from "../owner-cli/smart-account.ts";
import { TESTNET_CHAIN_ID } from "../common/network.ts";
import { AUCTION_A, AUCTION_B, newAccount, newAgent, sampleMandate } from "./helpers.ts";

const owner = newAccount();
const agentKeys = newAgent();
const SELECTOR = selectorOf(COMMIT_BID_SIGNATURE);
const CLAIM = toFunctionSelector("claim(uint256)");

function decode<T>(m: { typeUrl: string; value: unknown }, codec: { fromPartial(x: unknown): T }): T {
  return codec.fromPartial(m.value);
}

describe("spending rule for a mandate", () => {
  it("allows only fUSD, only commitBid on the mandate's auctions, within the per-bid and daily limits", () => {
    const m = sampleMandate(owner, agentKeys, { auctions: [AUCTION_A, AUCTION_B] });
    const rule = toChainRule(spendingRuleFor(m, SELECTOR));
    const denom = `erc20/${m.quoteToken}`;
    expect(rule).toMatchObject({
      enabled: true,
      perTxLimit: "0",
      dailyLimit: "0",
      allowedDenoms: [denom],
      allowedEvmCalls: [`${AUCTION_A}/${SELECTOR}`, `${AUCTION_A}/${CLAIM}`, `${AUCTION_B}/${SELECTOR}`, `${AUCTION_B}/${CLAIM}`],
      denomLimits: [{ denom, perTxLimit: "100000000", dailyLimit: "500000000" }],
    });
    expect(ruleBoundsEveryDenom(rule)).toBe(true);
  });

  it("takes a tighter daily limit", () => {
    const rule = spendingRuleFor(sampleMandate(owner, agentKeys), SELECTOR, { dailyLimit: 200_000_000n });
    expect(rule.denomLimits?.[0]?.dailyLimit).toBe(200_000_000n);
  });

  it("accepts a selector or a signature", () => {
    expect(SELECTOR).toBe(toFunctionSelector(COMMIT_BID_SIGNATURE));
    expect(selectorOf("0xABCDEF01")).toBe("0xabcdef01");
  });
});

describe("linking the agent's key", () => {
  it("builds rules then the link, one owner-signed transaction, with an EIP-191 proof by the agent's key", async () => {
    const agentAccount = await deriveUnifiedAccount(generateMnemonic(256), 0);
    const m = sampleMandate(owner, agentKeys);
    const msgs = linkAgentMsgs({
      chainId: TESTNET_CHAIN_ID,
      owner: owner.address,
      agentPrivateKey: agentAccount.privateKey as Hex,
      rule: spendingRuleFor(m, SELECTOR),
      expiryUnix: m.expiresAt,
    });
    expect(msgs.map((x) => x.typeUrl)).toEqual([
      "/qorechain.abstractaccount.v1.MsgUpdateSpendingRules",
      "/qorechain.abstractaccount.v1.MsgRegisterAuthenticator",
    ]);
    const rules = decode(msgs[0] as never, MsgUpdateSpendingRules);
    expect(rules.owner).toBe(owner.address);
    expect(rules.rules).toHaveLength(1);
    const reg = decode(msgs[1] as never, MsgRegisterAuthenticator);
    expect(reg.permissions).toEqual(["evm"]);
    expect(reg.scheme).toBe("secp256k1");
    // The key is linked by the agent's 20-byte EVM address.
    expect(Buffer.from(reg.pubkey).toString("hex")).toBe(agentAccount.evm.slice(2).toLowerCase());
    expect(BigInt(reg.expiryUnix.toString())).toBe(BigInt(m.expiresAt));
    expect(reg.possessionProof.length).toBe(65);
  });

  it("revokes by the agent's EVM address", async () => {
    const agentAccount = await deriveUnifiedAccount(generateMnemonic(256), 0);
    const r = decode(revokeAgentMsg(owner.address, agentAccount.evm) as never, MsgRevokeAuthenticator);
    expect(Buffer.from(r.pubkey).toString("hex")).toBe(agentAccount.evm.slice(2).toLowerCase());
  });

  it("refuses an invalid rule set", () => {
    const rule = spendingRuleFor(sampleMandate(owner, agentKeys), SELECTOR);
    expect(() => setRulesMsg(owner.address, [{ ...rule, allowedDenoms: ["erc20/notanaddress"], denomLimits: [] }])).toThrow();
  });
});
