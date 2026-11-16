/**
 * The landing page's explanatory drawings. Each answers one question a visitor has:
 *
 * - problemPanels: why not just give an agent a wallet?
 * - keyMap: who holds which key, and what a thief gets from each machine?
 * - sequence: what happens, message by message, when the agent bids?
 * - attackMap: where does each kind of attack stop?
 *
 * Same schematic vocabulary as `mechanism.ts`: white boxes with an ink stroke, the
 * signed path in the accent, refusals as short thick red stops, labels in Plex Mono for
 * names of keys and calls. Every label also appears in the page text or the aria-label.
 */
import { h, s, type Child } from "../ui.ts";

const INK = "#0b1320";
const MUTED = "#667180";
const ACCENT = "#0369a1";
const RED = "#c9261c";
const GREEN = "#12804a";
const MONO = "IBM Plex Mono, ui-monospace, monospace";
const SANS = "IBM Plex Sans, system-ui, sans-serif";

function t(x: number, y: number, txt: string, o: { size?: number; weight?: number; fill?: string; anchor?: string; mono?: boolean } = {}): SVGElement {
  return s("text", { x, y, "font-size": o.size ?? 12, "font-weight": o.weight ?? 400, fill: o.fill ?? INK, "text-anchor": o.anchor ?? "start", "font-family": o.mono ? MONO : SANS }, txt);
}

function box(x: number, y: number, w: number, hh: number, o: { stroke?: string; dash?: string; fill?: string } = {}): SVGElement {
  return s("rect", { x, y, width: w, height: hh, rx: 6, fill: o.fill ?? "#fff", stroke: o.stroke ?? INK, "stroke-opacity": o.stroke ? 1 : 0.85, "stroke-width": 1, ...(o.dash ? { "stroke-dasharray": o.dash } : {}) });
}

function arrow(x1: number, y1: number, x2: number, y2: number, color = INK, dash?: string): SVGElement {
  const g = s("g");
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const hx = x2 - Math.cos(ang) * 7;
  const hy = y2 - Math.sin(ang) * 7;
  g.append(s("line", { x1, y1, x2: hx, y2: hy, stroke: color, "stroke-width": 1.4, ...(dash ? { "stroke-dasharray": dash } : {}) }));
  const px = Math.cos(ang + Math.PI / 2) * 3.5;
  const py = Math.sin(ang + Math.PI / 2) * 3.5;
  g.append(s("polygon", { points: `${x2},${y2} ${hx + px},${hy + py} ${hx - px},${hy - py}`, fill: color }));
  return g;
}

function stop(x: number, y: number, vertical = true): SVGElement {
  return vertical
    ? s("line", { x1: x, y1: y - 11, x2: x, y2: y + 11, stroke: RED, "stroke-width": 3, "stroke-linecap": "round" })
    : s("line", { x1: x - 11, y1: y, x2: x + 11, y2: y, stroke: RED, "stroke-width": 3, "stroke-linecap": "round" });
}

// ---------------------------------------------------------------- 1. the problem, drawn as a difference

