/**
 * ui.ts - the small toolkit the pages are built from.
 *
 * Adapted from Peal Tender's `apps/dashboard/src/ui.ts` (same element builder,
 * icons and pieces, so the three Peal products look and behave alike).
 *
 * Every piece of text goes in through `textContent`, never `innerHTML`: mandate
 * instructions, auction names and planner output come from other people, so
 * they are data, not markup. Icons are fixed inline SVG paths defined here.
 */
import { formatUnits } from "viem";

export type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;

/** Build an element: h("section.card.stat#id", { title: "x" }, child, ...). */
export function h(tag: string, attrs?: Attrs | Child, ...children: Child[]): HTMLElement {
  const [head, id] = tag.split("#");
  const [name, ...classes] = (head ?? "").split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (id) el.id = id;
  if (attrs && !(attrs instanceof Node) && typeof attrs === "object") {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
      else if (k === "class") el.className += ` ${v}`;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  } else if (attrs !== undefined) {
    children.unshift(attrs as Child);
  }
  for (const c of children) append(el, c);
  return el;
}

export function append(el: Element, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  el.append(c instanceof Node ? c : document.createTextNode(String(c)));
}

const NS = "http://www.w3.org/2000/svg";

/** Build an SVG element; `text` goes in as textContent. */
export function s(tag: string, a: Record<string, string | number | undefined> = {}, ...children: (SVGElement | string)[]): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(a)) if (v !== undefined) e.setAttribute(k, String(v));
  for (const c of children) e.append(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

// ---------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  check: "M3 8.5l3 3 7-7",
  cross: "M4 4l8 8M12 4l-8 8",
  clock: "M8 4v4l2.5 2M8 15A7 7 0 108 1a7 7 0 000 14z",
  dot: "M8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z",
  arrow: "M3 8h10M9 4l4 4-4 4",
  key: "M10 6a3 3 0 11-6 0 3 3 0 016 0zM9 8l5 5M12 11l1.5-1.5",
  shield: "M8 1.5l5.5 2v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4z",
  lock: "M4.5 7V5a3.5 3.5 0 017 0v2M3.5 7h9v7h-9z",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  doc: "M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3",
  copy: "M5.5 5.5h8v8h-8zM2.5 10.5v-8h8",
  pen: "M10.5 2.5l3 3-8 8H2.5v-3z",
  eye: "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z",
  spark: "M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.5 3.5l2 2M10.5 10.5l2 2M12.5 3.5l-2 2M5.5 10.5l-2 2",
  github:
    "M8 1.5a6.5 6.5 0 00-2 12.7c.3 0 .4-.2.4-.4v-1.3c-1.8.4-2.2-.8-2.2-.8-.3-.7-.7-.9-.7-.9-.6-.4 0-.4 0-.4.7 0 1 .7 1 .7.6 1 1.5.7 1.9.6 0-.4.2-.7.4-.9-1.4-.2-3-.7-3-3.2 0-.7.3-1.3.7-1.7-.1-.2-.3-.9.1-1.8 0 0 .5-.2 1.8.7a6 6 0 013.2 0c1.2-.9 1.8-.7 1.8-.7.3.9.1 1.6.1 1.8.4.4.7 1 .7 1.7 0 2.5-1.5 3-3 3.2.2.2.5.6.5 1.2v1.8c0 .2.1.4.5.4A6.5 6.5 0 008 1.5z",
  agent: "M5 8a1.6 1.6 0 11-3.2 0A1.6 1.6 0 015 8zM7 8h7M11 5l3 3-3 3",
  chain: "M6.5 9.5l3-3M5 7.5L3.5 9a2.1 2.1 0 003 3L8 10.5M11 8.5L12.5 7a2.1 2.1 0 00-3-3L8 5.5",
  refresh: "M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3",
};

export function icon(name: string): SVGSVGElement {
  const svg = s("svg", {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.6,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "icon",
  }) as SVGSVGElement;
  svg.append(s("path", { d: PATHS[name] ?? PATHS.dot! }));
  return svg;
}

// ---------------------------------------------------------------- marks (docs/design.md, Marks)

export type Product = "bidder" | "tender" | "auction";

