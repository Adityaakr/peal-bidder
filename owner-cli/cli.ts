/**
 * The owner's command line.
 *
 *   pnpm run owner init                  make the owner, agent-account and relayer accounts; give the agent its classical key
 *   pnpm run owner status                what the chain says about the three accounts
 *   pnpm run owner register              register ML-DSA-87 keys (owner, agent account, relayer) where missing
 *   pnpm run owner register-agent        publish the agent's ML-KEM key and sign its recipient card (after `pnpm agent init`)
 *   pnpm run owner mandate ...           write, sign and seal a mandate to the agent
 *   pnpm run owner window open|close     open or close the agent's scoped EVM window
 *   pnpm run owner convert --amount 500  turn the owner's fUSD bank coins (as the faucet pays them) into ERC-20 fUSD
 *   pnpm run owner approve ...           approve fUSD to an auction (from the owner; --from agent on the fallback path)
 *   pnpm run owner fund-agent ...        fallback path: move fUSD from the owner to the agent's account
 *   pnpm run owner link ...              link the agent's key to the owner's account under a spending rule
 *   pnpm run owner rules ...             replace the spending rule
 *   pnpm run owner revoke                revoke the agent's key at once
 *   pnpm run owner topup --qor 2 [--slippage-bps 100] [--max-impact-bps 100] [--no-convert] [--dry-run]
 *                                    swap QOR for fUSD on the AMM and convert the minimum out to ERC-20, in one transaction
 *   pnpm run owner vault init|gas|deploy|policy|fund|status|revoke|sweep|exit
 *                                    the vault that holds the budget (docs/vault.md; NOT AUDITED, testnet only)
 *   pnpm run owner link --vault 0x… / rules --vault 0x…   the rule that lists no token the owner holds
 *   pnpm run owner pause|resume [--agent-url http://127.0.0.1:8789]
 *                                    pause or resume the running agent, signed in with Sign In With QoreChain
 *
 * Keys stay in ~/.qore-peal-bidder/owner (QORE_BIDDER_HOME). Nothing is printed but addresses and hashes.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network as kitNetwork, publicClient } from "qore-pq-kit";
import type { Address, Hex } from "viem";
import { accountAddress, createAccount, exportAgentAccount, loadAccount, qoreSignKeys } from "../common/accounts.ts";
import { int, list, out, parseFlags, str, units, type Flags } from "../common/cli.ts";
import { agentPaths, bidderHome, ownerPaths } from "../common/home.ts";
import { buildMandate, type PealMandateV1 } from "../common/mandate.ts";
import { FBTC, FUSD, FUSD_DECIMALS, FUSD_DENOM, PEAL_FACTORY, network } from "../common/network.ts";
import { parseVaultAddress, readVault } from "../agent/vault.ts";
import { readAgentPublicInfo, type AgentPublicInfo } from "../agent/identity.ts";
import { writeOwnerPublic } from "../agent/cli.ts";
import {
  accountStatus,
  approveQuote,
  closeWindow,
  convertQuote,
  erc20Balance,
  sendOwnerFestMsgs,
  transferQuote,
  openWindow,
  registerAgentKem,
  registerPqKey,
  sendOwnerMsgs,
  signAgentCard,
} from "./chain.ts";
import { sendControl } from "./control.ts";
import { UQOR, findPool, planTopup, quoteExactIn, topupMsgs } from "./topup.ts";
import { sealMandate, signMandate } from "./mandate.ts";
import { chainRecipient, offlineRecipient, readCard } from "./recipient.ts";
import {
  COMMIT_BID_SIGNATURE,
  linkAgentMsgs,
  revokeAgentMsg,
  selectorOf,
  setRulesMsg,
  spendingRuleFor,
  vaultRuleFor,
} from "./smart-account.ts";
import { approvalsFor, checkDeployed, checkGasAccount, checkUnheld, deployVault, exitVault, revokeVault, setVaultPolicy, sweepVault } from "./vault.ts";

/** Where the rule's limits were each refused on chain, and what they do not bound. */
const NOTE = "the fUSD limits, the call allowlist and the key expiry were each refused on the testnet (docs/spikes.md); a listed token can also be transferred by the linked key, within the limits (THREAT_MODEL.md)";

