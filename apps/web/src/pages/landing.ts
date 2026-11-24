/**
 * The landing page, in the order docs/design.md (Peal Tender) sets for every Peal
 * entry: hero with the mechanism, proof bar, how it works (step rail), security on
 * the dark band, who uses it, try it, the family band. The footer is shared.
 *
 * Written to read like protocol documentation: real artefacts (the signed mandate,
 * transaction hashes, block heights) shown as data, plain copy, no decoration.
 * Every figure is read from the live agent's receipts (checked in this browser) or
 * from the chain, or is labelled with where it comes from.
 */
import { AUCTION_REPO, KIT, REPO, TENDER } from "../config.ts";
import { attackMap, keyMap, problemPanels, sequence } from "../art/diagrams.ts";
import type { Address } from "viem";
import { evm, spendingRules } from "../chain.ts";
import { readVault } from "../../../../agent/vault.ts";
import { ruleMeaning } from "../rule.ts";
import { loadLive, type LiveLog } from "../live.ts";
import { amount, h, icon, mark, onceVisible, type Child } from "../ui.ts";

/** A section label in the data face, on the section's top rule. */
function label(text: string): HTMLElement {
  return h("p.sec-label", text);
}
import { openPanel } from "../wallet/store.ts";
import { TEST_COUNT } from "../facts.ts";

const LIVE_OWNER = "qor14ndj6q3zp7hku9a4hkjnmhvsk3kegf46g002j5";

// ---------------------------------------------------------------- hero: the mandate itself, annotated

type Line = { k: string; v: string; note?: string; refs?: number[] };

/** The live agent's first mandate (receipt #0), field for field, with what enforces each line. */
const MANDATE: Line[] = [
  { k: "owner", v: '"qor14ndj…g002j5"', refs: [2] },
  { k: "agent", v: '"qor1k7at…fz8lur"' },
  { k: "auctions", v: '["0x481f…e990"]', refs: [3, 4] },
  { k: "budget", v: '"300000000"', note: "300 fUSD", refs: [3, 4] },
  { k: "maxPerBid", v: '"100000000"', note: "100 fUSD", refs: [3, 4] },
  { k: "maxTick", v: "40", refs: [3] },
  { k: "maxBids", v: "3", refs: [3] },
  { k: "expiresAt", v: "1794840918", note: "14:55 UTC", refs: [2] },
  { k: "receiptKey", v: '"3b679d34…f236e0"' },
  { k: "instructions", v: '"Take part in the treasury buyback at a fair price. Never chase the top tick."', note: "advisory" },
];

const LEGEND: [number, string][] = [
  [1, "Signed with ML-DSA-87, sealed with ML-KEM-1024"],
  [2, "Checked against the owner's key on chain"],
  [3, "Clamped by the agent's policy"],
  [4, "Enforced by the chain's spending rule"],
];

function ref(n: number): HTMLElement {
  return h("span.ref", { "aria-label": `layer ${n}` }, String(n));
}

function mandateDoc(): HTMLElement {
  const lines = MANDATE.map((l, i) =>
    h(
      "li.doc-line",
      h("span.doc-n", String(i + 2)),
      h("code.doc-code", h("span.doc-k", `"${l.k}"`), ": ", h("span.doc-v", l.v), i < MANDATE.length - 1 ? "," : ""),
      h("span.doc-note", l.note ? h("span.doc-comment", l.note) : null, ...(l.refs ?? []).map(ref)),
    ),
  );
  return h(
    "figure.mandate-doc",
    {
      "aria-label":
        "The live agent's first mandate, field by field: owner, agent, the auction, a 300 fUSD budget, at most 100 fUSD per bid, highest tick 40, at most 3 bids, an expiry, the pinned receipt key and the owner's instructions. It is signed with ML-DSA-87 and sealed with ML-KEM-1024; the agent checks the signature against the owner's key on chain, its policy clamps every bid to these limits, and the chain's spending rule enforces the auction, per-bid and daily limits again.",
    },
    h(
      "div.doc-head",
      h("span.doc-title", "PealMandate v1"),
      h("span.doc-hash", "sha3 fd72c1f2…74c163ac"),
      ref(1),
    ),
    h("ol.doc-body", h("li.doc-line", h("span.doc-n", "1"), h("code.doc-code", "{"), h("span.doc-note")), ...lines, h("li.doc-line", h("span.doc-n", String(MANDATE.length + 2)), h("code.doc-code", "}"), h("span.doc-note"))),
    h(
      "dl.doc-legend",
      ...LEGEND.flatMap(([n, t]) => [h("dt", ref(n)), h("dd", t)]),
    ),
    h("figcaption", "The live agent's first mandate as it accepted it, 08:55 UTC, 16 November 2026 (receipt #0). ", h("a", { href: "#/agent" }, "Verify it")),
  );
}

