/**
 * The mechanism, drawn: how a mandate becomes a bid, and where each kind of
 * attempt is stopped. Hand-made SVG on the accent ramp; green and red only for
 * outcomes. Parts carry `data-step` so the step rail can highlight them.
 *
 * Two layouts: a wide one, and a vertical one for phones (not the wide one
 * scaled down). Every label here also appears in the page text.
 */
import { s } from "../ui.ts";

const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const A = { 50: "#eff6ff", 100: "#dbeafe", 200: "#bfdbfe", 300: "#93c5fd", 400: "#60a5fa", 600: "#2563eb", 800: "#1e40af" };
const GREEN = "#16a34a";
const RED = "#dc2626";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

function card(x: number, y: number, w: number, hh: number, fill = "#fff", stroke = LINE): SVGElement {
  return s("rect", { x, y, width: w, height: hh, rx: 12, fill, stroke, "stroke-width": 1 });
}

function text(x: number, y: number, t: string, o: { size?: number; weight?: number; fill?: string; anchor?: string; mono?: boolean } = {}): SVGElement {
  return s(
    "text",
    {
      x,
      y,
      "font-size": o.size ?? 12,
      "font-weight": o.weight ?? 400,
      fill: o.fill ?? INK,
      "text-anchor": o.anchor ?? "start",
      ...(o.mono ? { "font-family": MONO } : {}),
    },
    t,
  );
}

