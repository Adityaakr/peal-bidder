// capture.mjs - screenshot the real Peal Bidder screens the film shows, at 2x, into <film>/assets/shots/.
//
//   pnpm web:build && pnpm web:preview --port 4931     # the production build, with the REST/RPC proxy
//   OUT=<film>/assets/shots BASE=http://localhost:4931/ node docs/video/src/capture.mjs
//
// Run from the repository root (it uses the repository's playwright-core). The pages read the
// public testnet live: the agent's published receipts, the owner's key and spending rule, the
// demo auction and its committee. The guest account is made in the page from a fresh recovery
// phrase; nothing is funded or sent, and only public addresses and hashes appear.
import { mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = (process.env.BASE ?? "http://localhost:4931/").replace(/\/?$/, "/");
const OUT = process.env.OUT ?? "assets/shots";
mkdirSync(OUT, { recursive: true });

function findChromium() {
  if (process.env.CHROME) return process.env.CHROME;
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse() : []) {
    const exe = join(cache, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const exe = findChromium();
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const shot = (name) => join(OUT, `${name}.png`);

// Where things are on each full-page shot, in CSS px of the page ([x, y, w, h]): the film's
// camera frames them. Each entry is a CSS selector, or text whose nearest row or card is taken.
const rects = {};
async function measure(name, targets) {
  rects[name] = await page.evaluate((targets) => {
    const out = {};
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
    };
    for (const [key, t] of Object.entries(targets)) {
      let el = null;
      if (t.startsWith("css:")) el = document.querySelector(t.slice(4));
      else {
        const walker = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.textContent.includes(t)) { el = n.parentElement; break; }
        }
        el = el?.closest("li, .card, section, figure, article") ?? el;
      }
      if (el) out[key] = box(el);
    }
    return out;
  }, targets);
}

// 1. The landing page: the hero with its console, and the sections the film walks through.
await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByText(/receipts · ML-DSA-87 verified in this browser/).waitFor({ timeout: 60_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: shot("hero") });
await page.addStyleTag({ content: "header{display:none!important}" });
// Rows inside the landing sections, relative to each section's own shot.
async function measureIn(name, root, targets) {
  rects[name] = await page.evaluate(({ root, targets }) => {
    const base = document.querySelector(root).getBoundingClientRect();
    const out = {};
    for (const [key, t] of Object.entries(targets)) {
      let el = null;
      if (t.startsWith("css:")) el = document.querySelector(`${root} ${t.slice(4)}`);
      else {
        const walker = document.createTreeWalker(document.querySelector(root), NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(t)) { el = n.parentElement; break; }
        el = el?.closest("tr, li, .line, [class*=line], [class*=step]") ?? el;
      }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out[key] = [Math.round(r.left - base.left), Math.round(r.top - base.top), Math.round(r.width), Math.round(r.height)];
    }
    return out;
  }, { root, targets });
}
await measureIn("mandate", "#mandate", {
  title: "A signed document",
  doc: "css:figure.mandate-doc",
  owner: '"owner"',
  budget: '"budget"',
  maxPerBid: '"maxPerBid"',
  maxTick: '"maxTick"',
  expiresAt: '"expiresAt"',
  legend: "Signed with ML-DSA-87, sealed",
});
await measureIn("how", "#how-it-works", {
  step1: "The owner signs a",
  step2: "The agent checks it",
  step3: "Claude proposes, the",
  step4: "The chain enforces the",
  diagram: "css:svg",
  rule: "spending rule: ≤ 100 fUSD",
});
await measureIn("requirements", "#requirements", {
  title: "The category's requirements",
  window: "Scoped EVM window",
  limits: "Transaction, value, duration and target limits",
  rules: "Smart-account spending rules",
  messaging: "Authenticated messaging",
  table: "css:table",
});
for (const [name, sel] of Object.entries({
  problem: "#problem",
  keys: "#keys",
  mandate: "#mandate",
  how: "#how-it-works",
  security: "#security",
  requirements: "#requirements",
  family: "#family",
})) {
  const el = page.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await el.screenshot({ path: shot(name) });
}

// 2. The live agent: its receipts verified in the page, the chain read live.
await page.goto(`${BASE}?agent#/agent`, { waitUntil: "networkidle" });
// Full-page shots: the sticky header stays at the top of the page instead of mid-page.
const unstick = () => page.addStyleTag({ content: "header{position:absolute!important}" });
await unstick();
await page.getByText(/receipts, all verified in your browser/).waitFor({ timeout: 60_000 });
await page.getByText(/Settled, 1 bid/).waitFor({ timeout: 60_000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: shot("agent"), fullPage: true });
await measure("agent", {
  verified: "receipts, all verified in your browser",
  chain: "Read from the chain, now",
  plan1: "I'm bidding at a moderate tick",
  landed1: "Bid landed: 100 fUSD at tick 10",
  forged: "Mandate refused by the agent",
  injected: "that is untrusted injected text",
  claims: "Claimed bid 1",
  refusedRule: "which the linked key's spending rule does not list",
  refusedDaily: "daily limit 100000000",
  landed3: "Bid landed: 100 fUSD at tick 15",
});

// 3. Your agent: a guest account, a mandate, then two attacks.
await page.goto(`${BASE}?try#/try`, { waitUntil: "networkidle" });
await unstick();
await page.locator("[data-test=open-wallet]").click();
await page.locator("[data-test=create-guest]").click();
await page.locator(".wallet").getByText("Owner EVM").waitFor({ timeout: 60_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: shot("wallet") });
await page.keyboard.press("Escape");
const send = page.locator("[data-test=send-mandate]");
await page.waitForFunction(() => !document.querySelector("[data-test=send-mandate]")?.hasAttribute("disabled"), null, { timeout: 90_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: shot("try-form"), fullPage: true });
await measure("try-form", { auction: "The auction", form: "1. Write a mandate", steps: "What your agent did", attacks: "2. Try to break it" });
await send.click();
await page.locator(".headline").filter({ hasText: "Your mandate: accepted" }).waitFor({ timeout: 120_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: shot("try-accepted"), fullPage: true });
await measure("try-accepted", { steps: "What your agent did", headline: "css:.headline", attacks: "2. Try to break it", receipts: "Plan another bid" });
await page.locator("[data-test=attack-forge]").click();
await page.locator(".headline").filter({ hasText: "SIGNATURE_INVALID" }).waitFor({ timeout: 60_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: shot("try-forged"), fullPage: true });
await measure("try-forged", { steps: "What your agent did", headline: "css:.headline", attacks: "2. Try to break it", receipts: "Plan another bid" });
await page.locator("[data-test=attack-replay]").click();
await page.locator(".headline").filter({ hasText: "REPLAYED" }).waitFor({ timeout: 60_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: shot("try-replayed"), fullPage: true });
await measure("try-replayed", { steps: "What your agent did", headline: "css:.headline", attacks: "2. Try to break it", receipts: "Plan another bid" });
await page.locator("[data-test=attack-inject]").click();
await page.locator(".headline").filter({ hasText: "the policy lowered" }).waitFor({ timeout: 120_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: shot("try-injected"), fullPage: true });
await measure("try-injected", { steps: "What your agent did", headline: "css:.headline", attacks: "2. Try to break it", receipts: "Plan another bid" });

writeFileSync(join(OUT, "rects.json"), JSON.stringify(rects, null, 1));
await browser.close();
console.log(`screens written to ${OUT}`);
