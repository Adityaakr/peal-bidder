/**
 * Publish the live agent's receipts log to the web app (`pnpm web:receipts`).
 *
 * Copies `agent/receipts.jsonl` and the public half of the agent's identity
 * into `apps/web/public/live/`, after checking every line's chain and ML-DSA-87
 * signature. The page checks them again in the visitor's browser. Receipts hold
 * no secret: mandate text, planner output, decisions, transaction hashes.
 * Nothing else from the agent's folder is read.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@noble/hashes/utils.js";
import { agentPaths, bidderHome } from "../common/home.ts";
import { readAgentPublicInfo } from "../agent/identity.ts";
import { verifyReceipts } from "../agent/receipts.ts";

const home = bidderHome();
const paths = agentPaths(home);
const info = readAgentPublicInfo(paths.publicInfo);
const lines = readFileSync(paths.receipts, "utf8").split("\n").filter((l) => l.length > 0);
const check = verifyReceipts(lines, hexToBytes(info.receiptPublicKey));
if (!check.ok) throw new Error(`the receipts log is broken at line ${check.line}: ${check.error}`);

const out = join(import.meta.dirname, "..", "apps", "web", "public", "live");
writeFileSync(join(out, "receipts.jsonl"), `${lines.join("\n")}\n`);
writeFileSync(
  join(out, "agent.json"),
  `${JSON.stringify(
    {
      v: 1,
      publishedAt: new Date().toISOString().slice(0, 19) + "Z",
      address: info.address,
      evm: info.evm,
      owner: info.owner,
      receiptPublicKey: info.receiptPublicKey,
      receiptKeyHash: info.receiptKeyHash,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ receipts: check.count, head: check.head, out }, null, 2));
