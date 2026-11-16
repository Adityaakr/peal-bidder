/**
 * The playground: the visitor writes a mandate for their own agent, signs and
 * seals it in this browser, and watches the agent check it, plan, clamp and seal a
 * bid. Then they try to break it. Every step is the repository's own code.
 *
 * Small limits only (config GUEST_LIMITS). The public planner is the rule-based
 * one; the owner's Claude planner and its key are never offered here.
 */
import { classicalKeyFromPrivate } from "@qorechain/qoresign";
import { envelopeToText, sealKeysFromSeed } from "@qorechain/qoreseal";
import { sealInstruction, signInstruction } from "qore-pq-kit/messaging";
import { hexToBytes, parseUnits, type Address, type Hex } from "viem";
import { encodeMandate, type PealMandateV1 } from "../../../../common/mandate.ts";
import { mandateFields, signMandate } from "../../../../owner-cli/mandate.ts";
import { remainingCap } from "../../../../agent/policy.ts";
import { priceAt } from "../../../../agent/auction.ts";
import type { StepResult } from "../../../../agent/agent.ts";
import type { Planner } from "../../../../agent/planner/types.ts";
import type { Receipt } from "../../../../agent/receipts.ts";
import { factoryAuctions, openForGuests, type AuctionSummary } from "../chain.ts";
import { FUSD_DECIMALS, GUEST_LIMITS, PRACTICE_AUCTION } from "../config.ts";
import {
  InjectedPlanner,
  buildAgent,
  clearBrowserAgent,
  deliver,
  draftMandate,
  keysOf,
  lastEnvelope,
  ownerKeys,
  plannerFor,
  previewQty,
  rememberEnvelope,
  signAndSeal,
  stepAgain,
  styleOf,
  type GuestAgent,
  type KeyCheck,
  type Outcome,
  type SealedPreview,
} from "../agent/guest-agent.ts";
import { amount, chip, errorText, fingerprint, h, hash, icon, kicker, meter, timeOnly, type Child } from "../ui.ts";
import { openPanel, state as wallet, subscribe } from "../wallet/store.ts";
import type { Guest } from "../wallet/guest.ts";

const fusd = (v: bigint) => `${amount(v, FUSD_DECIMALS)} fUSD`;
const pealt = (v: bigint) => `${amount(v, 18, 2)} PEAL-T`;

// ---------------------------------------------------------------- the pipeline view

type StageState = "idle" | "ok" | "bad" | "warn" | "skip";
const STAGES = [
  ["sign", "Sign", "ML-DSA-87 + secp256k1"],
  ["seal", "Seal", "ML-KEM-1024 + X25519"],
  ["open", "Open", "the agent's key only"],
  ["verify", "Verify", "owner's key, nonce, expiry"],
  ["plan", "Plan", "rule-based planner"],
  ["clamp", "Clamp", "policy"],
  ["bid", "Seal the bid", "2-of-3 committee"],
  ["send", "Send", "spending rule"],
] as const;
type StageId = (typeof STAGES)[number][0];

const REFUSAL_HELP: Record<string, string> = {
  SIGNATURE_INVALID: "The signature does not verify against the owner's key. Whoever made it does not hold your keys.",
  REPLAYED: "This mandate's nonce is not above the last one the agent accepted. A copied mandate cannot be sent twice.",
  EXPIRED: "The mandate's time is over. The agent acts only inside the window you signed.",
  SEAL_OPEN_FAILED: "The envelope was sealed to another agent's ML-KEM-1024 key, so this agent cannot even open it.",
  OWNER_KEY_UNAVAILABLE: "The agent reads your ML-DSA-87 key from the chain and found none. Register it from the wallet, or switch the key check to this browser.",
  NOT_YET_VALID: "The mandate starts later.",
  RECEIPT_KEY_MISMATCH: "The mandate pins another receipt key.",
};

function stagesFor(o: Outcome | undefined): Record<StageId, StageState> {
  const st = Object.fromEntries(STAGES.map(([id]) => [id, "idle"])) as Record<StageId, StageState>;
  if (!o) return st;
  st.sign = "ok";
  st.seal = "ok";
  if (o.kind === "refused") {
    const atOpen = ["ENVELOPE_MALFORMED", "SEAL_OPEN_FAILED", "PAYLOAD_MALFORMED"].includes(o.refusal.code);
    st.open = atOpen ? "bad" : "ok";
    if (!atOpen) st.verify = "bad";
    return st;
  }
  st.open = "ok";
  st.verify = "ok";
  return { ...st, ...stepStages(o.step, o.preview) };
}

