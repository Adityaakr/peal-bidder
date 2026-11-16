/**
 * The mechanism, drawn as a schematic: how a mandate becomes a bid, and the hard
 * lines where each kind of attempt stops. White boxes with an ink stroke, the
 * signed path in the accent, refusals as red lines; labels in Plex Mono for names
 * of calls and keys, Plex Sans for plain words. Parts carry `data-step` so the
 * step list can highlight them; numbered callouts match the steps.
 *
 * Two layouts: a wide one, and a vertical one for phones (not the wide one scaled
 * down). Every label here also appears in the page text.
 */
import { s } from "../ui.ts";

const INK = "#0b1320";
const MUTED = "#667180";
const PAPER = "#ffffff";
const ACCENT = "#0369a1";
const GREEN = "#12804a";
const RED = "#c9261c";
const MONO = "IBM Plex Mono, ui-monospace, monospace";
const SANS = "IBM Plex Sans, system-ui, sans-serif";

function box(x: number, y: number, w: number, hh: number, stroke = INK, dash?: string): SVGElement {
  return s("rect", { x, y, width: w, height: hh, rx: 6, fill: PAPER, stroke, "stroke-opacity": stroke === INK ? 0.85 : 1, "stroke-width": 1, ...(dash ? { "stroke-dasharray": dash } : {}) });
}

function t(x: number, y: number, txt: string, o: { size?: number; weight?: number; fill?: string; anchor?: string; mono?: boolean } = {}): SVGElement {
  return s("text", { x, y, "font-size": o.size ?? 12, "font-weight": o.weight ?? 400, fill: o.fill ?? INK, "text-anchor": o.anchor ?? "start", "font-family": o.mono ? MONO : SANS }, txt);
}