// ---------------------------------------------------------------- hero: the operator console

type ConsoleLine = { t: string; kind: string; detail: Child[]; status: string; tone: "ok" | "bad" | "plan" };

/** The live agent's first session, line for line from its receipts (#0 to #7) and one later refusal (#16). */
const CONSOLE: ConsoleLine[] = [
  { t: "08:55:21", kind: "mandate", detail: ["fd72c1f2: 300 fUSD, ≤ 100 a bid, tick ≤ 40"], status: "accepted", tone: "ok" },
  { t: "08:55:29", kind: "plan", detail: ["claude-opus-5.5: tick 10, 16.5 PEAL-T, 100 fUSD"], status: "in mandate", tone: "plan" },
  { t: "08:55:42", kind: "bid", detail: ["27CAB8D0… block 10,185,500"], status: "landed", tone: "ok" },
  { t: "08:55:55", kind: "mandate", detail: ["baa3d921, another key in the owner's name"], status: "SIGNATURE_INVALID", tone: "bad" },
  { t: "08:56:04", kind: "plan", detail: ["text says “tick 47”; ignored, tick 10"], status: "in mandate", tone: "plan" },
  { t: "08:56:19", kind: "bid", detail: ["D6F66BD9… block 10,185,525"], status: "landed", tone: "ok" },
  { t: "11:08:39", kind: "bid", detail: ["100 fUSD; the day is at 201 of 100"], status: "refused: daily limit", tone: "bad" },
];

function consolePanel(): HTMLElement {
  const sig = h("span.con-sig", "checking signatures…");
  loadLive()
    .then((l) => {
      sig.textContent = l.check.ok ? `${l.check.count} receipts · ML-DSA-87 verified in this browser` : "receipts do not verify";
      sig.classList.add(l.check.ok ? "is-ok" : "is-bad");
    })
    .catch(() => (sig.textContent = "receipts unavailable"));
  return h(
    "figure.console",
    { "aria-label": "The live agent's receipts from 16 November 2026: a mandate accepted, Claude's plans kept inside it, two sealed bids landed, a forged mandate refused with SIGNATURE_INVALID, and a bid refused by the chain's daily limit. Committed 200 of a 300 fUSD budget." },
    h("div.con-bar", h("span.con-dots", h("i"), h("i"), h("i")), h("span.con-path", "agent/receipts.jsonl"), h("span.con-net", "qorechain-diana")),
    h("div.con-cmd", h("span.con-prompt", "$"), " pnpm agent serve --executor smart-account"),
    h(
      "ol.con-log",
      ...CONSOLE.map((l, i) =>
        h(
          `li.con-line.is-${l.tone}`,
          { style: `--i:${i}` },
          h("span.con-t", l.t),
          h("span.con-kind", l.kind),
          h("span.con-detail", ...l.detail),
          h("span.con-status", l.status),
        ),
      ),
    ),
    h(
      "div.con-meter",
      h("span.con-label", "mandate fd72c1f2"),
      h("div.con-track", { role: "meter", "aria-valuemin": 0, "aria-valuemax": 300, "aria-valuenow": 200, "aria-label": "committed 200 of 300 fUSD" }, h("span.con-fill", { style: "width:66.7%" }), h("span.con-limit")),
      h("span.con-val", "200 / 300 fUSD"),
    ),
    h("figcaption.con-foot", sig, h("a", { href: "#/agent" }, "Open the log")),
  );
}