function stepStages(step: StepResult, preview?: SealedPreview): Partial<Record<StageId, StageState>> {
  if (step.kind === "idle") return { plan: "skip" };
  const d = step.plan.decision;
  if (d.kind === "skip") return { plan: "ok", clamp: "warn" };
  return { plan: "ok", clamp: d.adjustments.length ? "warn" : "ok", bid: preview ? "ok" : "warn", send: "skip" };
}

function pipeline(st: Record<StageId, StageState>): HTMLElement {
  return h(
    "ol.pipeline",
    { "aria-label": "What the agent did" },
    ...STAGES.map(([id, title, sub], i) =>
      h(
        `li.pipe.pipe-${st[id]}`,
        { style: `--i:${i}` },
        h("span.pipe-dot", icon(st[id] === "ok" ? "check" : st[id] === "bad" ? "cross" : st[id] === "warn" ? "pause" : st[id] === "skip" ? "dot" : "dot")),
        h("span.pipe-title", title),
        h("span.pipe-sub", sub),
      ),
    ),
  );
}

// ---------------------------------------------------------------- the page

interface View {
  auctions?: AuctionSummary[];
  chosen?: AuctionSummary;
  practice: boolean;
  loadError?: string;
  keyCheck: KeyCheck;
  draft: { budget: string; maxPerBid: string; maxTick: number; maxBids: number; hours: number; instructions: string };
  outcome?: Outcome;
  /** A plain-words line about the last thing that happened. */
  headline?: { tone: "ok" | "bad" | "warn"; title: string; body: Child[] };
  busy?: string;
}

const view: View = {
  practice: true,
  keyCheck: "browser",
  draft: { budget: "10", maxPerBid: "5", maxTick: 20, maxBids: 2, hours: 6, instructions: "Take part at a fair price. Never chase the top tick." },
};

let root: HTMLElement | undefined;
let unsub: (() => void) | undefined;

function guest(): Guest | undefined {
  return wallet.guest;
}

function agentFor(g: Guest, planner: Planner = plannerFor(view.draft.instructions)): GuestAgent {
  return buildAgent(g, { keyCheck: view.keyCheck, planner, ...(view.practice && view.chosen ? { practice: view.chosen.address as Address } : {}) });
}

function draftOrError(g: Guest, ga: GuestAgent): PealMandateV1 {
  const a = view.chosen;
  if (!a) throw new Error("No auction to bid in yet.");
  const d = view.draft;
  const budget = parseUnits(d.budget || "0", FUSD_DECIMALS);
  const per = parseUnits(d.maxPerBid || "0", FUSD_DECIMALS);
  if (budget <= 0n || budget > parseUnits(String(GUEST_LIMITS.budget), FUSD_DECIMALS)) throw new Error(`The budget must be between 0 and ${GUEST_LIMITS.budget} fUSD on this page.`);
  if (per <= 0n || per > budget || per > parseUnits(String(GUEST_LIMITS.maxPerBid), FUSD_DECIMALS)) throw new Error(`The most per bid must be positive, at most the budget and at most ${GUEST_LIMITS.maxPerBid} fUSD.`);
  if (d.instructions.length > GUEST_LIMITS.instructions) throw new Error(`Instructions are at most ${GUEST_LIMITS.instructions} characters here.`);
  return draftMandate(g, ga, {
    auction: a.address as Address,
    budget,
    maxPerBid: per,
    maxTick: Math.min(d.maxTick, a.numTicks - 1),
    maxBids: d.maxBids,
    hours: d.hours,
    instructions: d.instructions,
  });
}

async function run(title: string, f: () => Promise<void>): Promise<void> {
  if (view.busy) return;
  view.busy = title;
  draw();
  // Let the busy state paint before the post-quantum maths blocks the thread.
  await new Promise((r) => setTimeout(r, 30));
  try {
    await f();
  } catch (e) {
    view.headline = { tone: "bad", title: "That did not run", body: [errorText(e)] };
  } finally {
    view.busy = undefined;
    draw();
  }
}