/** Two drawings of the same flow: an agent with a hot wallet, and Peal Bidder. */
export function problemPanels(): HTMLElement {
  const hot = s("svg", {
    viewBox: "0 0 520 250",
    role: "img",
    "aria-label": "An agent with a hot wallet: any text that reaches the model, a user's prompt, auction text or a forged order, can lead to a call signed with the agent's key, which can move any token to any contract. One fooled answer or one stolen key moves everything.",
    class: "diagram",
  }) as SVGSVGElement;
  const inputs = ["your prompt", "auction text", "a forged order"];
  inputs.forEach((label, i) => {
    hot.append(box(8, 20 + i * 44, 116, 32, { dash: i ? "3 3" : undefined }));
    hot.append(t(66, 41 + i * 44, label, { size: 11.5, anchor: "middle" }));
    hot.append(arrow(124, 36 + i * 44, 168, 80));
  });
  hot.append(box(170, 56, 100, 48));
  hot.append(t(220, 85, "model", { size: 12.5, weight: 600, anchor: "middle" }));
  hot.append(arrow(270, 80, 312, 80));
  hot.append(box(314, 56, 92, 48));
  hot.append(t(360, 77, "agent key", { size: 12, weight: 600, anchor: "middle" }));
  hot.append(t(360, 93, "whole wallet", { size: 10.5, anchor: "middle", fill: MUTED }));
  hot.append(arrow(406, 80, 428, 80, RED));
  hot.append(t(434, 76, "any token", { size: 10.5, mono: true, fill: RED }));
  hot.append(t(434, 92, "any contract", { size: 10.5, mono: true, fill: RED }));
  hot.append(s("line", { x1: 8, y1: 172, x2: 512, y2: 172, stroke: INK, "stroke-opacity": 0.12 }));
  hot.append(t(8, 198, "Nothing between the model's answer and the money.", { size: 12.5, weight: 600 }));
  hot.append(t(8, 220, "One fooled answer or one stolen key moves everything.", { size: 12, fill: MUTED }));

  const peal = s("svg", {
    viewBox: "0 0 520 250",
    role: "img",
    "aria-label": "Peal Bidder: the owner's signed mandate is the only source of orders; auction text reaches the agent as data. The agent verifies the mandate, plans and clamps; the chain's spending rule allows only fUSD, at most 100 a bid, and only commitBid and claim, before the bid reaches the auction. A fooled answer is clamped; a stolen key is held to the rule.",
    class: "diagram",
  }) as SVGSVGElement;
  peal.append(box(8, 20, 116, 32, { stroke: ACCENT }));
  peal.append(t(66, 41, "signed mandate", { size: 11.5, anchor: "middle", fill: ACCENT }));
  peal.append(arrow(124, 36, 168, 70, ACCENT));
  peal.append(box(8, 108, 116, 32, { dash: "3 3" }));
  peal.append(t(66, 129, "auction text", { size: 11.5, anchor: "middle" }));
  peal.append(arrow(124, 124, 168, 96, INK, "3 3"));
  peal.append(t(146, 150, "data, not orders", { size: 10, fill: MUTED, anchor: "middle" }));
  peal.append(box(170, 50, 100, 60));
  peal.append(t(220, 72, "agent", { size: 12.5, weight: 600, anchor: "middle" }));
  peal.append(t(220, 88, "verify · plan", { size: 10.5, anchor: "middle", fill: MUTED }));
  peal.append(t(220, 101, "clamp", { size: 10.5, anchor: "middle", fill: MUTED }));
  peal.append(arrow(270, 80, 312, 80, ACCENT));
  peal.append(box(314, 46, 112, 68));
  peal.append(s("line", { x1: 314, y1: 46, x2: 426, y2: 46, stroke: RED, "stroke-width": 3 }));
  peal.append(t(370, 66, "spending rule", { size: 12, weight: 600, anchor: "middle" }));
  peal.append(t(370, 84, "fUSD · ≤ 100/bid", { size: 10.5, anchor: "middle", mono: true, fill: MUTED }));
  peal.append(t(370, 100, "commitBid, claim", { size: 10.5, anchor: "middle", mono: true, fill: MUTED }));
  peal.append(arrow(426, 80, 452, 80, ACCENT));
  peal.append(t(458, 76, "the auction", { size: 11, fill: ACCENT }));
  peal.append(t(458, 92, "only", { size: 11, fill: ACCENT }));
  peal.append(s("line", { x1: 8, y1: 172, x2: 512, y2: 172, stroke: INK, "stroke-opacity": 0.12 }));
  peal.append(t(8, 198, "Two checks between the model's answer and the money.", { size: 12.5, weight: 600 }));
  peal.append(t(8, 220, "A fooled answer is clamped; a stolen key is held to the rule.", { size: 12, fill: MUTED }));

  return h(
    "div.problem",
    h("figure.problem-panel.is-hot", h("figcaption", "An agent with a hot wallet"), h("div.problem-scroll", hot)),
    h("figure.problem-panel.is-peal", h("figcaption", "Peal Bidder"), h("div.problem-scroll", peal)),
  );
}

// ---------------------------------------------------------------- 2. who holds which key

type Key = { name: string; algo: string; does: string; kind?: "pq" | "classical" | "public" | "rule" };

function keyRow(k: Key): HTMLElement {
  return h(`li.key.is-${k.kind ?? "classical"}`, h("span.key-glyph", { "aria-hidden": "true" }), h("span.key-body", h("span.key-name", k.name, " ", h("code", k.algo)), h("span.key-does", k.does)));
}

function keyCol(title: string, where: string, keys: Key[], note?: Child): HTMLElement {
  return h("div.key-col", h("div.key-head", h("strong", title), h("span", where)), h("ul.key-list", ...keys.map(keyRow)), note ? h("p.key-note", note) : null);
}