/** A Peal product mark: a ring with the product's sign inside, 26 x 26. */
export function mark(product: Product = "bidder", size = 26): SVGSVGElement {
  const svg = s("svg", { viewBox: "0 0 26 26", width: size, height: size, class: "mark", "aria-hidden": "true" }) as SVGSVGElement;
  const blue = "#0369a1";
  svg.append(s("circle", { cx: 13, cy: 13, r: 11, fill: "none", stroke: blue, "stroke-width": 2 }));
  if (product === "bidder") {
    svg.append(s("circle", { cx: 9, cy: 13, r: 2.6, fill: blue }));
    svg.append(s("path", { d: "M12 13h7M16 10l3 3-3 3", fill: "none", stroke: blue, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  } else if (product === "tender") {
    for (const [cx, cy, on] of [
      [13, 7.5, true],
      [8.2, 16, true],
      [17.8, 16, false],
    ] as const) {
      svg.append(s("circle", { cx, cy, r: 2.6, fill: on ? blue : "#fff", stroke: blue, "stroke-width": 1.6 }));
    }
  } else {
    svg.append(s("path", { d: "M7 13h12", stroke: blue, "stroke-width": 2, "stroke-linecap": "round" }));
    svg.append(s("rect", { x: 10, y: 10, width: 6, height: 6, rx: 1, fill: blue }));
  }
  return svg;
}

// ---------------------------------------------------------------- pieces

export type Tone = "ok" | "bad" | "wait" | "warn" | "plain" | "accent";

/** A status chip: always an icon and a word, never colour alone. */
export function chip(text: string, tone: Tone = "plain", iconName?: string): HTMLElement {
  const fallback = { ok: "check", bad: "cross", wait: "clock", warn: "pause", plain: "dot", accent: "dot" }[tone];
  return h(`span.chip${tone === "plain" ? "" : `.${tone}`}`, icon(iconName ?? fallback), text);
}

/** A copyable hash or address, shortened for display, full on hover and when copied. */
export function hash(value: string, opts: { full?: boolean; label?: string; keep?: number } = {}): HTMLElement {
  const k = opts.keep ?? 6;
  const shown = opts.full || value.length <= 2 * k + 4 ? value : `${value.slice(0, k + 2)}…${value.slice(-k)}`;
  const b = h("button.hash", { type: "button", title: `${value} (click to copy)`, "aria-label": `copy ${opts.label ?? value}` }, shown);
  b.addEventListener("click", () => {
    void navigator.clipboard?.writeText(value).then(() => {
      b.classList.add("copied");
      setTimeout(() => b.classList.remove("copied"), 1200);
    });
  });
  return b;
}

export function meter(fraction: number, tone: "" | "full" | "good" = "", label?: string): HTMLElement {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const m = h(`div.meter${tone ? `.is-${tone}` : ""}`, {
    role: "meter",
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": Math.round(f * 100),
    "aria-label": label ?? "",
  });
  m.append(h("span", { style: `width:${(f * 100).toFixed(1)}%` }));
  return m;
}

/** The kicker above a section title: a short accent rule and a few words. */
export function kicker(text: string): HTMLElement {
  return h("div.kicker", text);
}

/**
 * Sixteen blocks in shades of the one accent, from a key's hash: a fingerprint people
 * can compare at a glance (two keys that differ differ visibly), without new colours.
 */
export function fingerprint(hex: string): HTMLElement {
  const box = h("div.fingerprint", { "aria-hidden": "true" });
  const b = hex.replace(/^0x/, "");
  const shades = ["#e8f3fa", "#d3e8f5", "#b5d6ea", "#7dc0e6", "#38a3d8", "#0b84c2", "#0369a1", "#0c4a6e"];
  for (let i = 0; i < 16; i++) box.append(h("i", { style: `background:${shades[parseInt(b[i * 2] ?? "0", 16) % shades.length]}` }));
  return box;
}

// ---------------------------------------------------------------- formatting

/** A token amount with grouping and at most `max` fraction digits, trailing zeros dropped. */
export function amount(v: bigint, decimals: number, max = 4): string {
  const str = formatUnits(v, decimals);
  const [i, f = ""] = str.split(".");
  const int = BigInt(i!).toLocaleString("en-US");
  const frac = f.slice(0, max).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function duration(seconds: bigint | number): string {
  let sec = Math.max(0, Math.round(Number(seconds)));
  const d = Math.floor(sec / 86400);
  sec -= d * 86400;
  const hrs = Math.floor(sec / 3600);
  sec -= hrs * 3600;
  const m = Math.floor(sec / 60);
  sec -= m * 60;
  if (d) return hrs ? `${d}d ${hrs}h` : `${d}d`;
  if (hrs) return m ? `${hrs}h ${m}m` : `${hrs}h`;
  if (m) return sec ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

export function dateTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function timeOnly(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(11, 19) + " UTC";
}

export function short(a: string, keep = 4): string {
  return a.length <= keep * 2 + 4 ? a : `${a.slice(0, keep + 2)}…${a.slice(-keep)}`;
}

export function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 400);
}

/** Run `f` once `el` scrolls into view (or at once without IntersectionObserver). */
export function onceVisible(el: Element, f: () => void, threshold = 0.25): void {
  if (typeof IntersectionObserver === "undefined") return f();
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        f();
      }
    },
    { threshold },
  );
  io.observe(el);
}

export const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