function check(x: number, y: number, color = GREEN, cls = "draw-check"): SVGElement {
  const g = s("g", { class: cls });
  g.append(s("circle", { cx: x, cy: y, r: 8, fill: color === GREEN ? "#f0fdf4" : "#fef2f2", stroke: color, "stroke-width": 1.5 }));
  g.append(
    s("path", {
      d: color === GREEN ? `M${x - 3.5},${y} l2.5,2.5 l4.5,-5` : `M${x - 3},${y - 3} l6,6 M${x + 3},${y - 3} l-6,6`,
      fill: "none",
      stroke: color,
      "stroke-width": 1.7,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  return g;
}

function flow(d: string, cls = "flow", color = A[300]): SVGElement {
  return s("path", { d, fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", class: cls });
}

function arrowHead(x: number, y: number, dir: "right" | "down" | "left", color = A[400]): SVGElement {
  const d = dir === "right" ? `M${x - 6},${y - 4} L${x},${y} L${x - 6},${y + 4}` : dir === "left" ? `M${x + 6},${y - 4} L${x},${y} L${x + 6},${y + 4}` : `M${x - 4},${y - 6} L${x},${y} L${x + 4},${y - 6}`;
  return s("path", { d, fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" });
}

/** A small sealed envelope glyph. */
function envelope(x: number, y: number, cls?: string): SVGElement {
  const g = s("g", { class: cls ?? "" });
  g.append(s("rect", { x: x - 11, y: y - 8, width: 22, height: 16, rx: 3, fill: A[600] }));
  g.append(s("path", { d: `M${x - 11},${y - 6} L${x},${y + 1} L${x + 11},${y - 6}`, fill: "none", stroke: "#fff", "stroke-width": 1.4, "stroke-linejoin": "round" }));
  return g;
}

const LABEL = "How a mandate becomes a bid. The owner signs a mandate with ML-DSA-87 and seals it with ML-KEM-1024. The agent opens it, verifies the signature against the owner's key on chain (pqcKeyStatus), plans with Claude Opus 5.5, and the policy clamps the plan to the mandate. QoreChain's spending rule checks the call again before it reaches Peal Sealed Auction, where the bid is sealed to a 2-of-3 committee. A forged mandate is refused with SIGNATURE_INVALID; a bid over the limit is refused by the chain. Every step is a receipt signed with ML-DSA-87.";

/** The wide drawing (viewBox 640 x 470). */
export function mechanismWide(): SVGSVGElement {
  const svg = s("svg", { viewBox: "0 0 640 470", role: "img", "aria-label": LABEL, class: "mech mech-wide" }) as SVGSVGElement;

  // ---- step 1: the owner signs and seals
  const g1 = s("g", { "data-step": "1" });
  g1.append(card(16, 20, 190, 104));
  g1.append(s("circle", { cx: 44, cy: 50, r: 12, fill: A[50], stroke: A[600], "stroke-width": 1.5 }));
  g1.append(s("path", { d: "M38,56 a6,6 0 0 1 12,0", fill: "none", stroke: A[600], "stroke-width": 1.5 }));
  g1.append(s("circle", { cx: 44, cy: 46, r: 3, fill: A[600] }));
  g1.append(text(64, 46, "Owner", { size: 13, weight: 600 }));
  g1.append(text(64, 62, "writes a mandate", { size: 11, fill: MUTED }));
  g1.append(s("rect", { x: 30, y: 78, width: 162, height: 34, rx: 8, fill: A[50], stroke: A[200] }));
  g1.append(text(40, 92, "signs: ML-DSA-87", { size: 11, fill: A[800], weight: 600 }));
  g1.append(text(40, 106, "seals: ML-KEM-1024", { size: 11, fill: A[800], weight: 600 }));
  g1.append(flow("M206,72 C226,72 230,72 252,72", "flow flow-1"));
  g1.append(arrowHead(258, 72, "right"));
  g1.append(envelope(231, 72, "travel travel-1"));
  svg.append(g1);

  // ---- step 2 and 3: the agent
  const agent = s("g");
  agent.append(card(262, 20, 362, 236, "#fff", A[200]));
  agent.append(text(282, 46, "Agent", { size: 13, weight: 600 }));
  agent.append(text(330, 46, "holds only its classical key", { size: 11, fill: MUTED }));
  svg.append(agent);
  const rows: [string, string, string, string][] = [
    ["2", "Open", "ML-KEM-1024 + X25519", "sealed to this agent only"],
    ["2", "Verify", "pqcKeyStatus", "the owner's key, read from the chain"],
    ["3", "Plan", "Claude Opus 5.5", "auction text is data, never orders"],
    ["3", "Clamp", "policy", "tick, size and budget fit the mandate"],
  ];
  rows.forEach(([step, title, code, sub], i) => {
    const y = 60 + i * 47;
    const g = s("g", { "data-step": step });
    g.append(s("rect", { x: 278, y, width: 330, height: 38, rx: 8, fill: A[50], stroke: A[100] }));
    g.append(text(292, y + 16, title, { size: 12, weight: 600 }));
    g.append(text(346, y + 16, code, { size: 11.5, mono: true, fill: A[800] }));
    g.append(text(292, y + 31, sub, { size: 10.5, fill: MUTED }));
    g.append(check(588, y + 19, GREEN, `draw-check draw-check-${i + 1}`));
    svg.append(g);
  });

  // forged mandate, refused at verify
  const f = s("g", { "data-step": "2" });
  f.append(flow("M278,126 C246,126 240,160 206,160", "flow flow-refused", "#fca5a5"));
  f.append(arrowHead(206, 160, "left", "#f87171"));
  f.append(card(16, 140, 190, 52, "#fff", "#fecaca"));
  f.append(check(36, 166, RED, "draw-x"));
  f.append(text(52, 162, "Forged mandate", { size: 12, weight: 600 }));
  f.append(text(52, 178, "SIGNATURE_INVALID", { size: 10.5, mono: true, fill: RED }));
  svg.append(f);

  // ---- step 4: the chain
  const g4 = s("g", { "data-step": "4" });
  g4.append(flow("M443,256 L443,290", "flow flow-2"));
  g4.append(arrowHead(443, 296, "down"));
  g4.append(card(262, 300, 230, 118, A[50], A[300]));
  g4.append(s("path", { d: "M282,318 l8,-3 l8,3 v6 c0,6 -4,10 -8,12 c-4,-2 -8,-6 -8,-12z", fill: "#fff", stroke: A[600], "stroke-width": 1.5, "stroke-linejoin": "round" }));
  g4.append(text(306, 326, "QoreChain spending rule", { size: 12.5, weight: 600 }));
  g4.append(text(282, 352, "fUSD only", { size: 11, fill: INK }));
  g4.append(text(282, 370, "≤ 100 fUSD per bid, 300 a day", { size: 11, fill: INK }));
  g4.append(text(282, 388, "only commitBid and claim", { size: 11, fill: INK }));
  g4.append(text(282, 406, "on the mandate's auction", { size: 11, fill: MUTED }));
  g4.append(flow("M492,358 L522,358", "flow flow-3"));
  g4.append(arrowHead(528, 358, "right"));
  g4.append(card(532, 300, 92, 118));
  g4.append(s("path", { d: "M556,330 h44", stroke: A[600], "stroke-width": 2, "stroke-linecap": "round" }));
  g4.append(s("rect", { x: 572, y: 324, width: 12, height: 12, rx: 2, fill: A[600], class: "seal-pop" }));
  g4.append(text(578, 360, "Peal Sealed", { size: 11, weight: 600, anchor: "middle" }));
  g4.append(text(578, 374, "Auction", { size: 11, weight: 600, anchor: "middle" }));
  g4.append(text(578, 394, "sealed to a", { size: 10.5, fill: MUTED, anchor: "middle" }));
  g4.append(text(578, 408, "2-of-3 committee", { size: 10.5, fill: MUTED, anchor: "middle" }));
  // over the limit, refused by the chain
  g4.append(flow("M262,372 C236,372 232,330 206,330", "flow flow-refused", "#fca5a5"));
  g4.append(arrowHead(206, 330, "left", "#f87171"));
  g4.append(card(16, 304, 190, 52, "#fff", "#fecaca"));
  g4.append(check(36, 330, RED, "draw-x"));
  g4.append(text(52, 326, "110 fUSD bid", { size: 12, weight: 600 }));
  g4.append(text(52, 342, "per-tx limit exceeded", { size: 10.5, mono: true, fill: RED }));
  svg.append(g4);

  // ---- receipts, under everything
  const r = s("g", { "data-step": "5" });
  r.append(card(16, 432, 608, 30, "#fff", LINE));
  for (let i = 0; i < 7; i++) {
    r.append(s("rect", { x: 30 + i * 22, y: 441, width: 16, height: 12, rx: 3, fill: i < 6 ? A[200] : A[600] }));
    if (i < 6) r.append(s("path", { d: `M${46 + i * 22},447 h6`, stroke: A[300], "stroke-width": 1.5 }));
  }
  r.append(text(196, 451, "Receipts: every step signed with ML-DSA-87 and hash-chained", { size: 11.5, fill: INK }));
  svg.append(r);
  return svg;
}

/** The phone drawing (viewBox 340 x 620): the same parts, stacked. */
export function mechanismTall(): SVGSVGElement {
  const svg = s("svg", { viewBox: "0 0 340 640", role: "img", "aria-label": LABEL, class: "mech mech-tall" }) as SVGSVGElement;
  const g1 = s("g", { "data-step": "1" });
  g1.append(card(10, 10, 320, 62));
  g1.append(text(26, 34, "Owner", { size: 13, weight: 600 }));
  g1.append(text(26, 54, "signs ML-DSA-87 · seals ML-KEM-1024", { size: 11, fill: A[800], weight: 600 }));
  g1.append(flow("M170,72 L170,96", "flow"));
  g1.append(arrowHead(170, 102, "down"));
  svg.append(g1);
  const rows: [string, string, string][] = [
    ["2", "Open", "ML-KEM-1024 + X25519"],
    ["2", "Verify", "pqcKeyStatus"],
    ["3", "Plan", "Claude Opus 5.5"],
    ["3", "Clamp", "policy"],
  ];
  svg.append(card(10, 106, 320, 236, "#fff", A[200]));
  svg.append(text(26, 130, "Agent", { size: 13, weight: 600 }));
  rows.forEach(([step, title, code], i) => {
    const y = 144 + i * 47;
    const g = s("g", { "data-step": step });
    g.append(s("rect", { x: 22, y, width: 296, height: 38, rx: 8, fill: A[50], stroke: A[100] }));
    g.append(text(36, y + 24, title, { size: 12, weight: 600 }));
    g.append(text(92, y + 24, code, { size: 11, mono: true, fill: A[800] }));
    g.append(check(298, y + 19, GREEN, `draw-check draw-check-${i + 1}`));
    svg.append(g);
  });
  const f = s("g", { "data-step": "2" });
  f.append(card(10, 352, 320, 40, "#fff", "#fecaca"));
  f.append(check(30, 372, RED, "draw-x"));
  f.append(text(46, 376, "Forged mandate: SIGNATURE_INVALID", { size: 11.5, fill: INK }));
  svg.append(f);
  const g4 = s("g", { "data-step": "4" });
  g4.append(flow("M170,392 L170,414", "flow"));
  g4.append(arrowHead(170, 420, "down"));
  g4.append(card(10, 424, 320, 92, A[50], A[300]));
  g4.append(text(26, 448, "QoreChain spending rule", { size: 12.5, weight: 600 }));
  g4.append(text(26, 468, "fUSD only · ≤ 100 fUSD per bid", { size: 11 }));
  g4.append(text(26, 486, "only commitBid and claim", { size: 11 }));
  g4.append(text(26, 504, "on the mandate's auction", { size: 11, fill: MUTED }));
  g4.append(card(10, 526, 320, 40, "#fff", "#fecaca"));
  g4.append(check(30, 546, RED, "draw-x"));
  g4.append(text(46, 550, "110 fUSD bid: per-tx limit exceeded", { size: 11.5 }));
  g4.append(card(10, 576, 320, 52));
  g4.append(s("path", { d: "M26,602 h28", stroke: A[600], "stroke-width": 2, "stroke-linecap": "round" }));
  g4.append(s("rect", { x: 34, y: 596, width: 12, height: 12, rx: 2, fill: A[600] }));
  g4.append(text(66, 598, "Peal Sealed Auction", { size: 12, weight: 600 }));
  g4.append(text(66, 614, "sealed to a 2-of-3 committee", { size: 11, fill: MUTED }));
  svg.append(g4);
  return svg;
}