function describe(o: Outcome, intro: string): View["headline"] {
  if (o.kind === "refused") {
    const r = o.refusal;
    return { tone: "bad", title: `${intro}: refused, ${r.code}`, body: [REFUSAL_HELP[r.code] ?? r.message, h("span.caption.block", r.message)] };
  }
  return describeStep(o.step, o.preview, `${intro}: accepted`);
}

function describeStep(step: StepResult, preview: SealedPreview | undefined, title: string): View["headline"] {
  if (step.kind === "idle") return { tone: "warn", title, body: [`Then nothing to do: ${step.why}.`] };
  const d = step.plan.decision;
  const a = view.chosen;
  if (d.kind === "skip") return { tone: "warn", title, body: [`The planner proposed, the policy skipped: ${d.reason.toLowerCase().replace(/_/g, " ")}. ${d.detail}`] };
  const price = a ? priceAt(a, d.tick) : 0n;
  const raw = step.plan.proposal;
  const body: Child[] = [
    `Bid: ${pealt(d.qty)} at tick ${d.tick} (${fusd(price)} each), ${fusd(d.outflow)} out with the bond.`,
  ];
  if (d.adjustments.length && raw) body.push(h("span.block", `The planner asked for tick ${raw.tick} and ${pealt(BigInt(raw.qty))}; the policy lowered ${d.adjustments.map((x) => (x === "TICK_LOWERED" ? "the tick" : "the size")).join(" and ")} to fit your mandate.`));
  body.push(
    h(
      "span.block",
      preview
        ? `Sealed to the auction's real ${preview.threshold}-of-${preview.envelopes} committee, each member checked against the chain, ${preview.calldataBytes.toLocaleString("en-US")} bytes of commitBid. Not sent: this is a rehearsal.`
        : "Not sent: this is a rehearsal.",
    ),
  );
  return { tone: d.adjustments.length ? "warn" : "ok", title, body };
}

// ---------------------------------------------------------------- actions

async function sendMandate(): Promise<void> {
  const g = guest()!;
  const ga = agentFor(g);
  const m = draftOrError(g, ga);
  const { envelope } = signAndSeal(m, ownerKeys(g), ga.identity.sealKeys);
  rememberEnvelope(envelope);
  const o = await deliver(ga, envelope);
  view.outcome = o;
  view.headline = describe(o, "Your mandate");
}

async function planAgain(): Promise<void> {
  const g = guest()!;
  const ga = agentFor(g);
  const r = await stepAgain(ga);
  view.outcome = { kind: "accepted", accepted: undefined as never, step: r.step, ...(r.preview ? { preview: r.preview } : {}) };
  view.headline = describeStep(r.step, r.preview, "Another round under the same mandate");
}

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