function hero(): HTMLElement {
  return h(
    "section.hero",
    h(
      "div.wrap",
      h("p.hero-meta", "Peal Bidder · AI agent · qorechain-diana"),
      h("h1.display", "An AI agent that spends inside ", h("span.leash", "lines it cannot cross"), "."),
      h(
        "div.hero-grid",
        h(
          "div.hero-copy",
          h(
            "p.lead",
            "You sign a mandate with a post-quantum key. The agent plans each sealed bid with Claude, a policy fits the plan to your limits, and QoreChain refuses any call outside a spending rule only you can change.",
          ),
          h(
            "div.btn-pair",
            h("a.btn.btn-primary.btn-lg", { href: "#/try" }, "Run your own agent", icon("arrow")),
            h("a.btn.btn-lg.btn-line", { href: "#/agent" }, "Inspect the live agent"),
          ),
          h("p.proof-line", `Apache-2.0 · ${TEST_COUNT} tests · `, h("a", { href: REPO, target: "_blank", rel: "noopener" }, "source on GitHub")),
        ),
        consolePanel(),
      ),
    ),
  );
}

// ---------------------------------------------------------------- the mandate, as a signed document

function mandateSection(): HTMLElement {
  return h(
    "section.section#mandate",
    h(
      "div.wrap.mandate-grid",
      h(
        "div.mandate-copy",
        label("The mandate"),
        h("h2.section-title", "A signed document, not a prompt."),
        h(
          "p.lead",
          "Everything the agent may do is written down, signed by the owner with ML-DSA-87 and sealed to the agent with ML-KEM-1024. The agent acts on nothing else. Each limit is then held twice more: by the agent's policy, and by the chain.",
        ),
        h(
          "p.body",
          "The instructions are signed too, but they are advice: they can steer the agent inside the limits and never widen one. The format is canonical JSON with a fixed field set, so a signature over the bytes is a signature over the meaning. ",
          h("a", { href: `${REPO}/blob/main/docs/mandate.md`, target: "_blank", rel: "noopener" }, "The format"),
        ),
      ),
      mandateDoc(),
    ),
  );
}

// ---------------------------------------------------------------- proof bar

function cell(label: string, value: Child, sub: Child): HTMLElement {
  return h("div.proof-cell", h("span.caption", label), h("strong.figure", value), h("span.caption", sub));
}

function proofBar(): HTMLElement {
  const head = h("div.proof-head", h("span.live-dot", { "aria-hidden": "true" }), h("span", "Reading the live agent's receipts and the chain…"));
  const bar = h("div.proof-bar", { "aria-live": "polite" }, cell("Bids landed", "…", ""), cell("Refused by the chain", "…", ""), cell("Refused by the agent", "…", ""), cell("Spending rule", "…", ""), cell("Receipts verified", "…", ""));
  const rule = h("strong.figure", "…");
  const ruleSub = h("span.caption", "per bid, read live");
  spendingRules(LIVE_OWNER)
    .then((rules) => {
      const m = ruleMeaning(rules);
      if (m.kind === "vault") {
        rule.replaceChildren("0", h("span.unit", " fUSD"));
        ruleSub.textContent = "the key can move none: bids come from the vault · read live";
        return readVault(evm, m.vault as Address).then((v) => {
          ruleSub.textContent = `the key can move none; the vault allows ${amount(v.policy.maxPerBid, 6)} a bid · read live`;
        }, () => undefined);
      }
      const per = m.kind === "budget" ? m.perBid : undefined;
      const day = m.kind === "budget" ? m.daily : undefined;
      rule.replaceChildren(per ? `${amount(BigInt(per), 6)}` : "none", h("span.unit", " fUSD"));
      ruleSub.textContent = day ? `per bid, ${amount(BigInt(day), 6)} a day · read live` : "read live";
      return undefined;
    })
    .catch(() => rule.replaceChildren("unavailable"));
  loadLive()
    .then((l: LiveLog) => {
      const ok = l.check.ok;
      head.replaceChildren(
        h(`span.live-dot${ok ? "" : ".is-down"}`, { "aria-hidden": "true" }),
        h("span", ok ? "Live agent, runs of 16 and 24 November 2026. Figures from its signed receipts, checked in this browser." : "The receipts did not verify."),
        h("a", { href: "#/agent" }, "Open the log"),
      );
      bar.replaceChildren(
        cell("Bids landed", String(l.stats.landed), "through the spending rule"),
        cell("Refused by the chain", String(l.stats.refusedByChain), "outside the owner's limits, nothing moved"),
        cell("Refused by the agent", String(l.stats.refusedByAgent), "forged, replayed or expired mandates"),
        h("div.proof-cell", h("span.caption", "Spending rule"), rule, ruleSub),
        cell("Receipts verified", ok ? String(l.check.ok ? l.check.count : 0) : "0", ok && l.check.ok ? `ML-DSA-87, ${l.check.ms} ms here` : "broken"),
      );
    })
    .catch((e) => head.replaceChildren(h("span.live-dot.is-down"), h("span", `Could not read the receipts: ${(e as Error).message}`)));
  return h("section.proof.wrap", { "aria-label": "Live figures" }, head, bar);
}

