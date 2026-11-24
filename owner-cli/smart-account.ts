/**
 * The owner's smart-account limits on the agent's linked key: what the chain
 * itself enforces, whatever the agent does.
 *
 * Proven on qorechain-diana by spike S2 (qore-pq-kit, docs/spikes.md): a call
 * above the per-execution limit or to a call not on the allowlist comes back
 * `success = false` and spends the key's nonce; a replay is refused at
 * delivery; the owner needs no EVM window. The link, revoke, signing and relay
 * mechanics come from qore-pq-kit's `smart-account` module; what stays here is
 * Peal Bidder's policy: the rule derived from a mandate.
 *
 * The live runs of 16 and 24 November 2026 closed what S2 left open: the fUSD
 * `denomLimits` below (per execution and per day) and the linked key's expiry
 * were each refused on chain (docs/spikes.md).
 */
import { checkValuePermissionRules, msg, qorechainTypes, validateSpendingRules, type EncodeObject } from "@qorechain/sdk";
import {
  agentLinkProof,
  evmCallEntry,
  linkAgentMsgs as kitLinkAgentMsgs,
  revokeAgentMsg as kitRevokeAgentMsg,
  type AgentRule,
} from "qore-pq-kit/smart-account";
import { toFunctionSelector, type Address, type Hex } from "viem";
import type { PealMandateV1 } from "../common/mandate.ts";
import { CLAIM_SIGNATURE, COMMIT_BID_SIGNATURE } from "../agent/auction-abi.ts";

export type SpendingRule = ReturnType<typeof qorechainTypes.abstractaccount.SpendingRule.fromPartial>;
export type { AgentRule };

/** The rule id this repository writes. */
export const RULE_ID = "peal-bidder";
/** The one permission the agent's key gets (the kit's link sets exactly this): EVM calls. */
export const AGENT_PERMISSIONS = ["evm"] as const;
export const LINK_LABEL = "peal-bidder-agent";

/** `commitBid`'s signature, from Peal Sealed Auction's contract (`agent/auction-abi.ts`). */
export { COMMIT_BID_SIGNATURE };

export function selectorOf(signatureOrSelector: string): Hex {
  if (/^0x[0-9a-fA-F]{8}$/.test(signatureOrSelector)) return signatureOrSelector.toLowerCase() as Hex;
  return toFunctionSelector(signatureOrSelector);
}

/** The rule in the chain's (string) form, as `MsgUpdateSpendingRules` carries it. */
export function toChainRule(r: AgentRule): SpendingRule {
  return {
    id: r.id,
    enabled: true,
    perTxLimit: r.perTxLimit.toString(),
    dailyLimit: r.dailyLimit.toString(),
    allowedDenoms: r.allowedDenoms ?? [],
    allowedEvmCalls: r.allowedEvmCalls.map(evmCallEntry),
    denomLimits: (r.denomLimits ?? []).map((d) => ({ denom: d.denom, perTxLimit: d.perTxLimit.toString(), dailyLimit: d.dailyLimit.toString() })),
  };
}

/**
 * The spending rule for a mandate:
 * - the key may move only the quote token (fUSD), as `erc20/<contract>`;
 * - at most `maxPerBid` per execution and `dailyLimit` (default: the budget) per UTC day;
 * - with call data, only `commitBid` and `claim` on the mandate's auctions
 *   (`claim` is permissionless and pays the bidder, so it moves nothing out).
 *
 * Rule-level limits are zero: the fUSD denom limit is the only one, and fUSD
 * the only denom the key may move. From chain v3.2.2 the EVM lane counts the
 * measured outflow of a call, including allowance changes of a listed ERC-20.
 */
export function spendingRuleFor(mandate: PealMandateV1, commitBidSelector: Hex, opts: { dailyLimit?: bigint } = {}): AgentRule {
  const denom = `erc20/${mandate.quoteToken}`;
  const daily = opts.dailyLimit ?? BigInt(mandate.budget);
  if (daily <= 0n) throw new Error("the daily limit must be positive");
  const claim = toFunctionSelector(CLAIM_SIGNATURE);
  const rule: AgentRule = {
    id: RULE_ID,
    perTxLimit: 0n,
    dailyLimit: 0n,
    allowedDenoms: [denom],
    denomLimits: [{ denom, perTxLimit: BigInt(mandate.maxPerBid), dailyLimit: daily }],
    allowedEvmCalls: mandate.auctions.flatMap((a) => [
      { target: a as Address, selector: commitBidSelector },
      { target: a as Address, selector: claim },
    ]),
  };
  const chainForm = toChainRule(rule);
  validateSpendingRules([chainForm]);
  checkValuePermissionRules([...AGENT_PERMISSIONS], [chainForm]);
  return rule;
}

/**
 * `[MsgUpdateSpendingRules, MsgRegisterAuthenticator]` for ONE owner-signed
 * transaction (qore-pq-kit `linkAgentMsgs`): the agent's key is linked by its
 * 20-byte address with an EIP-191 proof, permission `evm` only. The rules
 * REPLACE every rule on the owner's account; pass any to keep in `otherRules`.
 */
export function linkAgentMsgs(args: {
  chainId: string;
  owner: string;
  /** The agent account's classical key; the owner holds it as part of the agent account's mnemonic. */
  agentPrivateKey: Hex;
  rule: AgentRule;
  otherRules?: AgentRule[];
  expiryUnix: number;
}): EncodeObject[] {
  const proof = agentLinkProof({ chainId: args.chainId, owner: args.owner, agentPrivateKey: args.agentPrivateKey });
  return kitLinkAgentMsgs({
    chainId: args.chainId,
    owner: args.owner,
    proof,
    rule: args.rule,
    expiryUnix: BigInt(args.expiryUnix),
    label: LINK_LABEL,
    ...(args.otherRules ? { otherRules: args.otherRules } : {}),
  });
}

/** Replace the account's rules (to tighten or loosen the agent's limits without relinking). */
export function setRulesMsg(owner: string, rules: AgentRule[]): EncodeObject {
  const chainForm = rules.map(toChainRule);
  validateSpendingRules(chainForm);
  return msg.abstractaccount.updateSpendingRules({ owner, accountAddress: owner, rules: chainForm });
}

/** Disable the agent's key at once (qore-pq-kit `revokeAgentMsg`). */
export function revokeAgentMsg(owner: string, agentEvmAddress: string): EncodeObject {
  return kitRevokeAgentMsg(owner, agentEvmAddress as Address);
}
