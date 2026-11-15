/**
 * The agent's command line. It reads only ~/.qore-peal-bidder/agent (QORE_BIDDER_HOME).
 *
 *   pnpm agent init                         make the agent's QoreSeal and receipt keys; write public.json
 *   pnpm agent receive                      open and check every sealed mandate in the inbox
 *   pnpm agent run --auctions <file.json>   plan and (dry-run) bid; --once for one round
 *   pnpm agent status                       the active mandate and what it has committed
 *   pnpm agent receipts                     verify the receipts log
 *
 * --offline (receive): check the owner's signature against owner-public.json
 * instead of the chain. For local runs only; it says so in its output.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@noble/hashes/utils.js";
import { createPublicClient, http } from "viem";
import { int, out, parseFlags, str } from "../common/cli.ts";
import { agentPaths, bidderHome } from "../common/home.ts";
import { network } from "../common/network.ts";
import { BidderAgent, DryRunExecutor } from "./agent.ts";
import { FileAuctionReader } from "./auction-file.ts";
import { initAgentKeys, loadAgentIdentity } from "./identity.ts";
import { ChainPqKeySource, StaticPqKeySource, type PqKeySource } from "./keysource.ts";
import { RulePlanner, claudePlannerFromEnv, type Planner } from "./planner/index.ts";
import { FileSink, ReceiptLog, verifyReceipts } from "./receipts.ts";
import { FileMandateStore } from "./store.ts";

type AgentPaths = ReturnType<typeof agentPaths>;

export const OWNER_PUBLIC_FILE = "owner-public.json";

function keySource(paths: AgentPaths, offline: boolean): PqKeySource {
  if (!offline) return new ChainPqKeySource(createPublicClient({ transport: http(network().evmRpc) }));
  const o = JSON.parse(readFileSync(join(paths.dir, OWNER_PUBLIC_FILE), "utf8")) as { address: string; pqPublicKey: string };
  return new StaticPqKeySource().set(o.address, hexToBytes(o.pqPublicKey));
}

export function buildAgent(paths: AgentPaths, opts: { offline?: boolean; auctions?: string; planners?: Planner[] } = {}) {
  const id = loadAgentIdentity(paths);
  const now = () => Math.floor(Date.now() / 1000);
  const sink = new FileSink(paths.receipts);
  const check = verifyReceipts(sink.read(), id.receiptKey.publicKey);
  if (!check.ok) throw new Error(`the receipts log is broken at line ${check.line}: ${check.error}`);
  const claude = claudePlannerFromEnv();
  const planners = opts.planners ?? (claude ? [claude, new RulePlanner()] : [new RulePlanner()]);
  const executor = new DryRunExecutor();
  const agent = new BidderAgent({
    inbox: {
      network: network(),
      identity: { address: id.account.cosmos, owner: id.account.owner, sealKeys: id.sealKeys, receiptKeyHash: id.receiptKeyHash },
      keys: keySource(paths, opts.offline === true),
      store: new FileMandateStore(paths.nonces, now),
      now,
    },
    receipts: new ReceiptLog(sink, id.receiptKey, id.account.cosmos, now),
    history: check.receipts,
    planners,
    reader: opts.auctions ? new FileAuctionReader(opts.auctions) : { read: async () => [] },
    executor,
    countDryRuns: true,
  });
  return { agent, id, executor, planners };
}

export async function run(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  const { flags } = parseFlags(process.argv.slice(3));
  const paths = agentPaths(bidderHome());

  switch (cmd) {
    case "init": {
      const info = initAgentKeys(paths);
      out({ address: info.address, owner: info.owner, receiptKeyHash: info.receiptKeyHash, publicInfo: paths.publicInfo, next: "pnpm owner register-agent" });
      return;
    }
    case "receive": {
      const offline = flags.offline === true;
      const { agent } = buildAgent(paths, { offline });
      mkdirSync(join(paths.inbox, "done"), { recursive: true, mode: 0o700 });
      const files = existsSync(paths.inbox) ? readdirSync(paths.inbox).filter((f) => f.endsWith(".qoreseal")).sort() : [];
      const results = [];
      for (const f of files) {
        const res = await agent.receive(readFileSync(join(paths.inbox, f), "utf8"));
        renameSync(join(paths.inbox, f), join(paths.inbox, "done", f));
        results.push(res.ok ? { file: f, accepted: res.mandateHash, nonce: res.mandate.nonce } : { file: f, refused: res.code, message: res.message });
      }
      out({ ownerKey: offline ? "owner-public.json (OFFLINE: not read from the chain)" : "pqcKeyStatus on chain", results });
      return;
    }
    case "run": {
      const auctions = str(flags, "auctions");
      const { agent, planners } = buildAgent(paths, { auctions });
      const rounds = flags.once === true ? 1 : int(flags, "rounds", 1);
      const interval = int(flags, "interval", 30);
      const log = [];
      for (let i = 0; i < rounds; i++) {
        const s = await agent.step();
        log.push(
          s.kind === "idle"
            ? { idle: s.why }
            : {
                planner: s.plan.source,
                attempts: s.plan.attempts,
                decision: s.plan.decision.kind === "bid" ? { ...s.plan.decision } : s.plan.decision,
                submit: s.submit,
              },
        );
        if (i + 1 < rounds) await new Promise((r) => setTimeout(r, interval * 1000));
      }
      out({ executor: "dry-run (bids are not sent until the auction is deployed)", planners: planners.map((p) => p.name), log });
      return;
    }
    case "status": {
      const { agent, id } = buildAgent(paths);
      const s = agent.state;
      out({ agent: id.account.cosmos, owner: id.account.owner, mandateHash: s.mandateHash ?? null, mandate: s.mandate ?? null, ledger: s.ledger });
      return;
    }
    case "receipts": {
      const id = loadAgentIdentity(paths);
      const check = verifyReceipts(new FileSink(paths.receipts).read(), id.receiptKey.publicKey);
      out(check.ok ? { ok: true, count: check.count, head: check.head, kinds: check.receipts.map((r) => r.body.kind) } : check);
      return;
    }
    default:
      throw new Error("usage: pnpm agent init|receive|run|status|receipts");
  }
}

/** Owner side, local runs: give the agent the owner's ML-DSA public key for `--offline`. */
export function writeOwnerPublic(paths: AgentPaths, address: string, pqPublicKey: Uint8Array): void {
  writeFileSync(join(paths.dir, OWNER_PUBLIC_FILE), `${JSON.stringify({ address, pqPublicKey: Buffer.from(pqPublicKey).toString("hex") }, null, 2)}\n`);
}
