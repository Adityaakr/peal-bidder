/**
 * Owner side of the brake (agent/control.ts): `pnpm owner pause` and
 * `pnpm owner resume` sign in to the running agent with Sign In With QoreChain.
 *
 * The agent issues a nonce; the owner signs a SIWQ message for the agent's
 * domain, naming the action and the agent as resources, with both of the
 * owner's keys (secp256k1 over the ADR-36 document, ML-DSA-87 over
 * "qorechain-siwq-v1|" + message). The message expires after five minutes.
 */
import { createSiwqMessage, signSiwq, type ClassicalKey, type PqKeyPair, type SiwqSignature } from "@qorechain/qoresign";
import { actionResource, agentResource, type ControlAction } from "../agent/control.ts";

const STATEMENTS: Record<ControlAction, string> = {
  pause: "Pause my Peal Bidder agent. It places no new bid until I resume it.",
  resume: "Resume my Peal Bidder agent, within its mandate.",
};

export interface OwnerSigner {
  address: string;
  classicalKey: ClassicalKey;
  pqKey: Pick<PqKeyPair, "secretKey">;
}

export function controlRequest(args: {
  owner: OwnerSigner;
  agent: string;
  action: ControlAction;
  /** The agent's control endpoint, e.g. `http://127.0.0.1:8789`. */
  url: string;
  chainId: string;
  nonce: string;
  now?: Date;
}): { message: string; signature: SiwqSignature } {
  const base = new URL(args.url);
  const now = args.now ?? new Date();
  const message = createSiwqMessage({
    domain: base.host,
    scheme: base.protocol.replace(/:$/, ""),
    address: args.owner.address,
    statement: STATEMENTS[args.action],
    uri: new URL("/siwq/control", base).toString(),
    version: "1",
    chainId: args.chainId,
    nonce: args.nonce,
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60_000).toISOString(),
    resources: [actionResource(args.action), agentResource(args.agent)],
  });
  const signature = signSiwq({ message, classicalKey: args.owner.classicalKey, pqKey: args.owner.pqKey });
  return { message, signature };
}

/** Ask the agent for a nonce, sign the action, send it; returns the agent's answer. */
export async function sendControl(args: {
  owner: OwnerSigner;
  agent: string;
  action: ControlAction;
  url: string;
  chainId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ paused: boolean; since: number | null; action: ControlAction }> {
  const f = args.fetchImpl ?? fetch;
  const nonceRes = await f(new URL("/siwq/nonce", args.url));
  if (!nonceRes.ok) throw new Error(`the agent did not issue a nonce (HTTP ${nonceRes.status})`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const body = controlRequest({ owner: args.owner, agent: args.agent, action: args.action, url: args.url, chainId: args.chainId, nonce });
  const res = await f(new URL("/siwq/control", args.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await res.json()) as { paused: boolean; since: number | null; action: ControlAction; error?: string; message?: string };
  if (!res.ok) throw new Error(`the agent refused: ${answer.error ?? res.status}${answer.message ? `: ${answer.message}` : ""}`);
  return answer;
}