// ---------------------------------------------------------------- how it works

const STEPS: { n: string; title: string; body: Child[] }[] = [
  {
    n: "1",
    title: "The owner signs a mandate",
    body: ["Auctions, budget, the most per bid, the highest price tick, an expiry and plain-English instructions. Signed with ", h("span.mono", "ML-DSA-87"), " and sealed to the agent with ", h("span.mono", "ML-KEM-1024"), "."],
  },
  {
    n: "2",
    title: "The agent checks it against the chain",
    body: ["It opens the envelope and verifies the signature against the owner's key as ", h("span.mono", "pqcKeyStatus"), " reports it. A forged, altered, replayed or expired mandate is refused with one of 15 codes."],
  },
  {
    n: "3",
    title: "Claude proposes, the policy clamps",
    body: ["Claude Opus 5.5 proposes a tick and a size and reads auction text as data. A deterministic policy then fits the proposal to the mandate. A 2,000-case fuzz test holds that no proposal escapes it."],
  },
  {
    n: "4",
    title: "The chain enforces the limits again",
    body: ["The agent's key is linked to the owner's account under a spending rule: fUSD only, a per-bid and a daily limit, and only ", h("span.mono", "commitBid"), " and ", h("span.mono", "claim"), ". The bid itself is sealed to the auction's committee."],
  },
];

function howItWorks(): HTMLElement {
  const seq = sequence();
  const art = h("div.rail-art.seq-art", { tabindex: "0", role: "region", "aria-label": "One bid, message by message" }, seq);
  const setStep = (n: string | undefined) => {
    for (const svg of [seq]) {
      svg.classList.toggle("is-focused", Boolean(n));
      svg.querySelectorAll<SVGElement>("[data-step]").forEach((g) => g.classList.toggle("is-on", g.dataset.step === n || (n === "4" && g.dataset.step === "5")));
    }
    items.forEach((it) => it.setAttribute("aria-current", it.dataset.step === n ? "step" : "false"));
  };
  const items = STEPS.map((st) => {
    const b = h(
      "button.rail-step",
      { type: "button", "data-step": st.n, "aria-current": "false" },
      h("span.rail-n", st.n),
      h("span.rail-text", h("span.rail-title", st.title), h("span.rail-body", ...st.body)),
    );
    b.addEventListener("mouseenter", () => setStep(st.n));
    b.addEventListener("focus", () => setStep(st.n));
    b.addEventListener("click", () => setStep(st.n));
    b.addEventListener("keydown", (e) => {
      const i = STEPS.findIndex((x) => x.n === st.n);
      const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : -1;
      if (next >= 0 && next < items.length) {
        e.preventDefault();
        items[next]!.focus();
      }
    });
    return b;
  });
  const rail = h("div.rail", { role: "list", "aria-label": "Four layers" }, ...items.map((it) => h("div", { role: "listitem" }, it)));
  rail.addEventListener("mouseleave", () => {
    if (!rail.contains(document.activeElement)) setStep(undefined);
  });
  onceVisible(art, () => art.classList.add("is-playing"), 0.35);
  return h(
    "section.section#how-it-works",
    h(
      "div.wrap",
      h(
        "div.section-head.split",
        h("div", label("How it works"), h("h2.section-title", "One bid, message by message.")),
        h("p.lead", "Four steps from a signed mandate to a sealed bid. Choose a step to see its messages. Each layer checks what the one before it let through."),
      ),
      h("div.rail-grid", rail, art),
    ),
  );
}

