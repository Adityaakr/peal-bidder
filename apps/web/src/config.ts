/**
 * config.ts - where the app talks to, and the contracts and accounts it shows.
 *
 * The EVM RPC allows browser calls from any origin (qore-pq-kit spike S4); the
 * REST API and the CometBFT RPC send no CORS headers, so the app reaches them
 * through same-origin paths that the host forwards: Vite's dev server locally
 * (`apps/web/vite.config.ts`) and Vercel rewrites when hosted (`vercel.json`).
 * Both forward only to these two public testnet endpoints and hold no keys.
 */
import type { Address } from "viem";

export const CHAIN_ID = "qorechain-diana";
export const EVM_CHAIN_ID = 9800;
export const EVM_RPC = "https://evm-testnet.qore.host";
export const REST = `${location.origin}/api/qore/rest`;
export const COMET_RPC = `${location.origin}/api/qore/rpc`;

/** Peal Sealed Auction's testnet deployment (its deployments/qorechain-diana.json, 16 November 2026). */
export const FACTORY = "0x1160ab95b570a65bbadb488c76e2f8515f3d6562" as Address;
export const REGISTRY = "0x95ea32ba3077070a562a9f7ad2e969f231689bae" as Address;
/** The committee set was registered at block 10,183,212; its MemberJoined events are read from here on. */
export const REGISTRY_FROM_BLOCK = 10_183_000n;
export const PEAL_T = "0x7edc65adc95de061887ecd6fc8629f2a99fffe9e" as Address;

/** fUSD, the fest's token: 6 decimals; the faucet pays it as the bank coin below. */
export const FUSD = "0x97143b771d34ddb9130b807b135ae675a5a963ca" as Address;
export const FUSD_DECIMALS = 6;
export const FUSD_DENOM = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";

/**
 * The auction a rehearsal is modelled on when no auction is taking bids: the
 * Bidder's second live demo auction (closed 16 November 2026). Its numbers and
 * its committee are read from the chain; the rehearsal treats it as open and
 * sends nothing.
 */
export const PRACTICE_AUCTION = "0xe5fc1b2fc5de7eeb39620915be9c1037467abe76" as Address;

/** Limits a visitor's mandate may not exceed on this page (fUSD and counts). */
export const GUEST_LIMITS = { budget: 20, maxPerBid: 10, maxBids: 3, hours: 24, instructions: 500 } as const;

export const DASHBOARD_FAUCET = "https://dashboard.qorechain.io/faucet";
export const QOREX_HELP = "https://docs.qorechain.io/qorex/browser-extension";
export const REPO = "https://github.com/Adityaakr/peal-bidder";
export const KIT = "https://github.com/Adityaakr/qore-pq-kit";
export const TENDER = "https://github.com/Adityaakr/peal-tender";
export const AUCTION_REPO = "https://github.com/Adityaakr/peal-sealed-auction";

/** Fees the kit uses on the testnet: a fixed native fee, EVM at up to 200 gwei. */
export const NATIVE_FEE = { amount: [{ denom: "uqor", amount: "150000" }], gas: "1000000" };
export const MAX_FEE_PER_GAS = 200_000_000_000n;
export const MAX_PRIORITY_FEE_PER_GAS = 12_500_000_000n;
