/**
 * store.ts - who is connected. Pages subscribe to changes; the wallet drawer and
 * action buttons call in here. Adapted from Peal Tender's wallet store.
 */
import * as guest from "./guest.ts";
import type { QorexAccount } from "./qorex.ts";

export interface WalletState {
  guest?: guest.Guest;
  owner?: guest.GuestStatus;
  qorex?: QorexAccount;
  metamask?: { address: string; wallet: string; onQoreChain: boolean };
  /** True while the guest's balances are being read. */
  reading: boolean;
  busy?: string;
  log: string[];
  error?: string;
}

export const state: WalletState = { log: [], reading: false };
const listeners = new Set<() => void>();

export function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function emit(): void {
  for (const f of listeners) f();
}

export function log(line: string): void {
  state.log = [...state.log.slice(-30), line];
  emit();
}

export async function refreshGuest(): Promise<void> {
  state.reading = true;
  try {
    state.guest = await guest.load();
    emit();
    state.owner = state.guest ? await guest.status(state.guest.owner) : undefined;
  } catch (e) {
    state.error = `Could not read your guest account: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  } finally {
    state.reading = false;
  }
  emit();
}

/** Open the wallet drawer (set by the drawer module). */
export let openPanel: () => void = () => {};
export function setOpenPanel(f: () => void): void {
  openPanel = f;
}

/** Run one guest action with the drawer's log. Returns true when it went through. */
export async function act(title: string, f: (log: (l: string) => void) => Promise<unknown>): Promise<boolean> {
  if (!state.guest) {
    openPanel();
    state.error = "Create a guest account (or import one) first.";
    emit();
    return false;
  }
  if (state.busy) return false;
  state.busy = title;
  state.error = undefined;
  state.log = [];
  emit();
  openPanel();
  try {
    await f(log);
    log(`${title}: done.`);
    return true;
  } catch (e) {
    state.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return false;
  } finally {
    state.busy = undefined;
    await refreshGuest();
  }
}