const ATTACKS: { id: string; title: string; what: string; run: (g: Guest) => Promise<Outcome> }[] = [
  {
    id: "forge",
    title: "Forge a mandate in my name",
    what: "Someone else signs a looser mandate (twice the budget) with their own keys and puts your address on it as the sender.",
    run: async (g) => {
      const ga = agentFor(g);
      const m = draftOrError(g, ga);
      const looser = { ...m, budget: (BigInt(m.budget) * 2n).toString(), maxPerBid: (BigInt(m.maxPerBid) * 2n).toString() };
      // QoreSign will not sign in another account's name, so the forger signs as itself and then
      // swaps the sender for yours: the forgery that is left (as in the CLI's testnet demo).
      const sdk = await import("@qorechain/sdk");
      const thief = await sdk.deriveUnifiedAccount(sdk.generateMnemonic(256), 0);
      const thiefKeys = { classicalKey: classicalKeyFromPrivate(hexToBytes(thief.privateKey as Hex), "eth_secp256k1"), pqKey: { secretKey: thief.pqc.secretKey } };
      const signed = signInstruction({ fields: { ...mandateFields(looser), from: thief.cosmos }, ...thiefKeys });
      const forged = { ...signed, fields: { ...signed.fields, from: g.owner.cosmos } };
      const env = envelopeToText(sealInstruction(forged, { mlkemPublicKey: ga.identity.sealKeys.mlkemPublicKey, x25519PublicKey: ga.identity.sealKeys.x25519PublicKey }, "hybrid"));
      return deliver(ga, env);
    },
  },
  {
    id: "tamper",
    title: "Raise the budget after signing",
    what: "Your real signature, but the budget inside is changed to ten times what you signed.",
    run: async (g) => {
      const ga = agentFor(g);
      const m = draftOrError(g, ga);
      const signed = signMandate(m, ownerKeys(g));
      const bigger = { ...m, budget: (BigInt(m.budget) * 10n).toString() };
      const forged = { ...signed, fields: { ...signed.fields, body: encodeMandate(bigger) } };
      const env = envelopeToText(sealInstruction(forged, { mlkemPublicKey: ga.identity.sealKeys.mlkemPublicKey, x25519PublicKey: ga.identity.sealKeys.x25519PublicKey }, "hybrid"));
      return deliver(ga, env);
    },
  },
  {
    id: "replay",
    title: "Send my last mandate again",
    what: "A copy of the last mandate you sent, byte for byte, to reset the agent's spending.",
    run: async (g) => {
      const env = lastEnvelope();
      if (!env) throw new Error("Send a mandate first; then replay it.");
      return deliver(agentFor(g), env);
    },
  },
  {
    id: "expired",
    title: "Send a mandate that has expired",
    what: "Signed properly, but its validity ended an hour ago.",
    run: async (g) => {
      const ga = agentFor(g);
      const now = Math.floor(Date.now() / 1000);
      const m = draftOrError(g, ga);
      const old = { ...m, notBefore: now - 7200, expiresAt: now - 3600 };
      const { envelope } = signAndSeal(old, ownerKeys(g), ga.identity.sealKeys, new Date((now - 7200) * 1000));
      return deliver(ga, envelope);
    },
  },
  {
    id: "other-agent",
    title: "Seal it to another agent",
    what: "A valid mandate, sealed to a different agent's ML-KEM-1024 key and forwarded here.",
    run: async (g) => {
      const ga = agentFor(g);
      const m = draftOrError(g, ga);
      const other = sealKeysFromSeed(randomBytes(32));
      const { envelope } = signAndSeal(m, ownerKeys(g), other);
      return deliver(ga, envelope);
    },
  },
  {
    id: "inject",
    title: "Feed it an injected plan",
    what: "As if the auction text fooled the model: the plan asks for the top tick and the whole supply.",
    run: async (g) => {
      const ga = agentFor(g, new InjectedPlanner());
      const m = draftOrError(g, ga);
      const { envelope } = signAndSeal(m, ownerKeys(g), ga.identity.sealKeys);
      rememberEnvelope(envelope);
      return deliver(ga, envelope);
    },
  },
];

// ---------------------------------------------------------------- drawing

function field(label: string, input: HTMLElement, hint?: Child): HTMLElement {
  return h("label.field", h("span", label), input, hint ? h("small", hint) : null);
}

function num(value: string, onInput: (v: string) => void, attrs: Record<string, string | number> = {}): HTMLInputElement {
  const i = h("input.input", { value, inputmode: "decimal", ...attrs }) as HTMLInputElement;
  i.addEventListener("input", () => onInput(i.value.trim()));
  return i;
}

