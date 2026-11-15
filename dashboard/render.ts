/**
 * The dashboard page: the active mandate, what it has committed, and every
 * receipt (mandates accepted and refused, decisions, results with transaction
 * links). Everything shown comes from the verified receipts log; every string
 * is HTML-escaped, because planner output and refusal messages are untrusted.
 */
import type { CanonicalValue } from "../common/canonical.ts";
import { network } from "../common/network.ts";
import { stateFromReceipts } from "../agent/agent.ts";
import type { Receipt, ReceiptCheck } from "../agent/receipts.ts";

export interface DashboardInput {
  agent: string;
  owner: string;
  receiptKeyHash: string;
  check: ReceiptCheck;
  /** Builds a link for a transaction hash. */
  txUrl: (hash: string) => string;
  now: number;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const FUSD_SCALE = 1_000_000n;
function fusd(baseUnits: bigint | string): string {
  const n = BigInt(baseUnits);
  const whole = n / FUSD_SCALE;
  const frac = (n % FUSD_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} fUSD`;
}

function time(unix: number): string {
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function field(data: CanonicalValue, key: string): CanonicalValue | undefined {
  return typeof data === "object" && data !== null && !Array.isArray(data) ? data[key] : undefined;
}

function summary(r: Receipt, txUrl: (h: string) => string): { tone: "ok" | "refused" | "info"; html: string } {
  const d = r.body.data;
  switch (r.body.kind) {
    case "mandate-accepted":
      return { tone: "ok", html: `Mandate accepted (nonce ${escapeHtml(String(field(d, "nonce")))})` };
    case "mandate-refused":
      return { tone: "refused", html: `Mandate refused: <code>${escapeHtml(String(field(d, "code")))}</code> ${escapeHtml(String(field(d, "message") ?? ""))}` };
    case "decision": {
      const dec = field(d, "decision");
      const source = escapeHtml(String(field(d, "source")));
      const fallbacks = field(d, "attempts");
      const fell = Array.isArray(fallbacks) && fallbacks.length > 0 ? ` (after ${fallbacks.length} failed planner${fallbacks.length > 1 ? "s" : ""})` : "";
      if (field(dec ?? null, "kind") === "bid") {
        const adj = field(dec ?? null, "adjustments");
        const adjText = Array.isArray(adj) && adj.length > 0 ? ` — policy: ${adj.map((a) => `<code>${escapeHtml(String(a))}</code>`).join(" ")}` : "";
        return {
          tone: "info",
          html: `${source}${fell}: bid tick ${escapeHtml(String(field(dec ?? null, "tick")))}, outflow ${escapeHtml(fusd(String(field(dec ?? null, "outflow"))))}${adjText}`,
        };
      }
      return { tone: "info", html: `${source}${fell}: skip <code>${escapeHtml(String(field(dec ?? null, "reason")))}</code> ${escapeHtml(String(field(dec ?? null, "detail") ?? ""))}` };
    }
    case "result": {
      const status = String(field(d, "status"));
      const tx = field(d, "txHash");
      const link = typeof tx === "string" ? ` <a href="${escapeHtml(txUrl(tx))}">${escapeHtml(tx.slice(0, 16))}…</a>` : "";
      const reason = field(d, "reason");
      return {
        tone: status === "landed" ? "ok" : status === "refused" ? "refused" : "info",
        html: `Result: <strong>${escapeHtml(status)}</strong>${link}${typeof reason === "string" ? ` — ${escapeHtml(reason)}` : ""}`,
      };
    }
    case "submission": {
      const dec = field(d, "decision");
      return { tone: "info", html: `Submitting: tick ${escapeHtml(String(field(dec ?? null, "tick")))}, outflow ${escapeHtml(fusd(String(field(dec ?? null, "outflow"))))}` };
    }
    case "claim": {
      const status = String(field(d, "status"));
      const tx = field(d, "txHash");
      const link = typeof tx === "string" ? ` <a href="${escapeHtml(txUrl(tx))}">${escapeHtml(tx.slice(0, 16))}…</a>` : "";
      return {
        tone: status === "landed" ? "ok" : status === "refused" ? "refused" : "info",
        html: `Claim bid ${escapeHtml(String(field(d, "bidId")))} (${escapeHtml(String(field(d, "bidStatus")))}, ${escapeHtml(String(field(d, "allocation")))} won): <strong>${escapeHtml(status)}</strong>${link}`,
      };
    }
    default:
      return { tone: "info", html: escapeHtml(r.body.kind) };
  }
}

export function renderDashboard(input: DashboardInput): string {
  const { check } = input;
  const receipts = check.ok ? check.receipts : [];
  const state = stateFromReceipts(receipts);
  const m = state.mandate;
  const pinned = m ? m.receiptKey === input.receiptKeyHash : undefined;
  const verdict = check.ok
    ? `<span class="ok">${check.count} receipts: chain and ML-DSA-87 signatures verify</span>`
    : `<span class="refused">receipts log broken at line ${check.line}: ${escapeHtml(check.error)}</span>`;

  const mandateHtml = m
    ? `<dl>
        <dt>Mandate</dt><dd><code>${escapeHtml(state.mandateHash ?? "")}</code> (nonce ${m.nonce})</dd>
        <dt>Valid</dt><dd>${escapeHtml(time(m.notBefore))} to ${escapeHtml(time(m.expiresAt))}${input.now >= m.expiresAt ? ' <span class="refused">expired</span>' : ""}</dd>
        <dt>Auctions</dt><dd>${m.auctions.map((a) => `<code>${escapeHtml(a)}</code>`).join("<br>")}</dd>
        <dt>Committed</dt><dd>${escapeHtml(fusd(state.ledger.committed))} of ${escapeHtml(fusd(m.budget))}; ${state.ledger.bids} of ${m.maxBids} bids</dd>
        <dt>Per bid</dt><dd>at most ${escapeHtml(fusd(m.maxPerBid))}, tick at most ${m.maxTick}</dd>
        <dt>Receipt key</dt><dd>${pinned ? '<span class="ok">pinned by this mandate</span>' : '<span class="refused">NOT the key this mandate pins</span>'}</dd>
        <dt>Instructions</dt><dd class="quote">${escapeHtml(m.instructions)}</dd>
      </dl>`
    : "<p>No mandate accepted yet.</p>";

  const rows = receipts
    .slice()
    .reverse()
    .map((r) => {
      const s = summary(r, input.txUrl);
      return `<tr class="${s.tone}"><td>${r.body.seq}</td><td>${escapeHtml(time(r.body.at))}</td><td>${escapeHtml(r.body.kind)}</td><td>${s.html}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Peal Bidder</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1d1b; --muted:#6b6a65; --line:#e3e1da; --ok:#1f7a4d; --bad:#b3261e; --card:#ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ecebe6; --muted:#a3a29b; --line:#2f2e2b; --ok:#5fcf98; --bad:#ff8a80; --card:#1d1d1b; } }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
main { max-width:960px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:28px 0 8px; }
.sub { color:var(--muted); margin:0 0 16px; overflow-wrap:anywhere; }
section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; }
dl { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:6px 16px; margin:0; }
dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
.quote { white-space:pre-wrap; }
table { width:100%; border-collapse:collapse; } td { border-top:1px solid var(--line); padding:6px 8px; vertical-align:top; overflow-wrap:anywhere; }
td:nth-child(1), td:nth-child(2), td:nth-child(3) { white-space:nowrap; color:var(--muted); }
.ok { color:var(--ok); } .refused, tr.refused td:last-child { color:var(--bad); }
code { font:13px ui-monospace, monospace; } a { color:inherit; }
@media (max-width:640px) { td:nth-child(2) { display:none; } }
</style></head>
<body><main>
<h1>Peal Bidder</h1>
<p class="sub">Agent <code>${escapeHtml(input.agent)}</code> for owner <code>${escapeHtml(input.owner)}</code><br>${verdict}</p>
<h2>Active mandate</h2>
<section>${mandateHtml}</section>
<h2>Receipts (newest first)</h2>
<section><table><tbody>
${rows || '<tr><td colspan="4">No receipts yet.</td></tr>'}
</tbody></table></section>
</main></body></html>
`;
}

/** Transaction links: QORE_EXPLORER_TX_URL (a prefix) when set, otherwise the REST transaction route. */
export function txUrlFor(env: Record<string, string | undefined> = process.env): (hash: string) => string {
  const prefix = env.QORE_EXPLORER_TX_URL?.trim();
  if (prefix) return (h) => `${prefix}${encodeURIComponent(h)}`;
  const rest = network(env).rest;
  return (h) => `${rest}/cosmos/tx/v1beta1/txs/${encodeURIComponent(h)}`;
}