const VAULT_NOTE = "the rule lists no token the owner holds: the linked key can call vault.bid and claim, and cannot transfer or approve fUSD. The vault is new code and not audited (docs/vault.md, THREAT_MODEL.md)";

/** Build a mandate from command-line flags. Amounts are whole fUSD; times are hours from `now`. */
export function mandateFromFlags(flags: Flags, ctx: { owner: string; info: AgentPublicInfo; now: number }): PealMandateV1 {
  const startsIn = int(flags, "starts-in-minutes", 0);
  const notBefore = ctx.now + startsIn * 60;
  return buildMandate({
    owner: ctx.owner,
    agent: ctx.info.address,
    quoteToken: str(flags, "quote-token", FUSD),
    auctions: list(flags, "auctions"),
    budget: units(flags, "budget", FUSD_DECIMALS).toString(),
    maxPerBid: units(flags, "max-per-bid", FUSD_DECIMALS).toString(),
    maxTick: int(flags, "max-tick"),
    maxBids: int(flags, "max-bids", 5),
    notBefore,
    expiresAt: notBefore + int(flags, "hours", 24) * 3600,
    nonce: int(flags, "nonce", ctx.now),
    receiptKey: ctx.info.receiptKeyHash,
    instructions: str(flags, "instructions", ""),
  });
}

function commitBidSelector(flags: Flags): Hex {
  const sel = flags["commit-bid-selector"];
  if (typeof sel === "string") return selectorOf(sel);
  return selectorOf(str(flags, "commit-bid-signature", COMMIT_BID_SIGNATURE));
}