function mandateForm(g: Guest): HTMLElement {
  const a = view.chosen;
  const d = view.draft;
  const ticks = a ? a.numTicks - 1 : 47;
  const preview = h("div.preview");
  const updatePreview = () => {
    preview.replaceChildren();
    if (!a) return;
    try {
      const ga = { identity: { receiptKeyHash: keysOf(g).keyHash } } as GuestAgent;
      const m = draftOrError(g, ga);
      const style = styleOf(d.instructions);
      const frac = { cautious: 0.25, fair: 0.5, eager: 0.9 }[style];
      const tick = Math.floor(Math.min(m.maxTick, a.numTicks - 1) * frac);
      const q = previewQty(m, a, tick);
      preview.append(
        h("span.caption", "Your agent's planner reads one word of style from your instructions: "),
        chip(style, "accent"),
        h("p", `So it would bid at tick ${tick} (${fusd(priceAt(a, tick))} per PEAL-T): about ${pealt(q)} for at most ${fusd(remainingCap(m, { bids: 0, committed: 0n, qtyByAuction: {} }))} with the bond.`),
      );
    } catch (e) {
      preview.append(h("p.caption.bad-text", errorText(e)));
    }
  };
  const set = (k: keyof View["draft"]) => (v: string) => {
    (view.draft as Record<string, unknown>)[k] = typeof view.draft[k] === "number" ? Number(v) : v;
    updatePreview();
  };
  const tick = h("input.range", { type: "range", min: 0, max: ticks, value: Math.min(d.maxTick, ticks), "aria-label": "highest tick" }) as HTMLInputElement;
  const tickOut = h("output.range-out", String(Math.min(d.maxTick, ticks)));
  tick.addEventListener("input", () => {
    tickOut.textContent = tick.value;
    set("maxTick")(tick.value);
  });
  const seg = (name: string, values: number[], cur: number, k: "maxBids" | "hours", fmt: (n: number) => string) => {
    const box = h("div.segmented", { role: "group", "aria-label": name });
    for (const v of values) {
      const b = h("button", { type: "button", "aria-pressed": String(v === cur) }, fmt(v));
      b.addEventListener("click", () => {
        set(k)(String(v));
        box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });
      box.append(b);
    }
    return box;
  };
  const instr = h("textarea.input", { rows: 3, maxlength: GUEST_LIMITS.instructions, "aria-label": "instructions" }, d.instructions) as HTMLTextAreaElement;
  instr.addEventListener("input", () => set("instructions")(instr.value));
  const send = h("button.btn.btn-primary.btn-lg.send-btn", { type: "button", disabled: view.busy || !a ? true : undefined, "data-test": "send-mandate" }, icon("pen"), view.busy === "send" ? "Signing and checking…" : "Sign and send to my agent");
  send.addEventListener("click", () => void run("send", sendMandate));
  updatePreview();
  return h(
    "section.card.form-card",
    h("div.card-head", h("h2.card-title", "1. Write a mandate"), chip(`at most ${GUEST_LIMITS.budget} fUSD here`, "plain")),
    h(
      "div.form-grid",
      field("Budget (fUSD)", num(d.budget, set("budget"), { "aria-label": "budget in fUSD" }), "All bids together, with bonds."),
      field("Most per bid (fUSD)", num(d.maxPerBid, set("maxPerBid"), { "aria-label": "most per bid in fUSD" }), "Escrow plus bond of one bid."),
      h("label.field.wide", h("span", "Highest price tick"), h("div.range-row", tick, tickOut), h("small", a ? `Tick 0 is ${fusd(a.reservePrice)}; each tick adds ${fusd(a.tickSize)}.` : "")),
      h("div.field", h("span", "Bids, at most"), seg("bids", [1, 2, 3], d.maxBids, "maxBids", String)),
      h("div.field", h("span", "Valid for"), seg("validity", [1, 6, 24], d.hours, "hours", (n) => `${n} h`)),
      field("Instructions", instr, "Signed into the mandate. Advisory: they can never widen a limit above."),
    ),
    preview,
    keyCheckControl(),
    send,
  );
}

function keyCheckControl(): HTMLElement {
  const registered = Boolean(wallet.owner?.keyRegistered && wallet.owner.keyIsOurs);
  const box = h("div.segmented", { role: "group", "aria-label": "where the agent reads your key" });
  for (const [k, label] of [
    ["chain", "On chain"],
    ["browser", "In this browser"],
  ] as const) {
    const b = h("button", { type: "button", "aria-pressed": String(view.keyCheck === k) }, label);
    b.addEventListener("click", () => {
      view.keyCheck = k;
      draw();
    });
    box.append(b);
  }
  return h(
    "div.keycheck",
    h("span.caption", "The agent checks your signature against your ML-DSA-87 key read"),
    box,
    h(
      "p.caption",
      view.keyCheck === "chain"
        ? registered
          ? "from QoreChain (pqcKeyStatus), as the live agent does."
          : "from QoreChain, where you have not registered it yet: expect OWNER_KEY_UNAVAILABLE. Register it from the wallet."
        : "from this browser: a rehearsal. Nothing on chain vouches for it, and the page says so.",
    ),
  );
}

