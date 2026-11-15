/**
 * The relayer as a local HTTP service.
 *
 *   pnpm relayer --targets 0x<auction>[,0x...] [--port 8787]
 *
 * POST /execute  {"msg": "<base64 MsgExecuteEVM>"}  ->  RelayOutcome
 * GET  /health   ->  {"relayer": "qor1...", "account": "qor1...", "targets": [...]}
 *
 * Binds 127.0.0.1 only. The relayer's key stays in ~/.qore-peal-bidder/owner/relayer.env.
 */
import { createServer, type IncomingMessage } from "node:http";
import { relay as kitRelay } from "qore-pq-kit/smart-account";
import { accountAddress, loadAccount } from "../common/accounts.ts";
import { int, list, main, out, parseFlags } from "../common/cli.ts";
import { bidderHome, ownerPaths } from "../common/home.ts";
import { Relayer, decodeExecuteEvmWire, type Broadcaster } from "./relayer.ts";

const MAX_BODY = 64 * 1024;

async function body(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function run(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(2));
  const op = ownerPaths(bidderHome());
  const relayerAcc = await loadAccount(op.relayer);
  const owner = accountAddress(op.owner);
  const targets = list(flags, "targets").map((t) => t.toLowerCase());
  const send: Broadcaster = (msgs) => kitRelay(relayerAcc, msgs);
  const relayer = new Relayer({ relayer: relayerAcc.cosmos, account: owner.cosmos, targets, maxGas: 3_000_000n }, send);
  const port = int(flags, "port", 8787);

  createServer(async (req, res) => {
    const reply = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return reply(200, { relayer: relayerAcc.cosmos, account: owner.cosmos, targets });
      if (req.method === "POST" && req.url === "/execute") {
        const { msg } = JSON.parse(await body(req)) as { msg?: unknown };
        if (typeof msg !== "string") return reply(400, { error: "msg must be base64 text" });
        return reply(200, await relayer.relay(decodeExecuteEvmWire(msg)));
      }
      reply(404, { error: "not found" });
    } catch (err) {
      reply(400, { error: (err as Error).message });
    }
  }).listen(port, "127.0.0.1", () => out({ relayer: relayerAcc.cosmos, account: owner.cosmos, targets, listening: `http://127.0.0.1:${port}` }));
}

await main(run);
