/**
 * Where keys and state live: outside the repository, under
 * `~/.qore-peal-bidder/` (or `QORE_BIDDER_HOME`), in two separate folders.
 *
 *   owner/   the owner's files. The owner's account, the AGENT ACCOUNT's
 *            mnemonic (so the owner, not the agent, holds the agent's
 *            ML-DSA-87 key) and the relayer's account.
 *   agent/   the agent's files. Only the agent account's classical key, its
 *            QoreSeal keys, its receipt key, its inbox, receipts and nonces.
 *
 * In a real deployment the two folders live on different machines; the agent
 * process is only ever given `agent/`. Secret files are mode 0600 in 0700
 * folders, and nothing here prints a secret.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function bidderHome(env: Record<string, string | undefined> = process.env): string {
  return env.QORE_BIDDER_HOME?.trim() || join(homedir(), ".qore-peal-bidder");
}

export function ownerPaths(home = bidderHome()) {
  const dir = join(home, "owner");
  return {
    dir,
    /** The owner's account mnemonic. */
    owner: join(dir, "owner.env"),
    /** The agent account's mnemonic: held by the owner, never given to the agent. */
    agentAccount: join(dir, "agent-account.env"),
    /** The relayer's account mnemonic (it only holds gas). */
    relayer: join(dir, "relayer.env"),
    /** Sealed mandates the owner has written, by nonce. */
    outbox: join(dir, "outbox"),
  };
}

export function agentPaths(home = bidderHome()) {
  const dir = join(home, "agent");
  return {
    dir,
    /** The agent account's classical private key and addresses. No mnemonic. */
    account: join(dir, "agent.env"),
    /** Seeds of the agent's QoreSeal keys and receipt key. */
    keys: join(dir, "keys.env"),
    /** Public half of the agent's keys, for the owner (not secret). */
    publicInfo: join(dir, "public.json"),
    /** The agent's QoreSeal recipient card, signed by the owner with the agent account's keys (not secret). */
    card: join(dir, "card.json"),
    /** Sealed mandates waiting to be read. */
    inbox: join(dir, "inbox"),
    receipts: join(dir, "receipts.jsonl"),
    nonces: join(dir, "nonces.json"),
    /** Paused or not, by the owner's Sign In With QoreChain message (agent/control.ts). */
    control: join(dir, "control.json"),
    /** Held by the one agent process allowed to write (agent/lock.ts). */
    lock: join(dir, "agent.lock"),
  };
}
