/**
 * The live agent: its mandates, decisions, receipts and refusals, as its signed
 * receipts log tells them, checked in this browser, with each transaction looked
 * up on the chain and the owner's key and spending rule read live.
 */
import type { Address } from "viem";
import { FUSD, FUSD_DECIMALS, REPO } from "../config.ts";
import { readVault } from "../../../../agent/vault.ts";
import { auctionSummary, cosmosTx, evm, pqKeyState, spendingRules } from "../chain.ts";
import { ruleMeaning } from "../rule.ts";
import { loadLive, type LiveEvent, type LiveLog } from "../live.ts";
import { amount, chip, dateTime, errorText, fingerprint, h, hash, icon, kicker, timeOnly, type Child } from "../ui.ts";
import type { PealMandateV1 } from "../../../../common/mandate.ts";

const fusd = (v: string | bigint) => `${amount(BigInt(v), FUSD_DECIMALS)} fUSD`;
const pealt = (v: string) => `${amount(BigInt(v), 18, 2)} PEAL-T`;

/** A transaction hash with its status read from the chain. */
function txLink(txHash: string): HTMLElement {
  const box = h("span.tx", hash(txHash, { label: "transaction hash", keep: 6 }), chip("checking…", "plain", "refresh"));
  if (/^[0-9A-F]{64}$/i.test(txHash) && !txHash.startsWith("0x")) {
    cosmosTx(txHash.toUpperCase())
      .then((t) => {
        box.lastElementChild?.replaceWith(
          !t ? chip("not on this node", "warn") : t.code === 0 ? chip(`in block ${t.height.toLocaleString("en-US")}`, "ok", "chain") : chip(`code ${t.code}`, "bad"),
        );
      })
      .catch(() => box.lastElementChild?.replaceWith(chip("could not check", "warn")));
  } else box.lastElementChild?.remove();
  return box;
}

function limitsOf(m: PealMandateV1): HTMLElement {
  return h(
    "dl.limits",
    h("div", h("dt", "Budget"), h("dd", fusd(m.budget))),
    h("div", h("dt", "Most per bid"), h("dd", fusd(m.maxPerBid))),
    h("div", h("dt", "Highest tick"), h("dd", String(m.maxTick))),
    h("div", h("dt", "Bids"), h("dd", `at most ${m.maxBids}`)),
    h("div", h("dt", "Valid"), h("dd", `${dateTime(m.notBefore).slice(11)} to ${dateTime(m.expiresAt).slice(11)}`)),
    h("div", h("dt", "Auction"), h("dd", ...m.auctions.map((a) => hash(a, { label: "auction" })))),
  );
}

function item(tone: "ok" | "bad" | "accent" | "plain", iconName: string, at: number, title: Child, ...body: Child[]): HTMLElement {
  return h(`li.tl-item.tl-${tone}`, h("span.tl-icon", icon(iconName)), h("div.tl-body", h("div.tl-title", title, h("span.tl-time", timeOnly(at))), ...body));
}

function eventItem(e: LiveEvent): HTMLElement | null {
  switch (e.kind) {
    case "mandate-refused":
      return item(
        "bad",
        "cross",
        e.at,
        h("span", "Mandate refused by the agent ", chip(e.code, "bad")),
        h("p.tl-text", e.message),
        h("p.tl-note", "Nothing was planned or sent. The refusal itself is a signed receipt."),
      );
    case "decision": {
      const d = e.decision;
      const who = e.source === "claude" ? `Claude Opus 5.5${e.model ? ` (${e.model})` : ""}` : e.source === "rules" ? "Rule-based planner" : e.source;
      return item(
        "accent",
        "spark",
        e.at,
        h("span", `Planned by ${who}`),
        e.rationale ? h("blockquote.tl-quote", e.rationale) : null,
        h(
          "div.tl-facts",
          d.kind === "bid" ? chip(`tick ${d.tick} · ${d.qty ? pealt(d.qty) : ""} · ${d.outflow ? fusd(d.outflow) : ""}`, "plain", "agent") : chip(`skip: ${d.reason ?? ""}`, "warn"),
          d.adjustments?.length ? chip(`policy: ${d.adjustments.join(", ").toLowerCase().replace(/_/g, " ")}`, "warn") : chip("policy: in mandate, unchanged", "ok"),
          e.tokens ? h("span.caption", `${e.tokens.input.toLocaleString("en-US")} tokens in, ${e.tokens.output} out`) : null,
        ),
      );
    }
    case "submission":
      return null;
    case "result":
      if (e.status === "landed") return item("ok", "check", e.at, h("span", `Bid landed${e.vault ? " from the vault" : ""}: ${fusd(e.outflow)} at tick ${e.tick}`), e.txHash ? txLink(e.txHash) : null);
      if (e.status === "refused")
        return item("bad", "shield", e.at, h("span", "Refused by the chain ", chip(/^execution reverted/.test(e.reason ?? "") ? (e.vault ? "vault or auction reverted" : "call reverted") : "spending rule", "bad")), h("p.tl-text", (e.reason ?? "").split(":")[0] ?? ""), e.txHash ? txLink(e.txHash) : null, h("p.tl-note", "The transaction was included, its call was refused, and nothing moved. The agent counts it and moves on."));
      return item("plain", "clock", e.at, h("span", `Bid ${e.status}`), e.reason ? h("p.tl-text", e.reason) : null);
    case "claim":
      return item("ok", "check", e.at, h("span", `Claimed bid ${e.bidId}${e.vault ? " to the vault" : ""}: ${pealt(e.allocation)} won`), e.txHash ? txLink(e.txHash) : null);
    default:
      return null;
  }
}

