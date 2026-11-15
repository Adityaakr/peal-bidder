import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlags, units } from "../common/cli.ts";
import { createAccount, exportAgentAccount, loadAccount, qoreSignKeys } from "../common/accounts.ts";
import { agentPaths, ownerPaths } from "../common/home.ts";
import { FUSD } from "../common/network.ts";
import { FileAuctionReader, parseAuctionView } from "../agent/auction-file.ts";
import { buildAgent, writeOwnerPublic } from "../agent/cli.ts";
import { initAgentKeys, readAgentPublicInfo } from "../agent/identity.ts";
import { RulePlanner } from "../agent/planner/index.ts";
import { mandateFromFlags } from "../owner-cli/cli.ts";
import { sealMandate, signMandate } from "../owner-cli/mandate.ts";
import { offlineRecipient } from "../owner-cli/recipient.ts";
import { AUCTION_A } from "./helpers.ts";

describe("flags", () => {
  it("parses --name value, --name=value and bare flags", () => {
    expect(parseFlags(["mandate", "x", "--budget", "500", "--max-tick=40", "--offline"])).toEqual({
      positional: ["mandate", "x"],
      flags: { budget: "500", "max-tick": "40", offline: true },
    });
  });

  it("reads fUSD amounts exactly and refuses too many decimals", () => {
    expect(units({ a: "12.5" }, "a", 6)).toBe(12_500_000n);
    expect(units({ a: "0.000001" }, "a", 6)).toBe(1n);
    expect(() => units({ a: "0.0000001" }, "a", 6)).toThrow(/decimals/);
    expect(() => units({ a: "1e6" }, "a", 6)).toThrow();
    expect(() => units({ a: "-1" }, "a", 6)).toThrow();
  });
});

async function setup() {
  const h = mkdtempSync(join(tmpdir(), "peal-bidder-cli-"));
  const op = ownerPaths(h);
  const ag = agentPaths(h);
  const owner = await createAccount(op.owner, "owner");
  await createAccount(op.agentAccount, "agent account");
  await exportAgentAccount(op.agentAccount, ag.account, owner.cosmos);
  writeOwnerPublic(ag, owner.cosmos, (await loadAccount(op.owner)).pqc.publicKey);
  initAgentKeys(ag);
  return { h, op, ag, owner };
}

describe("owner mandate from flags", () => {
  it("builds the mandate the flags describe, in fUSD base units", async () => {
    const { ag, owner } = await setup();
    const info = readAgentPublicInfo(ag.publicInfo);
    const m = mandateFromFlags(
      { auctions: AUCTION_A, budget: "300", "max-per-bid": "100", "max-tick": "40", "max-bids": "3", hours: "2", instructions: "fair price" },
      { owner: owner.cosmos, info, now: 1_795_000_000 },
    );
    expect(m).toMatchObject({
      owner: owner.cosmos,
      agent: info.address,
      quoteToken: FUSD.toLowerCase(),
      auctions: [AUCTION_A],
      budget: "300000000",
      maxPerBid: "100000000",
      maxTick: 40,
      maxBids: 3,
      notBefore: 1_795_000_000,
      expiresAt: 1_795_000_000 + 7200,
      nonce: 1_795_000_000,
      receiptKey: info.receiptKeyHash,
    });
  });

  it("refuses a mandate whose per-bid limit exceeds the budget", async () => {
    const { ag, owner } = await setup();
    const info = readAgentPublicInfo(ag.publicInfo);
    expect(() =>
      mandateFromFlags({ auctions: AUCTION_A, budget: "50", "max-per-bid": "100", "max-tick": "4" }, { owner: owner.cosmos, info, now: 1 }),
    ).toThrow(/maxPerBid/);
  });
});

describe("owner to agent, through the files", () => {
  it("a mandate sealed by the owner is accepted by the agent from its inbox, and receipts are written", async () => {
    const { op, ag, owner } = await setup();
    const info = readAgentPublicInfo(ag.publicInfo);
    const now = Math.floor(Date.now() / 1000);
    const m = mandateFromFlags({ auctions: AUCTION_A, budget: "300", "max-per-bid": "100", "max-tick": "40" }, { owner: owner.cosmos, info, now });
    const ownerAcc = await loadAccount(op.owner);
    const { envelope } = sealMandate({ signed: signMandate(m, qoreSignKeys(ownerAcc)), mandate: m, recipient: offlineRecipient(info) });
    const auctionsFile = join(ag.dir, "auctions.json");
    writeFileSync(
      auctionsFile,
      JSON.stringify([
        {
          address: AUCTION_A,
          quoteToken: FUSD,
          saleDecimals: 18,
          reservePrice: "100000",
          tickSize: "10000",
          numTicks: 64,
          minQuantity: "1000000000000000000",
          maxPerAddress: "0",
          supply: "1000000000000000000000000",
          bidBond: "1000000",
          commitOpen: true,
          commitEnd: now + 3600,
          name: "local",
          details: "",
        },
      ]),
    );
    const { agent } = buildAgent(ag, { offline: true, auctions: auctionsFile, planners: [new RulePlanner()] });
    expect((await agent.receive(envelope)).ok).toBe(true);
    const s = await agent.step();
    expect(s).toMatchObject({ kind: "decided", submit: { status: "dry-run" } });
    // A restarted agent sees the same state, from the receipts on disk.
    const again = buildAgent(ag, { offline: true, auctions: auctionsFile });
    expect(again.agent.state.ledger.bids).toBe(1);
    expect(await again.agent.receive(envelope)).toMatchObject({ ok: false, code: "REPLAYED" });
  });
});

describe("auction file", () => {
  it("parses decimal strings into exact numbers and refuses bad fields", async () => {
    const base = {
      address: AUCTION_A,
      quoteToken: FUSD,
      saleDecimals: 18,
      reservePrice: "100000",
      tickSize: "10000",
      numTicks: 64,
      minQuantity: "1",
      maxPerAddress: "0",
      supply: "123456789012345678901234567890",
      bidBond: "0",
      commitOpen: true,
      commitEnd: 10,
      name: "n",
      details: "d",
    };
    expect(parseAuctionView(base).supply).toBe(123456789012345678901234567890n);
    expect(parseAuctionView(base).quoteToken).toBe(FUSD.toLowerCase());
    expect(() => parseAuctionView({ ...base, supply: 1e30 })).toThrow(/supply/);
    expect(() => parseAuctionView({ ...base, address: "0x12" })).toThrow(/address/);
    expect(() => parseAuctionView({ ...base, commitOpen: "yes" })).toThrow(/commitOpen/);
    const dir = mkdtempSync(join(tmpdir(), "peal-bidder-auctions-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.json"), JSON.stringify([base]));
    expect(await new FileAuctionReader(join(dir, "a.json")).read([AUCTION_A])).toHaveLength(1);
    expect(await new FileAuctionReader(join(dir, "a.json")).read(["0x2222222222222222222222222222222222222222"])).toHaveLength(0);
  });
});