export async function run(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2);
  const { flags } = parseFlags(process.argv.slice(3));
  const home = bidderHome();
  const op = ownerPaths(home);
  const ag = agentPaths(home);
  const net = network();
  if (kitNetwork().chainId !== net.chainId) throw new Error("qore-pq-kit and this repository disagree on the network");

  switch (cmd) {
    case "init": {
      mkdirSync(op.dir, { recursive: true, mode: 0o700 });
      mkdirSync(ag.dir, { recursive: true, mode: 0o700 });
      const owner = existsSync(op.owner) ? accountAddress(op.owner) : await createAccount(op.owner, "owner");
      const agentAccount = existsSync(op.agentAccount)
        ? accountAddress(op.agentAccount)
        : await createAccount(op.agentAccount, "agent account (held by the owner)");
      const relayer = existsSync(op.relayer) ? accountAddress(op.relayer) : await createAccount(op.relayer, "relayer (gas only)");
      if (!existsSync(ag.account)) await exportAgentAccount(op.agentAccount, ag.account, owner.cosmos);
      // For local runs (`pnpm agent receive --offline`): the owner's public ML-DSA key, which the chain would otherwise supply.
      writeOwnerPublic(ag, owner.cosmos, (await loadAccount(op.owner)).pqc.publicKey);
      out({ home, owner, agentAccount, relayer, next: "fund these accounts with test QOR, then: pnpm agent init; pnpm run owner register" });
      return;
    }
    case "status": {
      const who = [
        ["owner", op.owner],
        ["agentAccount", op.agentAccount],
        ["relayer", op.relayer],
      ] as const;
      const result: Record<string, unknown> = {};
      for (const [name, path] of who) {
        const a = accountAddress(path);
        result[name] = await accountStatus(a.cosmos, a.evm);
      }
      out(result);
      return;
    }
    case "register": {
      const result: Record<string, unknown> = {};
      for (const [name, path] of [
        ["owner", op.owner],
        ["agentAccount", op.agentAccount],
        ["relayer", op.relayer],
      ] as const) {
        const tx = await registerPqKey(await loadAccount(path));
        result[name] = tx ?? "already registered";
      }
      out(result);
      return;
    }
    case "register-agent": {
      const agentAccount = await loadAccount(op.agentAccount);
      const info = readAgentPublicInfo(ag.publicInfo);
      const kem = await registerAgentKem(agentAccount, info);
      const card = signAgentCard(agentAccount, info);
      writeFileSync(ag.card, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o644 });
      out({ kem: kem ?? "already registered", card: ag.card });
      return;
    }
    case "mandate": {
      const owner = await loadAccount(op.owner);
      const info = readAgentPublicInfo(ag.publicInfo);
      if (info.owner !== owner.cosmos) throw new Error("the agent serves another owner");
      const mandate = mandateFromFlags(flags, { owner: owner.cosmos, info, now: Math.floor(Date.now() / 1000) });
      const offline = flags.offline === true;
      const recipient = offline
        ? offlineRecipient(info)
        : await chainRecipient({ rest: net.rest, chainId: net.chainId, info, card: readCard(ag.card) });
      const signed = signMandate(mandate, qoreSignKeys(owner));
      const { envelope, mandateHash } = sealMandate({ signed, mandate, recipient });
      mkdirSync(op.outbox, { recursive: true, mode: 0o700 });
      const file = join(op.outbox, `${mandate.nonce}.qoreseal`);
      writeFileSync(file, `${envelope}\n`, { mode: 0o600 });
      let delivered: string | undefined;
      if (flags.deliver === true) {
        mkdirSync(ag.inbox, { recursive: true, mode: 0o700 });
        delivered = join(ag.inbox, `${mandate.nonce}.qoreseal`);
        copyFileSync(file, delivered);
      }
      out({ mandateHash, nonce: mandate.nonce, file, delivered, recipient: offline ? "public.json (offline, not checked on chain)" : "on-chain KEM key + verified card", mandate });
      return;
    }
    case "window": {
      const agentAccount = await loadAccount(op.agentAccount);
      if (sub === "open") {
        out(
          await openWindow(agentAccount, {
            targets: list(flags, "targets"),
            blocks: int(flags, "blocks", 3600),
            maxTxs: int(flags, "max-txs", 5),
            gasPerTx: BigInt(int(flags, "gas-per-tx", 1_500_000)),
          }),
        );
      } else if (sub === "close") {
        out((await closeWindow(agentAccount)) ?? "no window to close");
      } else throw new Error("usage: pnpm run owner window open|close");
      return;
    }
    case "approve": {
      const from = str(flags, "from", "owner");
      if (from !== "owner" && from !== "agent") throw new Error("--from must be owner or agent");
      const acc = await loadAccount(from === "owner" ? op.owner : op.agentAccount);
      out(await approveQuote(acc, str(flags, "token", FUSD), str(flags, "spender"), units(flags, "amount", FUSD_DECIMALS)));
      return;
    }
    case "convert": {
      const owner = await loadAccount(op.owner);
      out(await convertQuote(owner, str(flags, "denom", FUSD_DENOM), units(flags, "amount", FUSD_DECIMALS)));
      return;
    }
    case "fund-agent": {
      const owner = await loadAccount(op.owner);
      out(await transferQuote(owner, str(flags, "token", FUSD), accountAddress(op.agentAccount).evm, units(flags, "amount", FUSD_DECIMALS)));
      return;
    }
    case "link":
    case "rules": {
      const owner = await loadAccount(op.owner);
      const info = readAgentPublicInfo(ag.publicInfo);
      const mandate = mandateFromFlags(flags, { owner: owner.cosmos, info, now: Math.floor(Date.now() / 1000) });
      const daily = flags["daily-limit"] ? units(flags, "daily-limit", FUSD_DECIMALS) : undefined;
      const vault = flags.vault === undefined ? undefined : parseVaultAddress(str(flags, "vault"));
      const note = vault ? VAULT_NOTE : NOTE;
      let rule;
      if (vault) {
        if (daily !== undefined) throw new Error("with --vault the daily limit is the vault's: pnpm run owner vault policy --daily");
        const unheldToken = str(flags, "unheld-token", FBTC) as Address;
        await checkUnheld(unheldToken, owner);
        rule = vaultRuleFor({ vault, auctions: mandate.auctions, unheldToken, quoteToken: mandate.quoteToken });
      } else {
        rule = spendingRuleFor(mandate, commitBidSelector(flags), daily === undefined ? {} : { dailyLimit: daily });
      }
      let msgs;
      if (cmd === "link") {
        const agentAccount = await loadAccount(op.agentAccount);
        msgs = linkAgentMsgs({
          chainId: net.chainId,
          owner: owner.cosmos,
          agentPrivateKey: agentAccount.privateKey as Hex,
          rule,
          expiryUnix: mandate.expiresAt,
        });
      } else {
        msgs = [setRulesMsg(owner.cosmos, [rule])];
      }
      if (flags["dry-run"] === true) {
        out({ note, rule, messages: msgs.map((m) => m.typeUrl) });
        return;
      }
      out({ note, rule, tx: await sendOwnerMsgs(owner, msgs) });
      return;
    }
    case "vault": {
      await vaultCommand(sub, flags, op);
      return;
    }
    case "revoke": {
      const owner = await loadAccount(op.owner);
      out({ tx: await sendOwnerMsgs(owner, [revokeAgentMsg(owner.cosmos, accountAddress(op.agentAccount).evm)]) });
      return;
    }
    case "topup": {
      const owner = await loadAccount(op.owner);
      const rest = network().rest;
      const pool = await findPool(rest, FUSD_DENOM, UQOR);
      const quote = await quoteExactIn(rest, pool.id, UQOR, units(flags, "qor", 6));
      const plan = planTopup(quote, { slippageBps: int(flags, "slippage-bps", 100), maxImpactBps: int(flags, "max-impact-bps", 100) });
      const convert = flags["no-convert"] !== true;
      const msgs = topupMsgs(owner.cosmos, owner.evm, FUSD_DENOM, plan, convert);
      const summary = {
        pool: pool.id,
        qorIn: quote.amountIn.toString(),
        quotedFusdOut: quote.amountOut.toString(),
        fee: quote.fee.toString(),
        impactBps: quote.impactBps,
        minOut: plan.minOut.toString(),
        convertedToErc20: convert ? plan.minOut.toString() : "0",
        messages: msgs.map((m) => m.typeUrl),
      };
      if (flags["dry-run"] === true) {
        out({ dryRun: true, ...summary });
        return;
      }
      const before = await erc20Balance(FUSD, owner.evm);
      const tx = await sendOwnerFestMsgs(owner, msgs);
      out({ ...tx, ...summary, erc20Before: before.toString(), erc20After: (await erc20Balance(FUSD, owner.evm)).toString() });
      return;
    }
    case "pause":
    case "resume": {
      const owner = qoreSignKeys(await loadAccount(op.owner));
      const info = readAgentPublicInfo(agentPaths(home).publicInfo);
      const answer = await sendControl({
        owner,
        agent: info.address,
        action: cmd,
        url: str(flags, "agent-url", "http://127.0.0.1:8789"),
        chainId: network().chainId,
      });
      out({ agent: info.address, ...answer, signedIn: "Sign In With QoreChain (secp256k1 + ML-DSA-87), checked by the agent against your key on chain" });
      return;
    }
    default:
      throw new Error("usage: pnpm run owner init|status|register|register-agent|mandate|window|convert|approve|fund-agent|link|rules|revoke|vault|topup|pause|resume");
  }
}