function mandateGroups(l: LiveLog): HTMLElement[] {
  const groups: { m?: Extract<LiveEvent, { kind: "mandate-accepted" }>; items: LiveEvent[] }[] = [];
  let cur: (typeof groups)[number] = { items: [] };
  groups.push(cur);
  for (const e of l.events) {
    if (e.kind === "mandate-accepted") {
      cur = { m: e, items: [] };
      groups.push(cur);
    } else cur.items.push(e);
  }
  return groups
    .filter((g) => g.m || g.items.length)
    .map((g) => {
      const list = h("ol.timeline", ...g.items.map(eventItem).filter((x): x is HTMLElement => x !== null));
      if (!g.m) return h("article.card.mandate-card", h("h3.card-title", "Before any mandate"), list);
      const m = g.m.mandate;
      return h(
        "article.card.mandate-card",
        h(
          "header.mandate-head",
          h("div", h("span.caption", `Mandate ${groups.filter((x) => x.m).indexOf(g) + 1} · accepted ${dateTime(g.m.at)}`), h("h3.card-title", "Signed by the owner, checked against the chain")),
          h("div.mandate-chips", chip("ML-DSA-87 verified by the agent", "ok"), g.m.pinsKey ? chip("pins this receipt key", "ok", "key") : chip("pins another key", "bad")),
        ),
        h("div.mandate-id", h("span.caption", "Mandate hash"), hash(g.m.mandateHash, { label: "mandate hash", keep: 8 })),
        limitsOf(m),
        h("div.instructions", h("span.caption", "Instructions (signed text, advisory: they cannot widen a limit)"), h("p", m.instructions)),
        list,
      );
    });
}