function auctionCard(): HTMLElement {
  if (view.loadError) return h("div.note.bad", `Could not read the auctions: ${view.loadError}`);
  const a = view.chosen;
  if (!a) return h("div.card.loading", h("div.skeleton"), h("div.skeleton.short"));
  return h(
    "section.card.auction-card",
    h(
      "div.card-head",
      h("h2.card-title", "The auction"),
      view.practice ? chip("rehearsal: nothing is sent", "warn") : chip("taking bids now", "ok", "clock"),
    ),
    h(
      "p.small",
      view.practice
        ? "No Peal auction is taking bids right now, so your agent rehearses on the last demo auction: its numbers and its 2-of-3 committee are read from the chain, it is treated as open, and the agent stops before sending."
        : "Read from Peal Sealed Auction's factory. Your agent seals its bid to this auction's committee.",
    ),
    h(
      "dl.kv",
      h("dt", "Address"),
      h("dd", hash(a.address, { label: "auction" })),
      h("dt", "Name"),
      h("dd", a.name || "(no verified name)"),
      h("dt", "Price"),
      h("dd", `${fusd(a.reservePrice)} + ${fusd(a.tickSize)} a tick, ${a.numTicks} ticks`),
      h("dt", "Bond"),
      h("dd", fusd(a.bidBond)),
    ),
  );
}

function ledgerCard(g: Guest): HTMLElement {
  const ga = agentFor(g);
  const st = ga.agent.state;
  const receipts = ga.receipts();
  const m = st.mandate;
  const list = h("ol.receipts", ...[...receipts].reverse().slice(0, 30).map((r) => receiptRow(r)));
  const blob = new Blob([receipts.map((r) => JSON.stringify(r)).join("\n") + (receipts.length ? "\n" : "")], { type: "application/x-ndjson" });
  const dl = h("a.btn.btn-small", { href: URL.createObjectURL(blob), download: "receipts.jsonl" }, "Download");
  const reset = h("button.btn.btn-small", { type: "button" }, "Start a fresh agent");
  reset.addEventListener("click", () => {
    if (!confirm("Clear this agent's receipts and nonce memory in this browser? Your guest account stays.")) return;
    clearBrowserAgent();
    view.outcome = undefined;
    view.headline = undefined;
    draw();
  });
  const again = h("button.btn.btn-small", { type: "button", disabled: !m || view.busy ? true : undefined }, icon("refresh"), "Plan another bid");
  again.addEventListener("click", () => void run("again", planAgain));
  return h(
    "section.card.ledger-card",
    h("div.card-head", h("h2.card-title", "Your agent"), h("div.row-gap", again)),
    h("div.agent-id", fingerprint(ga.identity.receiptKeyHash), h("div", h("span.caption", "Agent"), hash(ga.identity.address, { label: "agent address" })), h("div", h("span.caption", "Receipt key"), hash(ga.identity.receiptKeyHash, { label: "receipt key hash" }))),
    m
      ? h(
          "div.ledger",
          h("div", h("span.caption", "Committed"), h("strong", `${fusd(st.ledger.committed)} of ${fusd(BigInt(m.budget))}`), meter(Number(st.ledger.committed) / Number(BigInt(m.budget)), st.ledger.committed >= BigInt(m.budget) ? "full" : "", "budget used")),
          h("div", h("span.caption", "Bids"), h("strong", `${st.ledger.bids} of ${m.maxBids}`), meter(st.ledger.bids / m.maxBids, st.ledger.bids >= m.maxBids ? "full" : "", "bids used")),
        )
      : h("p.caption", "No mandate yet. Write one on the left."),
    h("div.card-head.sub-head", h("h3", `Receipts (${receipts.length})`), h("div.row-gap", dl, reset)),
    receipts.length ? list : h("p.caption", "Every step your agent takes, refusals included, lands here as a receipt signed with its ML-DSA-87 key and chained to the one before."),
  );
}

function receiptRow(r: Receipt): HTMLElement {
  const d = r.body.data as Record<string, unknown>;
  const k = r.body.kind;
  const what =
    k === "mandate-accepted"
      ? chip("mandate accepted", "ok")
      : k === "mandate-refused"
        ? chip(`refused: ${String(d.code)}`, "bad")
        : k === "decision"
          ? chip(`decision: ${String((d.decision as Record<string, unknown>)?.kind ?? "")}`, "accent", "spark")
          : k === "submission"
            ? chip("submission", "plain")
            : k === "result"
              ? chip(`result: ${String(d.status)}`, d.status === "landed" ? "ok" : d.status === "dry-run" ? "plain" : "bad")
              : chip(k, "plain");
  return h("li.receipt", h("span.receipt-seq", `#${r.body.seq}`), what, h("span.caption", timeOnly(r.body.at)), h("span.receipt-sig", icon("check"), "signed"));
}

