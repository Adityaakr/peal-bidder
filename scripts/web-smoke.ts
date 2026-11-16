/**
 * web-smoke.ts - drive the web app in headless Chromium (`pnpm web:smoke`).
 *
 * Starts the Vite dev server (with its QoreChain REST proxy), then:
 *  1. the landing page renders, and the live agent's receipts verify in the page;
 *  2. the live agent page shows every receipt verified;
 *  3. a guest account is created in the wallet drawer;
 *  4. its agent accepts a signed, sealed mandate (key checked in the browser),
 *     plans, clamps and seals a bid to the real committee, sending nothing;
 *  5. a forged mandate is refused (SIGNATURE_INVALID), a replay is refused
 *     (REPLAYED), and an injected plan is clamped;
 *  6. no page is wider than the window at 390, 768 and 1280 px, and no page error.
 *
 * Reads the public testnet (auctions, committee keys); sends nothing and needs no
 * funds. Browser: PW_CHROMIUM (an executable path), Playwright's own, or any
 * installed Playwright headless shell. Screenshots go to SHOTS_DIR when it is set.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";

const ROOT = join(import.meta.dirname, "..");
const shots = process.env.SHOTS_DIR?.trim();
if (shots) mkdirSync(shots, { recursive: true });

function findChromium(): string | undefined {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  if (existsSync(chromium.executablePath())) return undefined; // Playwright's own
  const cache = process.platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
    for (const sub of readdirSync(join(cache, dir))) {
      const exe = join(cache, dir, sub, "chrome-headless-shell");
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const steps: string[] = [];
function ok(what: string): void {
  steps.push(what);
  console.log(`ok  ${what}`);
}

async function noOverflow(page: Page, where: string): Promise<void> {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > iw + 1) throw new Error(`${where}: the page is ${sw}px wide in a ${iw}px window`);
}

/** Wait for the result headline to contain `text`; on a timeout, say what it said instead. */
async function expectHeadline(page: Page, text: string | RegExp, timeout = 60_000): Promise<string> {
  try {
    await page.locator(".headline").filter({ hasText: text }).waitFor({ timeout });
  } catch {
    throw new Error(`expected "${String(text)}", the page says: ${(await page.locator(".headline").first().textContent().catch(() => "")) ?? "(nothing)"}`);
  }
  return (await page.locator(".headline").first().textContent()) ?? "";
}

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

const vite = await createServer({ configFile: join(ROOT, "apps", "web", "vite.config.ts"), server: { port: 0, strictPort: false }, logLevel: "error" });
await vite.listen();
const base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "");
const exe = findChromium();
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // 1. landing
  await page.goto(`${base}/`);
  await page.getByRole("heading", { level: 1 }).filter({ hasText: "the chain enforces" }).waitFor();
  await page.getByText(/receipts verified in your browser/).waitFor({ timeout: 60_000 });
  ok("landing page renders; the live receipts verify in the page");
  for (const w of [1280, 768, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    await noOverflow(page, `landing at ${w}px`);
    await shot(page, `landing-${w}`);
  }
  ok("landing has no sideways scroll at 1280, 768 and 390 px");
  await page.setViewportSize({ width: 1280, height: 900 });

  // 2. the live agent
  await page.goto(`${base}/#/agent`);
  await page.getByText(/receipts, all verified in your browser/).waitFor({ timeout: 60_000 });
  ok("live agent page: every receipt verified");
  await shot(page, "agent-1280");
  await page.setViewportSize({ width: 390, height: 900 });
  await noOverflow(page, "agent page at 390px");
  await shot(page, "agent-390");
  await page.setViewportSize({ width: 1280, height: 900 });

  // 3. a guest account
  await page.goto(`${base}/#/try`);
  await page.locator("[data-test=open-wallet]").click();
  await page.locator("[data-test=create-guest]").click();
  await page.locator(".wallet").getByText("Owner EVM").waitFor({ timeout: 60_000 });
  ok("guest account created in the wallet drawer");
  await page.keyboard.press("Escape");

  // 4. a mandate, accepted, planned, clamped and sealed
  const send = page.locator("[data-test=send-mandate]");
  await send.waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector("[data-test=send-mandate]")?.hasAttribute("disabled"), null, { timeout: 60_000 });
  await send.click();
  const body = await expectHeadline(page, "Your mandate: accepted", 120_000);
  if (!/Bid: /.test(body)) throw new Error(`no bid after the mandate: ${body}`);
  ok(`mandate accepted and a bid planned: ${body.match(/Bid: .*? at tick \d+/)?.[0] ?? ""}`);
  if (/Sealed to the auction's real/.test(body)) ok("the bid was sealed to the auction's real committee in the browser");
  await shot(page, "try-accepted-1280");

  // 5. try to break it
  await page.locator("[data-test=attack-forge]").click();
  await expectHeadline(page, "SIGNATURE_INVALID");
  ok("forged mandate refused: SIGNATURE_INVALID");
  await page.locator("[data-test=attack-replay]").click();
  await expectHeadline(page, "REPLAYED");
  ok("replayed mandate refused: REPLAYED");
  await page.locator("[data-test=attack-tamper]").click();
  await expectHeadline(page, /Raise the budget.*SIGNATURE_INVALID/);
  ok("budget raised after signing refused: SIGNATURE_INVALID");
  await page.locator("[data-test=attack-expired]").click();
  await expectHeadline(page, "EXPIRED");
  ok("expired mandate refused: EXPIRED");
  await page.locator("[data-test=attack-other-agent]").click();
  await expectHeadline(page, "SEAL_OPEN_FAILED");
  ok("mandate sealed to another agent refused: SEAL_OPEN_FAILED");
  await page.locator("[data-test=attack-inject]").click();
  await expectHeadline(page, "the policy lowered", 120_000);
  ok("injected plan clamped by the policy");
  const receipts = await page.locator(".receipt").count();
  if (receipts < 6) throw new Error(`expected receipts for each step, saw ${receipts}`);
  ok(`${receipts} receipts in the browser log`);
  await page.setViewportSize({ width: 390, height: 900 });
  await noOverflow(page, "playground at 390px");
  await shot(page, "try-390");

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  ok("no page errors");
} catch (e) {
  failed = true;
  console.error(`FAIL ${(e as Error).message}`);
} finally {
  await browser.close();
  await vite.close();
}
console.log(failed ? "web smoke: FAILED" : `web smoke: ${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