function line(d: string, color = INK, cls = "", w = 1.25, dash?: string): SVGElement {
  return s("path", { d, fill: "none", stroke: color, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round", class: cls, ...(dash ? { "stroke-dasharray": dash } : {}) });
}

function head(x: number, y: number, dir: "right" | "down" | "left", color = INK): SVGElement {
  const p = dir === "right" ? `${x},${y} ${x - 7},${y - 3.5} ${x - 7},${y + 3.5}` : dir === "left" ? `${x},${y} ${x + 7},${y - 3.5} ${x + 7},${y + 3.5}` : `${x},${y} ${x - 3.5},${y - 7} ${x + 3.5},${y - 7}`;
  return s("polygon", { points: p, fill: color });
}

function callout(x: number, y: number, n: string): SVGElement {
  const g = s("g", { class: "callout" });
  g.append(s("circle", { cx: x, cy: y, r: 9, fill: PAPER, stroke: ACCENT, "stroke-width": 1.25 }));
  g.append(t(x, y + 4, n, { size: 11, weight: 600, fill: ACCENT, anchor: "middle", mono: true }));
  return g;
}

function tick(x: number, y: number, ok: boolean, cls = ""): SVGElement {
  const g = s("g", { class: cls });
  g.append(
    s("path", {
      d: ok ? `M${x - 4},${y} l3,3 l5.5,-6` : `M${x - 4},${y - 4} l8,8 M${x + 4},${y - 4} l-8,8`,
      fill: "none",
      stroke: ok ? GREEN : RED,
      "stroke-width": 1.8,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  return g;
}

const LABEL =
  "How a mandate becomes a bid. 1: the owner signs a mandate with ML-DSA-87 and seals it with ML-KEM-1024. 2: the agent opens it and verifies the signature against the owner's key on chain (pqcKeyStatus); a forged mandate stops there with SIGNATURE_INVALID. 3: Claude Opus 5.5 plans and the policy clamps the plan to the mandate. 4: QoreChain's spending rule checks the call again, 100 fUSD per bid, only commitBid and claim; a 110 fUSD bid stops at that line. The bid reaches Peal Sealed Auction sealed to a 2-of-3 committee. Every step is a receipt signed with ML-DSA-87.";

/** The wide drawing (viewBox 640 x 460). */
export function mechanismWide(): SVGSVGElement {
  const svg = s("svg", { viewBox: "0 0 640 462", role: "img", "aria-label": LABEL, class: "mech mech-wide" }) as SVGSVGElement;

  // 1: the owner signs and seals; the signed path is the accent
  const g1 = s("g", { "data-step": "1" });
  g1.append(box(16, 24, 176, 92));
  g1.append(t(32, 50, "Owner", { size: 13, weight: 600 }));
  g1.append(t(32, 72, "signs  ML-DSA-87", { size: 11, mono: true, fill: MUTED }));
  g1.append(t(32, 90, "seals  ML-KEM-1024", { size: 11, mono: true, fill: MUTED }));
  g1.append(callout(192, 24, "1"));
  g1.append(line("M192,70 L262,70", ACCENT, "draw-path", 1.6));
  g1.append(head(270, 70, "right", ACCENT));
  g1.append(t(228, 62, "mandate", { size: 10.5, fill: ACCENT, anchor: "middle", mono: true }));
  svg.append(g1);

  // the agent: four checks in one box
  svg.append(box(272, 24, 352, 228));
  svg.append(t(288, 48, "Agent", { size: 13, weight: 600 }));
  svg.append(t(608, 48, "holds only its classical key", { size: 11, fill: MUTED, anchor: "end" }));
  const rows: [string, string, string][] = [
    ["2", "open", "ML-KEM-1024 + X25519"],
    ["2", "verify", "pqcKeyStatus"],
    ["3", "plan", "Claude Opus 5.5"],
    ["3", "clamp", "policy"],
  ];
  rows.forEach(([step, verb, code], i) => {
    const y = 62 + i * 46;
    const g = s("g", { "data-step": step });
    g.append(s("line", { x1: 288, y1: y, x2: 608, y2: y, stroke: INK, "stroke-opacity": 0.12 }));
    g.append(t(288, y + 28, verb, { size: 12.5, weight: 500 }));
    g.append(t(352, y + 28, code, { size: 12, mono: true, fill: ACCENT }));
    g.append(tick(596, y + 23, true, `draw-check draw-check-${i + 1}`));
    svg.append(g);
  });
  svg.append(callout(624, 108, "2"));
  svg.append(callout(624, 200, "3"));

  // forged mandate: a hard red stop at verify
  const f = s("g", { "data-step": "2" });
  f.append(line("M272,131 L206,131", RED, "", 1.6));
  f.append(s("line", { x1: 200, y1: 120, x2: 200, y2: 142, stroke: RED, "stroke-width": 3, "stroke-linecap": "round" }));
  f.append(t(192, 160, "forged mandate", { size: 11.5, anchor: "end" }));
  f.append(t(192, 176, "SIGNATURE_INVALID", { size: 11, anchor: "end", mono: true, fill: RED }));
  svg.append(f);

  // 4: the chain's spending rule, its top edge the hard line; then the auction
  const g4 = s("g", { "data-step": "4" });
  g4.append(line("M300,252 L300,310", ACCENT, "draw-path", 1.6));
  g4.append(head(300, 318, "down", ACCENT));
  g4.append(box(272, 320, 200, 92));
  g4.append(s("line", { x1: 272, y1: 320, x2: 472, y2: 320, stroke: RED, "stroke-width": 3 }));
  g4.append(t(472, 312, "limit: 100 fUSD a bid", { size: 10.5, mono: true, fill: RED, anchor: "end" }));
  g4.append(t(288, 344, "QoreChain spending rule", { size: 12.5, weight: 600 }));
  g4.append(t(288, 366, "fUSD only", { size: 11.5, mono: true, fill: MUTED }));
  g4.append(t(288, 384, "≤ 100 fUSD per bid", { size: 11.5, mono: true, fill: MUTED }));
  g4.append(t(288, 402, "commitBid, claim", { size: 11.5, mono: true, fill: MUTED }));
  g4.append(callout(472, 412, "4"));
  // a 110 fUSD attempt stops at the rule's edge
  g4.append(line("M206,366 L262,366", RED, "", 1.6));
  g4.append(s("line", { x1: 268, y1: 354, x2: 268, y2: 378, stroke: RED, "stroke-width": 3, "stroke-linecap": "round" }));
  g4.append(t(192, 362, "110 fUSD bid", { size: 11.5, anchor: "end" }));
  g4.append(t(192, 378, "per-tx limit exceeded", { size: 11, anchor: "end", mono: true, fill: RED }));
  // the bid goes on, sealed, to the auction
  g4.append(line("M472,366 L494,366", ACCENT, "draw-path", 1.6));
  g4.append(head(502, 366, "right", ACCENT));
  g4.append(box(504, 320, 120, 92));
  g4.append(s("path", { d: "M520,346 h22", stroke: INK, "stroke-width": 2, "stroke-linecap": "round" }));
  g4.append(s("rect", { x: 526, y: 341, width: 10, height: 10, rx: 1.5, fill: INK, class: "seal-pop" }));
  g4.append(t(520, 374, "Peal Sealed", { size: 12, weight: 600 }));
  g4.append(t(520, 390, "Auction", { size: 12, weight: 600 }));
  g4.append(t(520, 404, "2-of-3 committee", { size: 10.5, fill: MUTED }));
  svg.append(g4);

  // receipts: every step
  const r = s("g", { "data-step": "5" });
  r.append(s("line", { x1: 16, y1: 432, x2: 624, y2: 432, stroke: INK, "stroke-opacity": 0.12 }));
  for (let i = 0; i < 10; i++) r.append(s("rect", { x: 16 + i * 14, y: 442, width: 10, height: 10, rx: 1.5, fill: i === 9 ? ACCENT : "none", stroke: ACCENT, "stroke-width": 1 }));
  r.append(t(162, 451, "every step is a receipt, signed ML-DSA-87 and hash-chained", { size: 11, mono: true, fill: MUTED }));
  svg.append(r);
  return svg;
}

/** The phone drawing (viewBox 340 x 640): the same parts, stacked, larger labels. */
export function mechanismTall(): SVGSVGElement {
  const svg = s("svg", { viewBox: "0 0 340 640", role: "img", "aria-label": LABEL, class: "mech mech-tall" }) as SVGSVGElement;
  const g1 = s("g", { "data-step": "1" });
  g1.append(box(10, 12, 320, 70));
  g1.append(t(26, 38, "Owner", { size: 14, weight: 600 }));
  g1.append(t(26, 62, "signs ML-DSA-87 · seals ML-KEM-1024", { size: 11.5, mono: true, fill: MUTED }));
  g1.append(callout(320, 12, "1"));
  g1.append(line("M170,82 L170,104", ACCENT, "", 1.6));
  g1.append(head(170, 112, "down", ACCENT));
  svg.append(g1);
  svg.append(box(10, 114, 320, 230));
  svg.append(t(26, 140, "Agent", { size: 14, weight: 600 }));
  const rows: [string, string, string][] = [
    ["2", "open", "ML-KEM-1024"],
    ["2", "verify", "pqcKeyStatus"],
    ["3", "plan", "Claude Opus 5.5"],
    ["3", "clamp", "policy"],
  ];
  rows.forEach(([step, verb, code], i) => {
    const y = 154 + i * 46;
    const g = s("g", { "data-step": step });
    g.append(s("line", { x1: 26, y1: y, x2: 314, y2: y, stroke: INK, "stroke-opacity": 0.12 }));
    g.append(t(26, y + 29, verb, { size: 13, weight: 500 }));
    g.append(t(92, y + 29, code, { size: 12.5, mono: true, fill: ACCENT }));
    g.append(tick(302, y + 24, true));
    svg.append(g);
  });
  svg.append(callout(330, 200, "2"));
  svg.append(callout(330, 292, "3"));
  const f = s("g", { "data-step": "2" });
  f.append(s("line", { x1: 26, y1: 362, x2: 26, y2: 384, stroke: RED, "stroke-width": 3, "stroke-linecap": "round" }));
  f.append(t(38, 378, "forged mandate: SIGNATURE_INVALID", { size: 12, mono: true, fill: RED }));
  svg.append(f);
  const g4 = s("g", { "data-step": "4" });
  g4.append(line("M170,396 L170,430", ACCENT, "", 1.6));
  g4.append(head(170, 438, "down", ACCENT));
  g4.append(s("line", { x1: 10, y1: 420, x2: 330, y2: 420, stroke: RED, "stroke-width": 2 }));
  g4.append(t(330, 412, "per-bid limit, 100 fUSD", { size: 11, mono: true, fill: RED, anchor: "end" }));
  g4.append(box(10, 442, 320, 96));
  g4.append(t(26, 468, "QoreChain spending rule", { size: 14, weight: 600 }));
  g4.append(t(26, 490, "fUSD only · ≤ 100 fUSD per bid", { size: 12, mono: true, fill: MUTED }));
  g4.append(t(26, 510, "commitBid, claim", { size: 12, mono: true, fill: MUTED }));
  g4.append(t(26, 528, "110 fUSD bid: per-tx limit exceeded", { size: 11.5, mono: true, fill: RED }));
  g4.append(callout(330, 442, "4"));
  g4.append(line("M170,538 L170,566", ACCENT, "", 1.6));
  g4.append(head(170, 574, "down", ACCENT));
  g4.append(box(10, 576, 320, 56));
  g4.append(t(26, 600, "Peal Sealed Auction", { size: 13.5, weight: 600 }));
  g4.append(t(26, 620, "sealed to a 2-of-3 committee", { size: 12, fill: MUTED }));
  svg.append(g4);
  return svg;
}