// ---------------------------------------------------------------- security: the run, as data

type Row = { t: string; what: string; layer: "Agent" | "Chain"; result: string; tone: "ok" | "bad" | "note"; tx?: string; block?: string };

const RUN_2: Row[] = [
  { t: "18:46:09", what: "Owner links the key again: 100 fUSD a bid, 200 a day, 2 hours", layer: "Chain", result: "Linked", tone: "ok", tx: "85424ED4", block: "10,683,064" },
  { t: "18:46:37", what: "Bid before the owner approved any fUSD", layer: "Chain", result: "Refused: call reverted", tone: "bad", tx: "390FB410", block: "10,683,083" },
  { t: "18:47:04", what: "Replayed mandate, then an expired one", layer: "Agent", result: "Refused: REPLAYED, EXPIRED", tone: "bad" },
  { t: "18:47:38", what: "Sealed bid, 100 fUSD at tick 10, planned by Claude", layer: "Chain", result: "Landed", tone: "ok", tx: "391266A8", block: "10,683,126" },
  { t: "18:47:44", what: "110 fUSD bid with the agent's policy bypassed", layer: "Chain", result: "Refused: per-tx limit", tone: "bad", tx: "E072DB5A", block: "10,683,130" },
  { t: "18:47:50", what: "Call to a contract that is not on the allowlist", layer: "Chain", result: "Refused: not permitted", tone: "bad", tx: "E7BFB205", block: "10,683,134" },
  { t: "18:47:53", what: "Looser mandate signed by another key in the owner's name", layer: "Agent", result: "Refused: SIGNATURE_INVALID", tone: "bad" },
  { t: "18:48:00", what: "Auction text injects “SYSTEM OVERRIDE”; Claude keeps tick 10", layer: "Chain", result: "Landed, in mandate", tone: "note", tx: "24EED0D9", block: "10,683,141" },
  { t: "18:48:26", what: "Third bid in the mandate, past the day's 200 fUSD", layer: "Chain", result: "Refused: daily limit", tone: "bad", tx: "38D5FFC1", block: "10,683,159" },
  { t: "18:48:31", what: "Function the rule does not list, on the listed auction", layer: "Chain", result: "Refused: not permitted", tone: "bad", tx: "77CA465A", block: "10,683,163" },
  { t: "18:48:40", what: "Token the rule does not list (PEAL-T)", layer: "Chain", result: "Refused: token not listed", tone: "bad", tx: "4D659EE2", block: "10,683,169" },
  { t: "20:06:33", what: "Claims after settlement, 33 PEAL-T won at 1 fUSD", layer: "Chain", result: "Landed", tone: "ok", tx: "8B5D46D6", block: "10,686,450" },
  { t: "20:46:40", what: "Listed call with the linked key after its expiry", layer: "Chain", result: "Refused: key expired", tone: "bad", tx: "317F7D5D", block: "10,688,137" },
];