/** Who holds which key: four places, what each key can sign, and what a thief of each machine gets. */
export function keyMap(): HTMLElement {
  return h(
    "figure.keymap",
    {
      role: "img",
      "aria-label":
        "Who holds which key. The owner's machine holds the owner's secp256k1 and ML-DSA-87 keys and the agent account's ML-DSA-87 key, so only the owner signs mandates, links or revokes the agent key, sets the spending rule and opens the agent's windows. The agent's machine holds only the agent's secp256k1 key, its ML-KEM-1024 key to open mandates, and a standalone ML-DSA-87 receipt key with no power on chain. The relayer holds only gas. QoreChain holds the public keys and the spending rule. A thief of the agent's machine gets the agent's column and is held to the rule.",
    },
    h(
      "div.key-cols",
      keyCol("Owner", "the owner's machine", [
        { name: "Owner account", algo: "secp256k1 + ML-DSA-87", does: "signs mandates, links and revokes the agent key, sets the spending rule", kind: "pq" },
        { name: "Agent account", algo: "ML-DSA-87", does: "opens the agent's windows; held by the owner, so the agent cannot raise its own limits", kind: "pq" },
      ]),
      h("div.key-arrow", { "aria-hidden": "true" }, h("span", "sealed mandate"), h("i")),
      keyCol(
        "Agent",
        "the agent's machine",
        [
          { name: "Linked key", algo: "secp256k1", does: "signs MsgExecuteEVM calls, bounded by the rule", kind: "classical" },
          { name: "Mandate key", algo: "ML-KEM-1024 + X25519", does: "opens mandates sealed to this agent", kind: "classical" },
          { name: "Receipt key", algo: "ML-DSA-87", does: "signs receipts; no power on chain", kind: "classical" },
        ],
        h("span", h("strong", "Steal this machine"), " and you get these three keys: bids inside the rule, and nothing else."),
      ),
      h("div.key-arrow", { "aria-hidden": "true" }, h("span", "signed call"), h("i")),
      keyCol("Relayer", "pays gas", [{ name: "Relayer account", algo: "secp256k1 + ML-DSA-87", does: "broadcasts the agent's call; holds only QOR for fees", kind: "classical" }]),
      h("div.key-arrow", { "aria-hidden": "true" }, h("span", "MsgExecuteEVM"), h("i")),
      keyCol("QoreChain", "public state", [
        { name: "Owner's public key", algo: "pqcKeyStatus", does: "what the agent checks every mandate against", kind: "public" },
        { name: "Agent's KEM key", algo: "MsgRegisterKEMKey", does: "what the owner seals mandates to", kind: "public" },
        { name: "Spending rule", algo: "fUSD · 100/bid · 300/day", does: "the limits every linked-key call is checked against", kind: "rule" },
      ]),
    ),
  );
}

// ---------------------------------------------------------------- 3. one bid, message by message

type Msg = { step: string; from: number; to: number; label: string; sub?: string; color?: string; self?: boolean; dash?: boolean };

const LANES = ["Owner", "Agent", "Claude", "Relayer", "QoreChain", "Auction"];

const MSGS: Msg[] = [
  { step: "1", from: 0, to: 1, label: "mandate, signed ML-DSA-87", sub: "sealed ML-KEM-1024", color: ACCENT },
  { step: "2", from: 1, to: 4, label: "pqcKeyStatus(owner)", sub: "read the owner's key", dash: true },
  { step: "2", from: 1, to: 1, label: "verify signature, nonce, expiry", self: true },
  { step: "3", from: 1, to: 2, label: "limits + auction (text as data)" },
  { step: "3", from: 2, to: 1, label: "proposal: tick, size", dash: true },
  { step: "3", from: 1, to: 1, label: "clamp to mandate; seal to 2-of-3", self: true },
  { step: "4", from: 1, to: 3, label: "call signed by the linked key", color: ACCENT },
  { step: "4", from: 3, to: 4, label: "MsgExecuteEVM", color: ACCENT },
  { step: "4", from: 4, to: 4, label: "spending rule: ≤ 100 fUSD, commitBid", self: true, color: RED },
  { step: "4", from: 4, to: 5, label: "commitBid(sealed bid)", color: ACCENT },
  { step: "4", from: 1, to: 1, label: "receipt, signed ML-DSA-87", self: true },
];