/** `pnpm run owner vault …`: each prints addresses and transaction hashes only. */
async function vaultCommand(sub: string | undefined, flags: Flags, op: ReturnType<typeof ownerPaths>): Promise<void> {
  const owner = accountAddress(op.owner);
  const ownerEvm = owner.evm as Address;
  const vaultAddress = (): Address =>
    parseVaultAddress(typeof flags.vault === "string" ? flags.vault : existsSync(op.vault) ? (JSON.parse(readFileSync(op.vault, "utf8")) as { vault: string }).vault : str(flags, "vault"));
  switch (sub) {
    case "init": {
      const gas = existsSync(op.vaultGas) ? accountAddress(op.vaultGas) : await createAccount(op.vaultGas, "vault gas account (deploys the vault, carries signed actions; gas only)");
      out({ vaultGas: gas, next: "pnpm run owner vault gas --qor 4" });
      return;
    }
    case "gas": {
      // Native QOR from the owner, then the gas account's own ML-DSA-87 key: its windows need one.
      const gas = await loadAccount(op.vaultGas);
      const amount = units(flags, "qor", 6, "4");
      const sent = await sendOwnerMsgs(await loadAccount(op.owner), [
        { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: owner.cosmos, toAddress: gas.cosmos, amount: [{ denom: "uqor", amount: amount.toString() }] } },
      ]);
      out({ vaultGas: gas.cosmos, sent, registered: (await registerPqKey(gas)) ?? "already registered" });
      return;
    }
    case "deploy": {
      if (existsSync(op.vault) && flags.again !== true) throw new Error(`${op.vault} already names a vault; --again deploys another`);
      const gas = await loadAccount(op.vaultGas);
      const args = { owner: ownerEvm, quote: str(flags, "quote-token", FUSD) as Address, factory: str(flags, "factory", PEAL_FACTORY) as Address };
      await checkGasAccount(gas, owner.cosmos, [args.quote]);
      const r = await deployVault(gas, args);
      writeFileSync(op.vault, `${JSON.stringify({ vault: r.vault, ...args, txs: r.txs }, null, 2)}\n`, { mode: 0o644 });
      out({ ...r, audited: false, next: "pnpm run owner vault policy …, then vault fund" });
      return;
    }
    case "policy": {
      const gas = await loadAccount(op.vaultGas);
      const vault = vaultAddress();
      await checkGasAccount(gas, owner.cosmos, [FUSD]);
      const v = await checkDeployed(vault, { owner: ownerEvm, quote: FUSD, factory: str(flags, "factory", PEAL_FACTORY) as Address });
      const client = publicClient();
      const approvals = await approvalsFor(client, list(flags, "auctions") as Address[], v.factory, v.quote);
      const policy = {
        // Smart-account lane: the linked key acts as the owner's 0x address. Window lane: --operator agent.
        operator: (flags.operator === "agent" ? accountAddress(op.agentAccount).evm : ownerEvm) as Address,
        expiresAt: (await client.getBlock()).timestamp + BigInt(int(flags, "hours", 24)) * 3600n,
        maxBids: int(flags, "max-bids", 3),
        maxPerBid: units(flags, "max-per-bid", FUSD_DECIMALS),
        dailyLimit: units(flags, "daily-limit", FUSD_DECIMALS, str(flags, "budget")),
        budget: units(flags, "budget", FUSD_DECIMALS),
      };
      if (flags["dry-run"] === true) {
        out({ dryRun: true, vault, policy, approvals });
        return;
      }
      out({ vault, policy, approvals, txs: await setVaultPolicy(await loadAccount(op.owner), gas, vault, policy, approvals) });
      return;
    }
    case "fund": {
      const vault = vaultAddress();
      const v = await checkDeployed(vault, { owner: ownerEvm, quote: FUSD, factory: str(flags, "factory", PEAL_FACTORY) as Address });
      const amount = units(flags, "amount", FUSD_DECIMALS);
      const acc = await loadAccount(op.owner);
      const txs = flags["from-bank"] === true ? [await convertQuote(acc, FUSD_DENOM, amount, vault)] : await transferQuote(acc, FUSD, vault, amount);
      out({ vault, before: v.balance, after: await erc20Balance(FUSD, vault), txs });
      return;
    }
    case "status": {
      const vault = vaultAddress();
      const v = await readVault(publicClient(), vault);
      let code = "the committed artifact";
      try {
        await checkDeployed(vault, { owner: v.owner, quote: v.quote, factory: v.factory });
      } catch (err) {
        code = (err as Error).message;
      }
      out({ ...v, code, audited: false });
      return;
    }
    case "revoke": {
      const vault = vaultAddress();
      out({ vault, txs: await revokeVault(await loadAccount(op.owner), await loadAccount(op.vaultGas), vault), next: "also: pnpm run owner revoke (the agent's linked key)" });
      return;
    }
    case "sweep": {
      const vault = vaultAddress();
      const token = str(flags, "token", FUSD) as Address;
      const amount = flags.all === true ? await erc20Balance(token, vault) : units(flags, "amount", int(flags, "decimals", FUSD_DECIMALS));
      out({ vault, token, amount, to: owner.evm, txs: await sweepVault(await loadAccount(op.owner), await loadAccount(op.vaultGas), vault, token, amount) });
      return;
    }
    case "exit": {
      const vault = vaultAddress();
      out({ vault, txs: await exitVault(await loadAccount(op.vaultGas), vault, str(flags, "token", FUSD) as Address) });
      return;
    }
    default:
      throw new Error("usage: pnpm run owner vault init|gas|deploy|policy|fund|status|revoke|sweep|exit");
  }
}

