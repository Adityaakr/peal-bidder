/**
 * Record real Claude Opus 5.5 answers (through OpenRouter) for planner
 * scenarios, so tests replay what the model actually said. One request per
 * scenario named; nothing else is called.
 *
 *   pnpm record:openrouter injection-resisted [normal-bid ...]
 *
 * Reads the scenario's auction text from test/fixtures/claude/<name>.json and
 * writes the response to test/fixtures/openrouter-recorded/<name>.json. The
 * key comes from OPENROUTER_API_KEY or ~/.qore-bidder/openrouter.env and is
 * never written or printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addressFromBytes } from "@qorechain/qoresign";
import { buildOpenRouterRequest, httpTransport, openRouterKey } from "../agent/planner/openrouter.ts";
import { EMPTY_LEDGER } from "../agent/policy.ts";
import { buildMandate } from "../common/mandate.ts";
import { FUSD } from "../common/network.ts";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("name at least one scenario from test/fixtures/claude/");
  process.exit(1);
}
const key = openRouterKey();
if (!key) {
  console.error("no OpenRouter key (OPENROUTER_API_KEY or ~/.qore-bidder/openrouter.env); nothing recorded");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "test", "fixtures", "openrouter-recorded");
mkdirSync(outDir, { recursive: true });

// The same limits and auction as the tests (test/helpers.ts, test/auctions.ts), at a fixed time.
const NOW = 1_795_000_000;
const AUCTION = "0x1111111111111111111111111111111111111111";
const mandate = buildMandate({
  owner: addressFromBytes(new Uint8Array(20).fill(1)).bech32,
  agent: addressFromBytes(new Uint8Array(20).fill(2)).bech32,
  quoteToken: FUSD,
  auctions: [AUCTION],
  budget: "500000000",
  maxPerBid: "100000000",
  maxTick: 40,
  maxBids: 5,
  notBefore: NOW - 60,
  expiresAt: NOW + 86_400,
  nonce: 1,
  receiptKey: "0".repeat(64),
  instructions: "Buy PEAL-T in the treasury buyback. Prefer a fair price; never chase the top tick.",
});

const send = httpTransport(key);
for (const name of names) {
  const f = JSON.parse(readFileSync(join(root, "test", "fixtures", "claude", `${name}.json`), "utf8")) as { auction_details: string };
  const view = {
    address: AUCTION,
    quoteToken: FUSD.toLowerCase(),
    saleDecimals: 18,
    reservePrice: 100_000n,
    tickSize: 10_000n,
    numTicks: 64,
    minQuantity: 10n ** 18n,
    maxPerAddress: 0n,
    supply: 1_000_000n * 10n ** 18n,
    bidBond: 1_000_000n,
    commitOpen: true,
    commitEnd: NOW + 3600,
    name: "Peal Tender buyback #1",
    details: f.auction_details,
  };
  const res = await send(buildOpenRouterRequest({ mandate, auctions: [view], ledger: EMPTY_LEDGER, now: NOW }));
  const out = {
    provenance: `recorded from OpenRouter (${res.json.model ?? "?"}) on ${new Date().toISOString().slice(0, 10)} by scripts/record-openrouter.ts`,
    name,
    auction_details: f.auction_details,
    status: res.status,
    response: res.json,
  };
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  const u = res.json.usage;
  console.log(`${name}: HTTP ${res.status}, ${res.json.choices?.[0]?.finish_reason ?? "no choice"}, ${u?.prompt_tokens ?? "?"} in / ${u?.completion_tokens ?? "?"} out`);
}
