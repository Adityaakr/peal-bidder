/**
 * qorex.ts - QoreChain's own wallet, through QoreChain's QoreX integrations kit
 * (`@qorechain/qorex-types`): its typed providers, its discovery helpers and its
 * `signAndBroadcast` path.
 *
 * What a page can do with QoreX today (the kit's README, 0.1.0):
 *   - native lane: `enable`, `getKey`, `signAndBroadcast` (QoreX shows the
 *     messages, sets the fee and adds the hybrid secp256k1 + ML-DSA-87
 *     signature); `signDirect` needs a hybrid layer a page cannot build, and
 *     `signArbitrary` is refused;
 *   - EVM lane: announced through EIP-6963 under rdns `network.qore.qorex`
 *     (QoreX never writes `window.ethereum`), accounts only, no signing yet.
 * So here QoreX identifies the visitor and funds their guest account with a QOR
 * transfer they approve in QoreX; the guest account does the EVM actions.
 *
 * After a transfer, QoreX re-reads the committed transaction and reports its
 * "shield": whether the hybrid ML-DSA-87 layer is in it. Anything but
 * `shielded` (or `pending`, still being checked) is reported to the visitor.
 */
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import {
  discoverQorexEip1193,
  getQorexNative,
  hasCapability,
  isQorexInstalled,
  qorexSignAndBroadcast,
  type QorexNativeProvider,
  type QorexSignAndBroadcastResult,
} from "@qorechain/qorex-types";
import { CHAIN_ID } from "../config.ts";

export function available(): boolean {
  return isQorexInstalled() && getQorexNative() !== undefined;
}

export interface QorexAccount {
  cosmos: string;
  evm?: string;
}

function nativeOrThrow(): QorexNativeProvider {
  const native = getQorexNative();
  if (!native) throw new Error("QoreX is not installed in this browser.");
  return native;
}

export async function connect(): Promise<QorexAccount> {
  const native = nativeOrThrow();
  try {
    await native.enable(CHAIN_ID);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unsupported chain|unrecognized chain/i.test(msg)) {
      throw new Error("Switch QoreX to the QoreChain testnet (qorechain-diana), then connect again.");
    }
    throw e;
  }
  const key = await native.getKey(CHAIN_ID);
  const cosmos = key.bech32Address;
  if (!cosmos) throw new Error("QoreX did not return an address.");
  let evm: string | undefined;
  try {
    const provider = await discoverQorexEip1193({ timeoutMs: 500 });
    const accounts = (await provider?.request({ method: "eth_requestAccounts" })) as string[] | undefined;
    evm = accounts?.[0];
  } catch {
    // the EVM side is optional here
  }
  return { cosmos, evm };
}

/** What a committed QoreX transaction says about its hybrid layer, in words for the visitor; null when all is well. */
export function shieldWarning(res: Pick<QorexSignAndBroadcastResult, "shield" | "txHash">): string | null {
  if (res.shield === "shielded" || res.shield === "pending") return null;
  if (res.shield === "downgraded") {
    return `QoreX reports that transaction ${res.txHash} was committed without its ML-DSA-87 layer. Treat this as an alert.`;
  }
  return `QoreX reports the transaction's post-quantum layer as "${String(res.shield)}".`;
}

/** Send `uqor` test QOR from the QoreX account to `to` (a qor1 address); the user approves in QoreX. */
export async function sendQor(
  from: string,
  to: string,
  uqor: bigint,
  native: Pick<QorexNativeProvider, "signAndBroadcast" | "capabilities"> = nativeOrThrow(),
): Promise<{ txHash: string; warning: string | null }> {
  if (native.capabilities !== undefined && !hasCapability(native, "signAndBroadcast")) {
    throw new Error("This version of QoreX cannot send transactions for a page yet; update QoreX.");
  }
  const value = MsgSend.encode(
    MsgSend.fromPartial({ fromAddress: from, toAddress: to, amount: [{ denom: "uqor", amount: uqor.toString() }] }),
  ).finish();
  const res = await qorexSignAndBroadcast(
    {
      chainId: CHAIN_ID,
      messages: [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value }],
      memo: "Peal Bidder: fund my guest account",
      gasLimit: 200_000,
    },
    { native },
  );
  if (res.code !== 0) throw new Error(`QoreX transfer failed (code ${res.code}, tx ${res.txHash})`);
  return { txHash: res.txHash, warning: shieldWarning(res) };
}
