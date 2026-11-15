/**
 * The owner's smart-account limits on the agent's linked key: what the chain
 * itself enforces, whatever the agent does.
 *
 * NOT YET PROVEN END TO END. A linked secp256k1 key executing an EVM call
 * (`MsgExecuteEVM`) under a spending rule has no recorded run on the testnet;
 * spike S2 in qore-pq-kit settles it (docs/spikes.md). These builders follow
 * the SDK 0.14.0 documentation and are checked offline with the SDK's own
 * validators. When qore-pq-kit ships its `smart-account` module, the transport
 * moves there; the rule derived from the mandate stays here, because it is
 * Peal Bidder's policy.
 */
import {
  checkValuePermissionRules,
  linkAuthenticatorMsgs,
  msg,
  revokeAuthenticatorMsg,
  signAuthenticatorLinkEip191,
  qorechainTypes,
  validateSpendingRules,
  type EncodeObject,
} from "@qorechain/sdk";
import { hexToBytes, toFunctionSelector, type Hex } from "viem";
import type { PealMandateV1 } from "../common/mandate.ts";
import { COMMIT_BID_SIGNATURE } from "../agent/auction-abi.ts";

export type SpendingRule = ReturnType<typeof qorechainTypes.abstractaccount.SpendingRule.fromPartial>;

/** The rule id this repository writes. */
export const RULE_ID = "peal-bidder";
/** The one permission the agent's key gets: EVM calls. No `send`, no `deploy`, no `all`. */
export const AGENT_PERMISSIONS = ["evm"] as const;
export const LINK_LABEL = "peal-bidder-agent";

/** `commitBid`'s signature, from Peal Sealed Auction's contract (`agent/auction-abi.ts`). */
export { COMMIT_BID_SIGNATURE };

export function selectorOf(signatureOrSelector: string): Hex {
  if (/^0x[0-9a-fA-F]{8}$/.test(signatureOrSelector)) return signatureOrSelector.toLowerCase() as Hex;
  return toFunctionSelector(signatureOrSelector);
}

/**
 * The spending rule for a mandate:
 * - the key may move only the quote token (fUSD), as `erc20/<contract>`;
 * - at most `maxPerBid` per execution and `dailyLimit` (default: the budget) per UTC day;
 * - with call data, only `commitBid` on the mandate's auctions.
 *
 * From chain v3.2.2 the EVM lane counts the measured outflow of a call,
 * including allowance changes of a listed ERC-20.
 */
export function spendingRuleFor(mandate: PealMandateV1, commitBidSelector: Hex, opts: { dailyLimit?: bigint } = {}): SpendingRule {
  const denom = `erc20/${mandate.quoteToken}`;
  const daily = opts.dailyLimit ?? BigInt(mandate.budget);
  if (daily <= 0n) throw new Error("the daily limit must be positive");
  const rule: SpendingRule = {
    id: RULE_ID,
    // Rule-level limits are zero: the denom limit below is the only one, and fUSD the only denom.
    dailyLimit: "0",
    perTxLimit: "0",
    allowedDenoms: [denom],
    enabled: true,
    allowedEvmCalls: mandate.auctions.map((a) => `${a}/${commitBidSelector}`),
    denomLimits: [{ denom, perTxLimit: mandate.maxPerBid, dailyLimit: daily.toString() }],
  };
  validateSpendingRules([rule]);
  checkValuePermissionRules([...AGENT_PERMISSIONS], [rule]);
  return rule;
}

/**
 * `[MsgUpdateSpendingRules, MsgRegisterAuthenticator]`, for ONE transaction
 * signed by the owner. The agent's key is linked by its 20-byte EVM address
 * (scheme secp256k1, EIP-191 possession proof), the form the `MsgExecuteEVM`
 * digest uses.
 *
 * `MsgUpdateSpendingRules` replaces the account's rules wholesale, and the
 * first enabled rule bounds every linked key that has no rule of its own: pass
 * every rule the owner's account should keep in `otherRules`.
 */
export function linkAgentMsgs(args: {
  chainId: string;
  owner: string;
  /** The agent account's classical key; the owner holds it as part of the agent account's mnemonic. */
  agentPrivateKey: Hex;
  rule: SpendingRule;
  otherRules?: SpendingRule[];
  expiryUnix: number;
}): EncodeObject[] {
  const proof = signAuthenticatorLinkEip191({ chainId: args.chainId, account: args.owner, privateKey: args.agentPrivateKey });
  return linkAuthenticatorMsgs({
    owner: args.owner,
    chainId: args.chainId,
    scheme: proof.scheme,
    pubkey: proof.pubkey,
    possessionProof: proof.possessionProof,
    permissions: [...AGENT_PERMISSIONS],
    expiryUnix: args.expiryUnix,
    label: LINK_LABEL,
    spendingRules: [args.rule, ...(args.otherRules ?? [])],
  });
}

/** Replace the account's rules (to tighten or loosen the agent's limits without relinking). */
export function setRulesMsg(owner: string, rules: SpendingRule[]): EncodeObject {
  validateSpendingRules(rules);
  return msg.abstractaccount.updateSpendingRules({ owner, accountAddress: owner, rules });
}

/** Disable the agent's key at once. */
export function revokeAgentMsg(owner: string, agentEvmAddress: string): EncodeObject {
  return revokeAuthenticatorMsg({ owner, scheme: "secp256k1", pubkey: hexToBytes(agentEvmAddress.toLowerCase() as Hex) });
}
