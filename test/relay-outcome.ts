/** Turn a delivered transaction into qore-pq-kit's relay outcome, as its \`relay\` does. */
import { decodeAuthenticatorExecutions, type BroadcastResult, type EncodeObject } from "@qorechain/sdk";
import type { RelayOutcome } from "qore-pq-kit/smart-account";

export function kitOutcome(res: Pick<BroadcastResult, "transactionHash" | "msgResponses" | "events">, msgs: EncodeObject[]): RelayOutcome {
  return { txHash: res.transactionHash, delivered: true, results: decodeAuthenticatorExecutions(res, msgs) };
}
