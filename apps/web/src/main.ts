/**
 * Peal Bidder on the web: the landing page, the live agent (its receipts,
 * checked in the browser), and a playground where a visitor's own agent runs.
 *
 * Routes: `#/` landing, `#/agent` the live agent, `#/try` the playground.
 * A hash without a slash (`#security`) is a section of the landing page.
 */
import "./styles.css";
import { REPO } from "./config.ts";
import { h, icon, mark } from "./ui.ts";
import { landing } from "./pages/landing.ts";
import { agentPage } from "./pages/agent.ts";
import { tryPage } from "./pages/try.ts";
import { mountPanel, walletButton } from "./wallet/panel.ts";
import { refreshGuest } from "./wallet/store.ts";

type Page = () => HTMLElement;
const ROUTES: Record<string, { page: Page; title: string }> = {
  "": { page: landing, title: "Peal Bidder" },
  agent: { page: agentPage, title: "The live agent · Peal Bidder" },
  try: { page: tryPage, title: "Your agent · Peal Bidder" },
};

const app = document.getElementById("app")!;

function route(): { path: string; anchor?: string } {
  const raw = location.hash.replace(/^#/, "");
  if (raw.startsWith("/")) return { path: raw.slice(1).split(/[/?]/)[0] ?? "" };
  return { path: "", ...(raw ? { anchor: raw } : {}) };
}

function header(path: string): HTMLElement {
  const family = h(
    "nav.family-switch",
    { "aria-label": "Peal products" },
    h("a", { href: "https://github.com/Adityaakr/peal-sealed-auction", target: "_blank", rel: "noopener", title: "Peal Sealed Auction" }, mark("auction", 18), h("span.sr-only", "Peal Sealed Auction")),
    h("a", { href: "https://github.com/Adityaakr/peal-tender", target: "_blank", rel: "noopener", title: "Peal Tender" }, mark("tender", 18), h("span.sr-only", "Peal Tender")),
    h("a.is-here", { href: "#/", title: "Peal Bidder (this site)", "aria-current": "true" }, mark("bidder", 18), h("span.sr-only", "Peal Bidder")),
  );
  const link = (href: string, text: string, current = false) => h("a.nav-link", { href, ...(current ? { "aria-current": "page" } : {}) }, text);
  return h(
    "header.site-nav",
    h(
      "div.wrap.nav-inner",
      h("a.wordmark", { href: "#/", "aria-label": "Peal Bidder, home" }, mark("bidder"), h("span", "Peal Bidder")),
      family,
      h(
        "nav.nav-links",
        { "aria-label": "Sections" },
        link("#how-it-works", "How it works"),
        link("#security", "Security"),
        link("#/agent", "Live agent", path === "agent"),
        link("#/try", "Try it", path === "try"),
      ),
      h(
        "div.nav-actions",
        h("a.btn.btn-small.btn-ghost.nav-gh", { href: REPO, target: "_blank", rel: "noopener", "aria-label": "Source on GitHub" }, icon("github"), h("span.nav-gh-text", "GitHub")),
        path === "try" ? null : h("a.btn.btn-small.btn-primary.nav-open", { href: "#/try" }, "Open the app"),
        walletButton(),
      ),
    ),
  );
}

function footer(): HTMLElement {
  const col = (title: string, ...links: [string, string][]) =>
    h("div.foot-col", h("h4", title), ...links.map(([t, href]) => h("a", { href, ...(href.startsWith("http") ? { target: "_blank", rel: "noopener" } : {}) }, t)));
  return h(
    "footer.site-footer",
    h(
      "div.wrap",
      h(
        "div.foot-grid",
        h(
          "div.foot-brand",
          h("a.wordmark", { href: "#/" }, mark("bidder"), h("span", "Peal Bidder")),
          h("p", "An AI agent that bids in Peal sealed auctions for its owner, inside limits QoreChain enforces."),
        ),
        col("Product", ["Live agent", "#/agent"], ["Your agent", "#/try"], ["How it works", "#how-it-works"], ["Security", "#security"]),
        col("Developers", ["Source", REPO], ["Threat model", `${REPO}/blob/main/THREAT_MODEL.md`], ["Mandate format", `${REPO}/blob/main/docs/mandate.md`], ["qore-pq-kit", "https://github.com/Adityaakr/qore-pq-kit"]),
        col("Hackathon", ["How AI built this", `${REPO}/blob/main/AI_USAGE.md`], ["Peal Sealed Auction", "https://github.com/Adityaakr/peal-sealed-auction"], ["Peal Tender", "https://github.com/Adityaakr/peal-tender"]),
      ),
      h(
        "div.foot-base",
        h("span", "Apache-2.0. Design language from Peal. Testnet only: qorechain-diana."),
        h("span", "Keys you make here stay in this browser; the live agent's owner signs in the CLI."),
      ),
    ),
  );
}

let current = "";

function render(): void {
  const { path, anchor } = route();
  const r = ROUTES[path] ?? ROUTES[""]!;
  const key = ROUTES[path] ? path : "";
  if (key !== current || !app.firstChild) {
    current = key;
    document.title = r.title;
    const main = h("main#main.page-enter", r.page());
    app.replaceChildren(h("a.skip", { href: "#main", onclick: (e: Event) => { e.preventDefault(); document.getElementById("main")?.focus(); } }, "Skip to content"), header(key), main, footer());
    main.setAttribute("tabindex", "-1");
    if (!anchor) window.scrollTo(0, 0);
  } else {
    app.querySelector(".site-nav")?.replaceWith(header(key));
  }
  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}

function onScroll(): void {
  document.body.classList.toggle("is-scrolled", window.scrollY > 8);
}

mountPanel();
window.addEventListener("hashchange", render);
window.addEventListener("scroll", onScroll, { passive: true });
render();
onScroll();
void refreshGuest();