function attacksCard(): HTMLElement {
  return h(
    "section.card.attacks-card#break-it",
    h("div.card-head", h("h2.card-title", "2. Try to break it"), h("span.caption", "Each one runs the real checks.")),
    h(
      "div.attack-grid",
      ...ATTACKS.map((at) => {
        const b = h("button.attack", { type: "button", disabled: view.busy || !view.chosen ? true : undefined, "data-test": `attack-${at.id}` }, h("span.attack-title", at.title), h("span.attack-what", at.what));
        b.addEventListener("click", () =>
          void run(at.id, async () => {
            const o = await at.run(guest()!);
            view.outcome = o;
            view.headline = describe(o, at.title);
          }),
        );
        return b;
      }),
    ),
  );
}

function resultCard(): HTMLElement {
  const st = stagesFor(view.outcome);
  const hl = view.headline;
  return h(
    "section.card.result-card",
    { "aria-live": "polite" },
    h("div.card-head", h("h2.card-title", "What your agent did"), view.busy ? chip("working…", "wait") : null),
    pipeline(st),
    hl
      ? h(`div.headline.headline-${hl.tone}`, h("strong", hl.title), ...hl.body.map((b) => (typeof b === "string" ? h("p", b) : b)))
      : h("p.caption", "Sign a mandate to see each check light up, or try to break one."),
  );
}

function noGuest(): HTMLElement {
  const b = h("button.btn.btn-primary.btn-lg", { type: "button", "data-test": "open-wallet" }, icon("key"), "Create a guest account");
  b.addEventListener("click", () => openPanel());
  return h(
    "section.card.empty-guest",
    h("h2.card-title", "First, an owner and an agent"),
    h("p", "A guest account makes both in this browser from one recovery phrase: the owner, who signs mandates with ML-DSA-87, and the agent, which opens them with ML-KEM-1024 and keeps signed receipts. It takes a second and needs no funds."),
    b,
  );
}

function draw(): void {
  if (!root) return;
  const g = guest();
  const top = h(
    "div.page-head",
    kicker("Your agent"),
    h("h1.page-title", "Give an agent a mandate. Then try to break it."),
    h(
      "p.lead",
      "Your agent runs here, in your browser, with the same code as the live one: it opens your sealed mandate, checks your signature, plans, clamps and seals a bid to the auction's committee. The public planner is rule-based; the owner's Claude key never reaches this page.",
    ),
  );
  if (!g) {
    root.replaceChildren(top, wallet.reading ? h("div.card.loading", h("div.skeleton")) : noGuest());
    return;
  }
  root.replaceChildren(
    top,
    h("div.play-grid", h("div.try-col", auctionCard(), mandateForm(g)), h("div.try-col", resultCard(), attacksCard(), ledgerCard(g))),
  );
}

async function loadAuctions(): Promise<void> {
  try {
    const { now, auctions } = await factoryAuctions(12);
    view.auctions = auctions;
    const open = openForGuests(auctions, now);
    if (open[0]) {
      view.chosen = open[0];
      view.practice = false;
    } else {
      view.practice = true;
      view.chosen = auctions.find((a) => a.address === PRACTICE_AUCTION) ?? auctions[0];
    }
  } catch (e) {
    view.loadError = errorText(e);
  }
  draw();
}

export function tryPage(): HTMLElement {
  root = h("div.wrap.page.try");
  unsub?.();
  let wasGuest = Boolean(wallet.guest);
  let wasRegistered = Boolean(wallet.owner?.keyRegistered);
  unsub = subscribe(() => {
    if (!root?.isConnected) return;
    const nowGuest = Boolean(wallet.guest);
    const nowRegistered = Boolean(wallet.owner?.keyRegistered && wallet.owner.keyIsOurs);
    if (nowRegistered && !wasRegistered) view.keyCheck = "chain";
    if (nowGuest !== wasGuest || nowRegistered !== wasRegistered) draw();
    wasGuest = nowGuest;
    wasRegistered = nowRegistered;
  });
  if (wallet.owner?.keyRegistered && wallet.owner.keyIsOurs) view.keyCheck = "chain";
  draw();
  if (!view.chosen) void loadAuctions();
  return root;
}