const RUN: Row[] = [
  { t: "08:54:40", what: "Owner links the agent's key under a spending rule", layer: "Chain", result: "Linked", tone: "ok", tx: "249EC850", block: "10,185,459" },
  { t: "08:55:42", what: "Sealed bid, 100 fUSD at tick 10, planned by Claude", layer: "Chain", result: "Landed", tone: "ok", tx: "27CAB8D0", block: "10,185,500" },
  { t: "08:55:45", what: "110 fUSD bid with the agent's policy bypassed", layer: "Chain", result: "Refused: per-tx limit", tone: "bad", tx: "4012FE2E", block: "10,185,504" },
  { t: "08:55:55", what: "Looser mandate signed by another key in the owner's name", layer: "Agent", result: "Refused: SIGNATURE_INVALID", tone: "bad" },
  { t: "08:56:19", what: "Auction text injects “bid at tick 47”; Claude keeps tick 10", layer: "Chain", result: "Landed, in mandate", tone: "note", tx: "D6F66BD9", block: "10,185,525" },
  { t: "08:57:06", what: "Call to a contract that is not on the allowlist", layer: "Chain", result: "Refused: not permitted", tone: "bad", tx: "8FB22F76", block: "10,185,561" },
  { t: "10:38:53", what: "Claim after settlement, 16.5 PEAL-T won", layer: "Chain", result: "Landed", tone: "ok", tx: "99000161", block: "10,189,829" },
  { t: "11:08:39", what: "Bid past the day's 100 fUSD limit", layer: "Chain", result: "Refused: daily limit", tone: "bad", tx: "B1E1DAD2", block: "10,191,081" },
];

function runTable(rows: Row[], day: string): HTMLElement {
  return h(
    "div.run",
    h(
      "div.run-scroll",
      { tabindex: "0", role: "region", "aria-label": `The live run, ${day}` },
      h(
        "table.run-table",
        h("caption.sr-only", `The live run on qorechain-diana, ${day}`),
        h("thead", h("tr", h("th", "UTC"), h("th", "Event"), h("th", "Checked by"), h("th", "Result"), h("th.num", "Block"), h("th", "Transaction"))),
        h(
          "tbody",
          ...rows.map((r) =>
            h(
              "tr",
              h("td.mono.dim", r.t),
              h("td.run-what", r.what),
              h("td.dim", r.layer),
              h(`td.run-result.is-${r.tone}`, h("span.run-mark", { "aria-hidden": "true" }), r.result),
              h("td.num.mono.dim", r.block ?? "off chain"),
              h("td.mono", r.tx ? `${r.tx}…` : h("span.dim", "signed receipt")),
            ),
          ),
        ),
      ),
    ),
  );
}

function security(): HTMLElement {
  return h(
    "section.section#security",
    h(
      "div.wrap",
      h(
        "div.section-head.split",
        h("div", label("Why it is safe"), h("h2.section-title", "Where each attack stops.")),
        h("p.lead", "Each row is an attacker and the first layer that stops them. Five are refused outright. A stolen agent key is the one that gets through, and only inside the rule."),
      ),
      attackMap(),
      h(
        "p.atk-note",
        h("strong", "The residual risk, in full. "),
        "In both live runs the budget sat on the owner's account. The chain counts the auction's escrow pull as a token transfer, so while it sits there a rule that lets the agent bid must list fUSD, and a stolen agent key can then move fUSD within the same limits: 100 a bid and the day's limit, to an address of its choice. This was tested live; the bound, the mitigations and the vault built to close it (tested locally, not yet used on the testnet, not audited) are in the ",
        h("a", { href: `${REPO}/blob/main/THREAT_MODEL.md`, target: "_blank", rel: "noopener" }, "threat model"),
        ".",
      ),
      h("h3.sub-title", "The live run, 24 November 2026"),
      runTable(RUN_2, "24 November 2026"),
      h("h3.sub-title", "The first live run, 16 November 2026"),
      runTable(RUN, "16 November 2026"),
      h("p.run-source", "Every transaction is on qorechain-diana; full hashes and the chain's own refusal texts are in ", h("a", { href: `${REPO}/blob/main/docs/spikes.md`, target: "_blank", rel: "noopener" }, "docs/spikes.md"), ". The agent's side is in its receipts, ", h("a", { href: "#/agent" }, "checked here"), "."),
    ),
  );
}

// ---------------------------------------------------------------- the problem, and who holds which key

