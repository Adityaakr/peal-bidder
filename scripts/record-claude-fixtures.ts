/**
 * Record real claude-opus-5-5 responses for the planner scenarios, so the
 * tests replay what the model actually said.
 *
 *   ANTHROPIC_API_KEY=... pnpm record:claude
 *
 * Reads the scenarios in test/fixtures/claude/*.json (their auction text),
 * sends each one to the API exactly as the agent would, and writes the raw
 * response to test/fixtures/claude-recorded/<name>.json. The key is read from
 * the environment only and is never written. About $0.02 to $0.05 per scenario.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildRequest } from "../agent/planner/claude.ts";
import { EMPTY_LEDGER } from "../agent/policy.ts";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { addressFromPublicKey, deriveClassicalKey } from "@qorechain/qoresign";
import { buildMandate } from "../common/mandate.ts";
import { FUSD } from "../common/network.ts";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set; nothing recorded.");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(root, "test", "fixtures", "claude");
const outDir = join(root, "test", "fixtures", "claude-recorded");
mkdirSync(outDir, { recursive: true });

const addr = () => addressFromPublicKey(deriveClassicalKey({ mnemonic: generateMnemonic(wordlist, 256), type: "eth_secp256k1" }).publicKey, "eth_secp256k1").bech32;
// Same limits and auction as the tests (test/helpers.ts, test/auctions.ts), at a fixed time.
const NOW = 1_795_000_000;
const AUCTION = "0x1111111111111111111111111111111111111111";
const mandate = buildMandate({
  owner: addr(),
  agent: addr(),
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

const client = new Anthropic({ apiKey });
const names = new Set<string>();
for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".json"))) {
  const f = JSON.parse(readFileSync(join(srcDir, file), "utf8")) as { name: string; auction_details: string };
  if (names.has(f.auction_details)) continue; // one call per distinct auction text
  names.add(f.auction_details);
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
  const request = buildRequest({ mandate, auctions: [view], ledger: EMPTY_LEDGER, now: NOW });
  const response = await client.beta.messages.create(request);
  const out = {
    provenance: `recorded from ${response.model} on ${new Date().toISOString().slice(0, 10)} by scripts/record-claude-fixtures.ts`,
    name: f.name,
    auction_details: f.auction_details,
    response,
  };
  writeFileSync(join(outDir, `${f.name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${f.name}: ${response.stop_reason}, ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
}
