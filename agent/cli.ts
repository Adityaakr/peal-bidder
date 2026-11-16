/**
 * The agent's command line. It reads only ~/.qore-peal-bidder/agent (QORE_BIDDER_HOME).
 *
 *   pnpm agent init                         make the agent's QoreSeal and receipt keys; write public.json
 *   pnpm agent receive                      open and check every sealed mandate in the inbox
 *   pnpm agent run [--executor dry-run|smart-account|window] [--auctions <file.json> | --factory 0x...]
 *                                           plan and bid; --rounds N --interval S. Auctions come from the
 *                                           chain unless --auctions names a file. The default executor is dry-run.
 *   pnpm agent status                       the active mandate and what it has committed
 *   pnpm agent auctions --factory 0x...     the factory's auctions, and which take bids now (read-only)
 *   pnpm agent serve [--executor ...] [--interval 60] [--claim] [--max-ticks N]
 *                                           the long-running agent: inbox, one planning round and (with --claim)
 *                                           claims, every interval; stops cleanly on SIGINT/SIGTERM
 *                                           --control-port 8789: the owner's pause and resume, by Sign In With
 *                                           QoreChain, on 127.0.0.1 (agent/control.ts)
 *   pnpm agent bids [--path smart-account|window]       the agent's bids on the mandate's auctions, from the chain
 *   pnpm agent claim --executor smart-account|window    claim every unclaimed bid of a finished auction
 *   pnpm agent receipts                     verify the receipts log
 *   pnpm agent audit [--signers qor1..,qor1..] [--published]
 *                                           check the receipts against the chain through the QoreChain MCP
 *                                           server: each transaction's outcome, its hybrid ML-DSA-87 layer, its
 *                                           signer, and the owner's key. --published audits the live agent's log
 *                                           published in apps/web/public/live (no agent folder needed)
 *
 * --offline (receive): check the owner's signature against owner-public.json
 * instead of the chain. For local runs only; it says so in its output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@noble/hashes/utils.js";
import { createPublicClient, http, type Address } from "viem";
import { int, list, out, parseFlags, str } from "../common/cli.ts";
import { agentPaths, bidderHome } from "../common/home.ts";
import { network } from "../common/network.ts";
import { BidderAgent, DryRunExecutor, type BidExecutor } from "./agent.ts";
import { ChainAuctionReader } from "./chain-auction.ts";
import { auctionFactoryAbi } from "./auction-abi.ts";
import { bidderFor, makeExecutor, type ExecutorKind } from "./executors.ts";
import { auctionOutcome, claimAll } from "./claims.ts";
import { auditReceipts } from "./audit.ts";
import { OwnerControl, controlServer, readControlState } from "./control.ts";
import { acquireLock } from "./lock.ts";
import { connectQoreChainMcp } from "./qorechain-mcp.ts";
import { drainInbox, serve } from "./serve.ts";
import type { CallSender } from "./smart-account-executor.ts";
import { FileAuctionReader } from "./auction-file.ts";
import { initAgentKeys, loadAgentIdentity } from "./identity.ts";
import { ChainPqKeySource, StaticPqKeySource, type PqKeySource } from "./keysource.ts";
import { defaultPlanners, type Planner } from "./planner/index.ts";
import { ReceiptLog, verifyReceipts } from "./receipts.ts";
import { FileSink } from "./receipt-file.ts";
import { FileMandateStore } from "./store.ts";

type AgentPaths = ReturnType<typeof agentPaths>;

export const OWNER_PUBLIC_FILE = "owner-public.json";

function keySource(paths: AgentPaths, offline: boolean): PqKeySource {
  if (!offline) return new ChainPqKeySource(createPublicClient({ transport: http(network().evmRpc) }));
  const o = JSON.parse(readFileSync(join(paths.dir, OWNER_PUBLIC_FILE), "utf8")) as { address: string; pqPublicKey: string };
  return new StaticPqKeySource().set(o.address, hexToBytes(o.pqPublicKey));
}

export function buildAgent(
  paths: AgentPaths,
  opts: { offline?: boolean; auctions?: string; factory?: string; planners?: Planner[]; executor?: BidExecutor } = {},
) {
  const id = loadAgentIdentity(paths);
  const now = () => Math.floor(Date.now() / 1000);
  const sink = new FileSink(paths.receipts);
  const check = verifyReceipts(sink.read(), id.receiptKey.publicKey);
  if (!check.ok) throw new Error(`the receipts log is broken at line ${check.line}: ${check.error}`);
  const planners = opts.planners ?? defaultPlanners();
  const executor = opts.executor ?? new DryRunExecutor();
  const net = network();
  const reader = opts.auctions
    ? new FileAuctionReader(opts.auctions)
    : new ChainAuctionReader(createPublicClient({ transport: http(net.evmRpc) }), opts.factory ? { factory: opts.factory as Address } : {});
  const agent = new BidderAgent({
    inbox: {
      network: net,
      identity: { address: id.account.cosmos, owner: id.account.owner, sealKeys: id.sealKeys, receiptKeyHash: id.receiptKeyHash },
      keys: keySource(paths, opts.offline === true),
      store: new FileMandateStore(paths.nonces, now),
      now,
    },
    receipts: new ReceiptLog(sink, id.receiptKey, id.account.cosmos, now),
    history: check.receipts,
    planners,
    reader,
    executor,
    countDryRuns: executor instanceof DryRunExecutor,
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
      acquireLock(paths.lock);
      const offline = flags.offline === true;
      const { agent } = buildAgent(paths, { offline });
      const results = await drainInbox(agent, paths.inbox);
      out({ ownerKey: offline ? "owner-public.json (OFFLINE: not read from the chain)" : "pqcKeyStatus on chain", results });
      return;
    }
    case "serve": {
      acquireLock(paths.lock);
      const id = loadAgentIdentity(paths);
      const net = network();
      const kind = str(flags, "executor", "dry-run") as ExecutorKind;
      if (!["dry-run", "smart-account", "window"].includes(kind)) throw new Error("--executor must be dry-run, smart-account or window");
      const executor = await makeExecutor(kind, {
        id,
        net,
        ...(typeof flags["relayer-url"] === "string" ? { relayerUrl: flags["relayer-url"] } : {}),
        ...(typeof flags.gas === "string" ? { gasLimit: BigInt(int(flags, "gas")) } : {}),
      });
      const offline = flags.offline === true;
      const { agent } = buildAgent(paths, {
        offline,
        ...(typeof flags.auctions === "string" ? { auctions: flags.auctions } : {}),
        ...(typeof flags.factory === "string" ? { factory: flags.factory } : {}),
        executor,
      });
      let claims: Parameters<typeof serve>[0]["claims"];
      if (flags.claim === true) {
        if (kind === "dry-run" || !executor.sendCall) throw new Error("--claim needs --executor smart-account or window");
        claims = {
          client: createPublicClient({ transport: http(net.evmRpc) }),
          bidder: bidderFor(kind, id),
          sender: executor as CallSender,
          receipts: new ReceiptLog(new FileSink(paths.receipts), id.receiptKey, id.account.cosmos),
        };
      }
      const controlPort = typeof flags["control-port"] === "string" ? int(flags, "control-port") : undefined;
      const control = new OwnerControl({
        owner: id.account.owner,
        agent: id.account.cosmos,
        chainId: net.chainId,
        domain: `127.0.0.1:${controlPort ?? 0}`,
        keys: keySource(paths, offline),
        statePath: paths.control,
        receipts: new ReceiptLog(new FileSink(paths.receipts), id.receiptKey, id.account.cosmos),
      });
      const server = controlPort === undefined ? undefined : controlServer(control);
      if (server && controlPort !== undefined) await new Promise<void>((resolve) => server.listen(controlPort, "127.0.0.1", resolve));
      const stop = new AbortController();
      process.once("SIGINT", () => stop.abort());
      process.once("SIGTERM", () => stop.abort());
      console.log(
        JSON.stringify({
          serving: id.account.cosmos,
          owner: id.account.owner,
          executor: kind,
          claims: Boolean(claims),
          paused: control.paused,
          control: controlPort === undefined ? null : `http://127.0.0.1:${controlPort}/siwq`,
        }),
      );
      try {
        const ticks = await serve(
          { agent, inbox: paths.inbox, ...(claims ? { claims } : {}), paused: () => control.paused, log: (l) => console.log(JSON.stringify(l)) },
          { intervalSeconds: int(flags, "interval", 60), ...(typeof flags["max-ticks"] === "string" ? { maxTicks: int(flags, "max-ticks") } : {}), signal: stop.signal },
        );
        console.log(JSON.stringify({ stopped: true, ticks }));
      } finally {
        server?.close();
      }
      return;
    }
    case "run": {
      acquireLock(paths.lock);
      const kind = str(flags, "executor", "dry-run") as ExecutorKind;
      if (!["dry-run", "smart-account", "window"].includes(kind)) throw new Error("--executor must be dry-run, smart-account or window");
      const executor = await makeExecutor(kind, {
        id: loadAgentIdentity(paths),
        net: network(),
        ...(typeof flags["relayer-url"] === "string" ? { relayerUrl: flags["relayer-url"] } : {}),
        ...(typeof flags.gas === "string" ? { gasLimit: BigInt(int(flags, "gas")) } : {}),
      });
      const { agent, planners } = buildAgent(paths, {
        ...(typeof flags.auctions === "string" ? { auctions: flags.auctions } : {}),
        ...(typeof flags.factory === "string" ? { factory: flags.factory } : {}),
        executor,
      });
      if (readControlState(paths.control).paused) {
        throw new Error("the owner has paused this agent (Sign In With QoreChain); it places no bid until the owner resumes it");
      }
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
      out({ executor: kind, auctions: typeof flags.auctions === "string" ? flags.auctions : "chain", planners: planners.map((p) => p.name), log });
      return;
    }
    case "bids":
    case "claim": {
      if (cmd === "claim") acquireLock(paths.lock);
      const id = loadAgentIdentity(paths);
      const net = network();
      const kind = str(flags, cmd === "claim" ? "executor" : "path", "smart-account") as ExecutorKind;
      if (kind !== "smart-account" && kind !== "window") throw new Error("choose smart-account or window");
      const { agent } = buildAgent(paths);
      const mandate = agent.state.mandate;
      if (!mandate) throw new Error("no mandate: nothing to look up");
      const client = createPublicClient({ transport: http(net.evmRpc) });
      const bidder = bidderFor(kind, id);
      const outcomes = [];
      for (const a of mandate.auctions) outcomes.push(await auctionOutcome(client, a, bidder));
      if (cmd === "bids") {
        out({ bidder, outcomes });
        return;
      }
      const executor = await makeExecutor(kind, {
        id,
        net,
        ...(typeof flags["relayer-url"] === "string" ? { relayerUrl: flags["relayer-url"] } : {}),
      });
      if (!executor.sendCall) throw new Error("this executor cannot send claims");
      const sink = new FileSink(paths.receipts);
      const receipts = new ReceiptLog(sink, id.receiptKey, id.account.cosmos);
      const claims = [];
      for (const o of outcomes) claims.push({ auction: o.auction, state: o.state, claims: await claimAll({ outcome: o, sender: executor as CallSender, receipts, mandateHash: agent.state.mandateHash ?? null }) });
      out({ bidder, claims });
      return;
    }
    case "auctions": {
      const factory = str(flags, "factory") as Address;
      const client = createPublicClient({ transport: http(network().evmRpc) });
      const count = await client.readContract({ address: factory, abi: auctionFactoryAbi, functionName: "auctionCount" });
      const list = await client.readContract({ address: factory, abi: auctionFactoryAbi, functionName: "auctionsPaged", args: [0n, count] });
      const now = Number((await client.getBlock()).timestamp);
      const views = await new ChainAuctionReader(client, { factory }).read([...list]);
      out({
        factory,
        chainTime: now,
        auctions: list.map((a) => {
          const v = views.find((x) => x.address === a.toLowerCase());
          return v ? { address: a, open: v.commitOpen, closesIn: v.commitEnd - now, name: v.name } : { address: a, readable: false };
        }),
      });
      return;
    }
    case "status": {
      const { agent, id } = buildAgent(paths);
      const s = agent.state;
      out({ agent: id.account.cosmos, owner: id.account.owner, control: readControlState(paths.control), mandateHash: s.mandateHash ?? null, mandate: s.mandate ?? null, ledger: s.ledger });
      return;
    }
    case "receipts": {
      const id = loadAgentIdentity(paths);
      const check = verifyReceipts(new FileSink(paths.receipts).read(), id.receiptKey.publicKey);
      out(check.ok ? { ok: true, count: check.count, head: check.head, kinds: check.receipts.map((r) => r.body.kind) } : check);
      return;
    }
    case "audit": {
      const published = flags.published === true;
      let lines: string[];
      let publicKey: Uint8Array;
      let owner: string;
      if (published) {
        const dir = new URL("../apps/web/public/live/", import.meta.url);
        const meta = JSON.parse(readFileSync(new URL("agent.json", dir), "utf8")) as { owner: string; receiptPublicKey: string };
        lines = readFileSync(new URL("receipts.jsonl", dir), "utf8").split("\n").filter((l) => l.length > 0);
        publicKey = hexToBytes(meta.receiptPublicKey);
        owner = meta.owner;
      } else {
        const id = loadAgentIdentity(paths);
        lines = new FileSink(paths.receipts).read();
        publicKey = id.receiptKey.publicKey;
        owner = id.account.owner;
      }
      const check = verifyReceipts(lines, publicKey);
      if (!check.ok) throw new Error(`the receipts log is broken at line ${check.line}: ${check.error}`);
      const chain = await connectQoreChainMcp();
      try {
        const report = await auditReceipts(check.receipts, owner, chain, { signers: flags.signers ? list(flags, "signers") : [] });
        out({ receipts: check.count, ...report });
        if (!report.ok) process.exitCode = 1;
      } finally {
        await chain.close();
      }
      return;
    }
    default:
      throw new Error("usage: pnpm agent init|receive|run|status|receipts|audit");
  }
}

/** Owner side, local runs: give the agent the owner's ML-DSA public key for `--offline`. */
export function writeOwnerPublic(paths: AgentPaths, address: string, pqPublicKey: Uint8Array): void {
  writeFileSync(join(paths.dir, OWNER_PUBLIC_FILE), `${JSON.stringify({ address, pqPublicKey: Buffer.from(pqPublicKey).toString("hex") }, null, 2)}\n`);
}