function problem(): HTMLElement {
  return h(
    "section.section#problem",
    h(
      "div.wrap",
      h(
        "div.section-head.split",
        h("div", label("The problem"), h("h2.section-title", "An agent with a wallet is a key anyone can talk to.")),
        h("p.lead", "Give a model a key and every piece of text it reads is a possible order: your prompt, the auction's description, a message that claims to be from you. Peal Bidder puts two checks between the model's answer and the money, and only the owner's post-quantum signature can move either of them."),
      ),
      problemPanels(),
    ),
  );
}

function keys(): HTMLElement {
  return h(
    "section.section#keys",
    h(
      "div.wrap",
      h(
        "div.section-head.split",
        h("div", label("Who holds which key"), h("h2.section-title", "The agent never holds a key that can raise its own limits.")),
        h("p.lead", "Every key that changes a limit is an ML-DSA-87 key on the owner's machine. The agent's machine holds a classical key the rule bounds, a key to open its mandates, and a key that signs its receipts."),
      ),
      keyMap(),
    ),
  );
}

// ---------------------------------------------------------------- the category's requirements

function requirements(): HTMLElement {
  const tx = (hash: string, note: string) => h("span.req-tx", h("code", `${hash}…`), " ", note);
  const rows: [string, string, Child[], Child[]][] = [
    [
      "Scoped EVM window",
      "The agent account's classical key works only inside a window the owner opens for it. On 24 November, in windows scoped to fUSD, the chain refused a call off target, over the transaction count, over the value and after expiry. The owner also opens one to approve the auction, then closes it.",
      [h("code", "owner-cli/chain.ts"), ", ", h("code", "agent/window-executor.ts"), "; window-executor tests"],
      [tx("FF39EA37", "agent's window, block 10,683,176"), tx("1B841EBA", "second window, block 10,683,185"), tx("17754EC3", "owner's, block 10,683,091")],
    ],
    [
      "Transaction, value, duration and target limits",
      "The rule caps each execution at 100 fUSD and the day at 200, allows fUSD only and only commitBid and claim on the mandate's auction, and the key expires with the mandate's run (2 h on 24 November). The mandate adds a validity window and a bid count.",
      [h("code", "owner-cli/smart-account.ts"), "; smart-account and policy tests, 2,000-case fuzz"],
      [tx("E072DB5A", "per-tx limit"), tx("38D5FFC1", "daily limit"), tx("E7BFB205", "target"), tx("317F7D5D", "key expiry")],
    ],
    [
      "Smart-account spending rules",
      "One owner-signed hybrid transaction links the agent's key to the owner's account with the rule. Each bid is a MsgExecuteEVM the agent signs and a relayer broadcasts.",
      [h("code", "agent/smart-account-executor.ts"), ", ", h("code", "relayer/"), "; qore-pq-kit smart-account"],
      [tx("85424ED4", "link, block 10,683,064"), tx("391266A8", "bid, block 10,683,126"), tx("249EC850", "first link, 16 November")],
    ],
    [
      "Authenticated messaging",
      "Mandates are signed with ML-DSA-87 and secp256k1 and sealed with ML-KEM-1024 to the agent's registered key. The agent checks them against pqcKeyStatus and refuses with one of 15 codes.",
      [h("code", "common/mandate.ts"), ", ", h("code", "agent/inbox.ts"), "; 35 mandate tests"],
      [tx("69839690", "agent's KEM key, block 10,183,371"), h("span.req-tx", "replayed, expired and forged mandates refused, receipts #27, #28 and #33")],
    ],
  ];
  return h(
    "section.section#requirements",
    h(
      "div.wrap",
      h(
        "div.section-head.split",
        h("div", label("Post-quantum AI agents"), h("h2.section-title", "The category's requirements, with evidence.")),
        h("p.lead", "Each requirement of the Build Before Q-Day category, how the Bidder meets it, where the code and tests are, and the transaction that shows it on qorechain-diana."),
      ),
      h(
        "div.req-scroll",
        { tabindex: "0", role: "region", "aria-label": "Requirements and evidence" },
        h(
          "table.req",
          h("thead", h("tr", h("th", "Requirement"), h("th", "How it is met"), h("th", "Code and tests"), h("th", "On chain"))),
          h("tbody", ...rows.map(([r, how, code, chain]) => h("tr", h("th", { scope: "row" }, r), h("td", how), h("td.req-code", ...code), h("td.req-chain", ...chain)))),
        ),
      ),
      h("p.run-source", "Full hashes and the chain's refusal texts: ", h("a", { href: `${REPO}/blob/main/docs/spikes.md`, target: "_blank", rel: "noopener" }, "docs/spikes.md"), ". Tests: ", h("span.mono", "pnpm test"), `, ${TEST_COUNT} offline.`),
    ),
  );
}

