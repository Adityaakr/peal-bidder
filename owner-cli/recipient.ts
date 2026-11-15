/**
 * Whom the owner seals a mandate to.
 *
 * On chain (the default): the agent's ML-KEM-1024 key as registered, and its
 * X25519 key from a recipient card verified against both of the agent's
 * registered keys (QoreSeal `resolveRecipient`). The card is also checked
 * against `public.json`, so a stale file is caught.
 *
 * Offline (`--offline`, local runs only): the keys in `public.json`, which
 * nothing on chain vouches for.
 */
import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { RecipientCard, SealRecipient } from "@qorechain/qoreseal";
import { resolveRecipient } from "@qorechain/qoreseal/network";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import type { AgentPublicInfo } from "../agent/identity.ts";

export function readCard(path: string): RecipientCard {
  return JSON.parse(readFileSync(path, "utf8")) as RecipientCard;
}

export function offlineRecipient(info: AgentPublicInfo): SealRecipient {
  return { mlkemPublicKey: hexToBytes(info.mlkemPublicKey), x25519PublicKey: hexToBytes(info.x25519PublicKey) };
}

export async function chainRecipient(args: { rest: string; chainId: string; info: AgentPublicInfo; card: RecipientCard }): Promise<SealRecipient> {
  const { info, card } = args;
  if (card.address !== info.address) throw new Error("the card belongs to another account");
  if (card.x25519PublicKey !== info.x25519PublicKey) throw new Error("the card's X25519 key is not the one in public.json");
  if (card.mlkemKeySha3 !== bytesToHex(sha3_256(hexToBytes(info.mlkemPublicKey)))) {
    throw new Error("the card's ML-KEM key is not the one in public.json");
  }
  return resolveRecipient({ rest: args.rest, chainId: args.chainId, address: info.address, card });
}