function chainState(l: LiveLog): HTMLElement {
  const owner = l.info.owner;
  const key = h("dd", chip("reading…", "plain", "refresh"));
  pqKeyState(owner)
    .then((r) => key.replaceChildren(r.ok ? chip("ML-DSA-87 on chain, possession proven", "ok") : chip(r.code, "bad")))
    .catch((e) => key.replaceChildren(chip(errorText(e), "warn")));
  const rule = h("dd", chip("reading…", "plain", "refresh"));
  spendingRules(owner)
    .then((rules) => {
      const m = ruleMeaning(rules);
      if (m.kind === "none") return rule.replaceChildren(chip("no spending rule", "warn"));
      const calls = `${m.calls} allowed call${m.calls === 1 ? "" : "s"}`;
      if (m.kind === "vault") {
        rule.replaceChildren(h("div.rule", h("span", "No fUSD: the key may only call the vault's bid, and claim"), h("span.caption", `lists one token the owner does not hold, because an empty list would mean any token · ${calls}`)));
      } else if (m.kind === "budget") {
        rule.replaceChildren(h("div.rule", h("span", m.perBid ? `${fusd(m.perBid)} per bid` : "no per-bid limit", m.daily ? `, ${fusd(m.daily)} a day` : ""), h("span.caption", `fUSD only · ${calls}`)));
      } else rule.replaceChildren(h("div.rule", h("span", m.denoms.join(", ") || "any denom"), h("span.caption", calls)));
    })
    .catch((e) => rule.replaceChildren(chip(errorText(e), "warn")));
  const vault = h("dd", chip("reading…", "plain", "refresh"));
  if (l.info.vault) {
    const address = l.info.vault as Address;
    readVault(evm, address)
      .then((v) => {
        const open = v.remaining.bids > 0n;
        vault.replaceChildren(
          hash(address, { label: "vault" }),
          h(
            "div.rule",
            h("span", `${fusd(v.balance.toString())} held`, open ? ` · ${fusd(v.policy.maxPerBid.toString())} per bid, ${fusd(v.remaining.today.toString())} left today` : " · no bid allowed now"),
            h("span.caption", `${v.approvedAuctions.length} approved auction${v.approvedAuctions.length === 1 ? "" : "s"} · policy ${v.epoch} · withdrawals need the owner's ML-DSA-87 signature · not audited`),
          ),
        );
      })
      .catch((e) => vault.replaceChildren(chip(errorText(e), "warn")));
  }
  const auctions = [...new Set(l.events.flatMap((e) => (e.kind === "mandate-accepted" ? e.mandate.auctions : [])))];
  const auc = h("dd.auction-states");
  for (const a of auctions) {
    const row = h("div", hash(a, { label: "auction" }), chip("reading…", "plain", "refresh"));
    auc.append(row);
    auctionSummary(a as Address)
      .then((x) => row.lastElementChild?.replaceWith(chip(`${x.state}, ${x.bidCount} bid${x.bidCount === 1 ? "" : "s"}`, x.state === "Settled" ? "ok" : x.commitOpen ? "wait" : "plain")))
      .catch(() => row.lastElementChild?.replaceWith(chip("unreadable", "warn")));
  }
  return h(
    "section.card.chain-card",
    h("h3.card-title", "Read from the chain, now"),
    h(
      "dl.kv",
      h("dt", "Owner"),
      h("dd", hash(owner, { label: "owner" })),
      h("dt", "Owner's key"),
      key,
      h("dt", "Agent"),
      h("dd", hash(l.info.address, { label: "agent" }), " ", hash(l.info.evm, { label: "agent EVM address" })),
      h("dt", "Spending rule"),
      rule,
      ...(l.info.vault ? [h("dt", "Vault"), vault] : []),
      h("dt", "Auctions"),
      auc,
    ),
  );
}

function verifyCard(l: LiveLog): HTMLElement {
  const c = l.check;
  return h(
    `section.card.verify-card${c.ok ? "" : ".is-bad"}`,
    h("div.verify-icon", icon(c.ok ? "shield" : "cross")),
    h(
      "div",
      h("h3.card-title", c.ok ? `${c.count} receipts, all verified in your browser` : `The log is broken at line ${c.line}`),
      h(
        "p",
        c.ok
          ? `Each line chains to the one before it, and each ML-DSA-87 signature verifies against the agent's receipt key (checked in ${c.ms} ms). Every mandate pins that key's hash, so the owner chose it.`
          : c.error,
      ),
      h("div.verify-key", fingerprint(l.info.receiptKeyHash), h("span.caption", "Receipt key"), hash(l.info.receiptKeyHash, { label: "receipt key hash", keep: 8 })),
      h("p.caption", `Published ${l.info.publishedAt.replace("T", " ").replace("Z", " UTC")} with `, h("span.mono", "pnpm web:receipts"), ". ", h("a", { href: "/live/receipts.jsonl", download: "receipts.jsonl" }, "Download the log")),
    ),
  );
}

export function agentPage(): HTMLElement {
  const body = h("div.agent-body", h("div.card.loading", h("div.skeleton"), h("div.skeleton.short"), h("div.skeleton")));
  loadLive()
    .then((l) => {
      body.replaceChildren(
        h("div.agent-top", verifyCard(l), chainState(l)),
        h("h2.section-title.small-title", "Mandates and what came of them"),
        ...mandateGroups(l),
      );
    })
    .catch((e) => body.replaceChildren(h("div.note.bad", `Could not load the agent's receipts: ${errorText(e)}`)));
  return h(
    "div.wrap.page",
    h(
      "div.page-head",
      kicker("The live agent"),
      h("h1.page-title", "Every decision, signed. Check it yourself."),
      h(
        "p.lead",
        "This is the owner's own agent on the testnet: Claude Opus 5.5 plans, the policy clamps, the chain enforces. Its receipts are checked here, line by line, and each transaction is looked up on QoreChain as you read.",
      ),
      h("p.caption", "The agent runs on the owner's machine and publishes its log. ", h("a", { href: `${REPO}/blob/main/docs/spikes.md`, target: "_blank", rel: "noopener" }, "How the live run went")),
    ),
    body,
  );
}
