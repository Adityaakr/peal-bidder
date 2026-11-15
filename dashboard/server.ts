/**
 * The dashboard, served locally and read-only.
 *
 *   pnpm dashboard [--port 8788]
 *
 * Reads the agent's receipts log and its PUBLIC receipt key (public.json); it
 * needs no secret. Every request re-reads and re-verifies the log.
 * Transaction links go to QORE_EXPLORER_TX_URL (a prefix the hash is appended
 * to) when set, otherwise to the REST transaction route.
 */
import { createServer } from "node:http";
import { hexToBytes } from "@noble/hashes/utils.js";
import { int, main, out, parseFlags } from "../common/cli.ts";
import { agentPaths, bidderHome } from "../common/home.ts";
import { readAgentPublicInfo } from "../agent/identity.ts";
import { FileSink, verifyReceipts } from "../agent/receipts.ts";
import { renderDashboard, txUrlFor } from "./render.ts";

async function run(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(2));
  const paths = agentPaths(bidderHome());
  const port = int(flags, "port", 8788);
  const txUrl = txUrlFor();

  const page = () => {
    const info = readAgentPublicInfo(paths.publicInfo);
    const check = verifyReceipts(new FileSink(paths.receipts).read(), hexToBytes(info.receiptPublicKey));
    return { info, check };
  };

  createServer((req, res) => {
    try {
      const { info, check } = page();
      if (req.url === "/api/receipts") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(check));
        return;
      }
      if (req.url !== "/" && req.url !== "/index.html") {
        res.writeHead(404).end();
        return;
      }
      const html = renderDashboard({
        agent: info.address,
        owner: info.owner,
        receiptKeyHash: info.receiptKeyHash,
        check,
        txUrl,
        now: Math.floor(Date.now() / 1000),
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`error: ${(err as Error).message}`);
    }
  }).listen(port, "127.0.0.1", () => out({ dashboard: `http://127.0.0.1:${port}`, receipts: paths.receipts }));
}

await main(run);