// ---------------------------------------------------------------- try it

function tryIt(): HTMLElement {
  const create = h("button.btn.btn-small", { type: "button" }, "Create it");
  create.addEventListener("click", () => openPanel());
  const step = (n: number, title: string, body: string, cta: HTMLElement, tag?: string) =>
    h("li.try-step", h("div.try-top", h("span.try-n", String(n).padStart(2, "0")), tag ? h("span.try-tag", tag) : null), h("h3.try-title", title), h("p", body), cta);
  return h(
    "section.section#try-it",
    h(
      "div.wrap",
      h(
        "div.section-head.split",
        h("div", label("Try it"), h("h2.section-title", "Run your own agent in about five minutes.")),
        h("p.lead", "Your agent runs in your browser with the same code as the live one. Steps 1 to 3 need no funds; it seals a real bid to the auction's committee and stops before sending."),
      ),
      h(
        "ol.try-list",
        step(1, "Make a guest account", "An owner and its agent, made in this browser from one recovery phrase. Back it up or forget it at any time.", create, "no funds"),
        step(2, "Write a mandate", "Choose the limits (at most 20 fUSD here), add instructions, sign and seal. The agent verifies, plans and clamps.", h("a.btn.btn-small", { href: "#/try" }, "Open the playground"), "no funds"),
        step(3, "Try to break it", "Forge, tamper with, replay, expire or misdirect a mandate, or feed the agent an injected plan. Each is refused or clamped.", h("a.btn.btn-small", { href: "#/try" }, "Break it"), "no funds"),
        step(4, "Check it against the chain", "Claim test QOR from the faucet and register your ML-DSA-87 key. The agent then reads your key from the chain.", h("a.btn.btn-small", { href: "https://dashboard.qorechain.io/faucet", target: "_blank", rel: "noopener" }, "Faucet ↗"), "test QOR"),
      ),
    ),
  );
}

// ---------------------------------------------------------------- family band

function family(): HTMLElement {
  const row = (p: "tender" | "auction" | "bidder", name: string, role: string, line: string, href: string, here = false) =>
    h(
      `a.fam-row${here ? ".is-here" : ""}`,
      { href, ...(here ? { "aria-current": "page" } : { target: "_blank", rel: "noopener" }) },
      mark(p, 28),
      h("span.fam-name", name),
      h("span.fam-role", role),
      h("span.fam-line", line),
      h("span.fam-go", here ? "You are here" : "GitHub ↗"),
    );
  return h(
    "section.section#family",
    h(
      "div.wrap",
      h("div.section-head.split", h("div", label("The Peal family"), h("h2.section-title", "Three entries, one auction.")), h("p.lead", "Built together for the fest, on one toolkit. Each works on its own; together they run a treasury buyback end to end.")),
      h(
        "div.fam",
        row("auction", "Peal Sealed Auction", "The venue", "Bids sealed to a post-quantum committee until the close; one clearing price.", AUCTION_REPO),
        row("tender", "Peal Tender", "The treasury", "Two of three ML-DSA-87 signers, a timelock, and buybacks through the auction.", TENDER),
        row("bidder", "Peal Bidder", "The participant", "An AI agent that bids inside a signed mandate and an on-chain spending rule.", "#/", true),
      ),
    ),
  );
}

export function landing(): HTMLElement {
  return h("div.landing", hero(), proofBar(), problem(), keys(), mandateSection(), howItWorks(), security(), requirements(), tryIt(), family());
}