/** A sequence diagram of one bid. Groups carry `data-step` for the step list. */
export function sequence(): SVGSVGElement {
  const W = 900;
  const laneX = (i: number) => 70 + i * 152;
  const top = 46;
  const rowH = 38;
  const H = top + 20 + MSGS.length * rowH + 20;
  const svg = s("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    class: "diagram seq",
    "aria-label":
      "One bid, message by message. 1: the owner sends the agent a mandate signed with ML-DSA-87 and sealed with ML-KEM-1024. 2: the agent reads the owner's key from QoreChain (pqcKeyStatus) and verifies the signature, nonce and expiry. 3: the agent sends Claude the limits and the auction, auction text as data; Claude returns a tick and a size; the agent clamps it to the mandate and seals the bid to the 2-of-3 committee. 4: the agent signs the call with its linked key; the relayer broadcasts MsgExecuteEVM; QoreChain checks the spending rule, at most 100 fUSD and only commitBid; the bid reaches the auction; the agent writes a receipt signed with ML-DSA-87.",
  }) as SVGSVGElement;
  LANES.forEach((name, i) => {
    const x = laneX(i);
    svg.append(box(x - 54, 8, 108, 28, i === 4 ? {} : {}));
    svg.append(t(x, 27, name, { size: 12, weight: 600, anchor: "middle" }));
    svg.append(s("line", { x1: x, y1: 36, x2: x, y2: H - 8, stroke: INK, "stroke-opacity": 0.18, "stroke-dasharray": "2 4" }));
  });
  MSGS.forEach((m, i) => {
    const y = top + 28 + i * rowH;
    const g = s("g", { "data-step": m.step });
    const color = m.color ?? INK;
    g.append(t(10, y + 4, m.step, { size: 10.5, mono: true, fill: MUTED }));
    if (m.self) {
      const x = laneX(m.from);
      const d = m.from >= 3 ? -1 : 1; // loops on the right-hand lanes open to the left, so labels stay inside
      g.append(s("path", { d: `M${x},${y - 8} h${22 * d} v16 h${-16 * d}`, fill: "none", stroke: color, "stroke-width": 1.4 }));
      g.append(s("polygon", { points: `${x + 2 * d},${y + 8} ${x + 9 * d},${y + 4.5} ${x + 9 * d},${y + 11.5}`, fill: color }));
      g.append(t(x + 30 * d, y + 4, m.label, { size: 11.5, mono: true, fill: color === RED ? RED : INK, anchor: d > 0 ? "start" : "end" }));
    } else {
      const x1 = laneX(m.from);
      const x2 = laneX(m.to);
      g.append(arrow(x1, y, x2 + (x2 > x1 ? -2 : 2), y, color, m.dash ? "4 3" : undefined));
      const mid = (x1 + x2) / 2;
      g.append(s("rect", { x: mid - m.label.length * 3.45 - 6, y: y - 19, width: m.label.length * 6.9 + 12, height: 15, fill: "#fff" }));
      g.append(t(mid, y - 7, m.label, { size: 11.5, mono: true, anchor: "middle", fill: color === ACCENT ? ACCENT : INK }));
    }
    svg.append(g);
  });
  return svg;
}

// ---------------------------------------------------------------- 4. where each attack stops

type Attack = { who: string; stopsAt: 0 | 1 | 2 | 3; outcome: string; bounded?: boolean; clamped?: boolean; proof: string };

const LAYERS = ["Signature check", "Policy", "Spending rule", "Auction"];

const ATTACKS: Attack[] = [
  { who: "Forges a mandate in the owner's name", stopsAt: 0, outcome: "refused: SIGNATURE_INVALID", proof: "live, receipt #4" },
  { who: "Recovers the owner's classical key (Q-Day)", stopsAt: 0, outcome: "refused: no ML-DSA-87 signature", proof: "35 mandate tests" },
  { who: "Hides orders in the auction text", stopsAt: 1, outcome: "kept inside the mandate", clamped: true, proof: "live, D6F66BD9…; 2,000-case fuzz" },
  { who: "Takes over the agent and skips its policy", stopsAt: 2, outcome: "refused: per-tx limit", proof: "live, 4012FE2E…" },
  { who: "Calls a contract off the allowlist", stopsAt: 2, outcome: "refused: not permitted", proof: "live, 8FB22F76…" },
  { who: "Steals the agent's key", stopsAt: 2, outcome: "bounded: fUSD only, 100 a bid, the day's limit", bounded: true, proof: "threat model" },
];

/** Where each attack stops: a track per attacker across the four layers, with the proof. */
export function attackMap(): HTMLElement {
  const head = h("div.atk-row.atk-head", { role: "row" }, h("span", { role: "columnheader" }, "The attacker"), h("span.atk-track", { role: "columnheader" }, ...LAYERS.map((l) => h("span.atk-layer", l))), h("span", { role: "columnheader" }, "Outcome and proof"));
  const rows = ATTACKS.map((a) => {
    const cells = LAYERS.map((_, i) => h(`span.atk-cell${i < a.stopsAt ? ".is-passed" : i === a.stopsAt ? (a.bounded ? ".is-bounded" : ".is-stop") : ".is-never"}`, { "aria-hidden": "true" }));
    return h(
      "div.atk-row",
      { role: "row" },
      h("span.atk-who", { role: "rowheader" }, a.who),
      h("span.atk-track", { role: "cell", "aria-label": `stopped at ${LAYERS[a.stopsAt]}` }, ...cells),
      h("span.atk-out", { role: "cell" }, h("span.atk-at", `at the ${LAYERS[a.stopsAt]!.toLowerCase()}`), h(`span.atk-result${a.bounded ? ".is-bounded" : a.clamped ? ".is-clamped" : ""}`, a.outcome), h("span.atk-proof", a.proof)),
    );
  });
  return h("div.atk", { role: "table", "aria-label": "Where each attack stops, across the signature check, the policy, the spending rule and the auction" }, head, ...rows);
}

export { GREEN };
