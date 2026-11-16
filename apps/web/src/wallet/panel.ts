/**
 * panel.ts - the wallet drawer: a guest account (the owner and agent that act),
 * QoreX (identity, and funding the guest), MetaMask (identity and network), and
 * the running log. Adapted from Peal Tender's drawer.
 */
import { parseUnits } from "viem";
import { DASHBOARD_FAUCET, FUSD_DECIMALS, QOREX_HELP } from "../config.ts";
import { amount, chip, h, hash, icon } from "../ui.ts";
import * as guest from "./guest.ts";
import * as metamask from "./metamask.ts";
import * as qorex from "./qorex.ts";
import { act, emit, log, refreshGuest, setOpenPanel, state, subscribe } from "./store.ts";

let root: HTMLElement | undefined;
let open = false;
let showPhrase = false;
let lastFocus: Element | null = null;

export function mountPanel(): void {
  root = h("aside.wallet", { "aria-label": "Wallet", "aria-hidden": "true", role: "dialog", "aria-modal": "true", tabindex: "-1" });
  const scrim = h("div.wallet-scrim");
  scrim.addEventListener("click", () => setOpen(false));
  document.body.append(scrim, root);
  setOpenPanel(() => setOpen(true));
  subscribe(draw);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });
  draw();
}

export function setOpen(v: boolean): void {
  if (v === open) return draw();
  open = v;
  document.body.classList.toggle("wallet-open", v);
  root?.setAttribute("aria-hidden", v ? "false" : "true");
  if (v) {
    lastFocus = document.activeElement;
    draw();
    root?.focus();
    void refreshGuest();
  } else {
    draw();
    (lastFocus as HTMLElement | null)?.focus?.();
  }
}

/** The header button: "Connect" or the guest's short address. */
export function walletButton(): HTMLElement {
  const g = state.owner;
  const b = h(
    "button.btn.btn-small.wallet-btn",
    { type: "button", "aria-haspopup": "dialog" },
    icon("key"),
    g ? `${g.evm.slice(0, 6)}…${g.evm.slice(-4)}` : state.qorex ? "QoreX connected" : "Connect",
  );
  b.addEventListener("click", () => setOpen(true));
  return b;
}

function section(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h("section.wallet-section", h("h3", title), ...children);
}

function fail(e: unknown): void {
  state.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
  emit();
}

function guestSection(): HTMLElement {
  const g = state.owner;
  if (!state.guest) {
    const ta = h("textarea.input", { rows: 3, placeholder: "24-word recovery phrase", "aria-label": "recovery phrase" }) as HTMLTextAreaElement;
    const create = h("button.btn.btn-primary", { type: "button", "data-test": "create-guest" }, "Create a guest account");
    create.addEventListener("click", async () => {
      create.setAttribute("disabled", "");
      state.error = undefined;
      try {
        await guest.create();
        await refreshGuest();
      } catch (e) {
        fail(e);
      }
    });
    const imp = h("button.btn.btn-small", { type: "button" }, "Import");
    imp.addEventListener("click", async () => {
      try {
        await guest.importMnemonic(ta.value);
        await refreshGuest();
      } catch (e) {
        fail(e);
      }
    });
    return section(
      "Guest account",
      h(
        "p.small.muted",
        "A fresh testnet owner made in this browser, with its own ML-DSA-87 key, and an agent that works for it. The owner signs mandates; the agent checks them and bids. Both come from one recovery phrase that stays in this browser.",
      ),
      create,
      h("details.small.import", h("summary", "I have a recovery phrase"), h("div.import-body", ta, imp)),
    );
  }

  const agent = state.guest.agent;
  const funded = g ? g.uqor >= 300_000n : false;
  const fundRow = h("div.wallet-actions");
  if (state.qorex && g) {
    const amt = h("input.input.input-small", { value: "2", "aria-label": "QOR to send", inputmode: "decimal" }) as HTMLInputElement;
    const b = h("button.btn.btn-small.btn-primary", { type: "button" }, "Send from QoreX");
    b.addEventListener("click", async () => {
      try {
        const uqor = parseUnits(amt.value.trim() || "0", 6);
        log(`Asking QoreX to send ${amt.value} QOR to your guest account…`);
        const { txHash, warning } = await qorex.sendQor(state.qorex!.cosmos, g.cosmos, uqor);
        log(`QoreX sent it (tx ${txHash.slice(0, 10)}…).`);
        if (warning) log(warning);
        setTimeout(() => void refreshGuest(), 4000);
      } catch (e) {
        fail(e);
      }
    });
    fundRow.append(amt, b);
  }
  fundRow.append(h("a.btn.btn-small", { href: DASHBOARD_FAUCET, target: "_blank", rel: "noopener" }, "QoreChain faucet ↗"));

  const register = h("button.btn.btn-small", { type: "button", disabled: !g || !funded || g.keyRegistered ? true : undefined }, "Register my ML-DSA-87 key");
  register.addEventListener("click", () => void act("Register your key", (l) => guest.registerKey(state.guest!.owner, l)));

  const phrase = h("div");
  if (showPhrase) {
    phrase.append(
      h("div.note.warn", "Anyone with this phrase controls this test owner and its agent. Keep it to restore them in another browser; never use it for real funds."),
      h("pre.code.phrase", guest.savedMnemonic() ?? ""),
    );
  }
  const toggle = h("button.btn.btn-small", { type: "button" }, showPhrase ? "Hide recovery phrase" : "Back up");
  toggle.addEventListener("click", () => {
    showPhrase = !showPhrase;
    draw();
  });
  const forget = h("button.btn.btn-small", { type: "button" }, "Forget");
  forget.addEventListener("click", () => {
    if (!confirm("Forget this guest account and its agent in this browser? Without the recovery phrase they cannot be restored.")) return;
    guest.forget();
    try {
      localStorage.removeItem("peal-bidder.guest-agent.v1");
    } catch {
      // nothing stored
    }
    showPhrase = false;
    void refreshGuest();
  });

  const pq = !g
    ? chip("Reading…", "plain")
    : g.keyRegistered
      ? g.keyIsOurs
        ? chip("On chain", "ok")
        : chip("Another key", "bad")
      : chip("Not registered yet", "wait");

  return section(
    "Guest account",
    h(
      "dl.kv",
      h("dt", "Owner"),
      h("dd", hash(state.guest.owner.cosmos, { label: "owner address" })),
      h("dt", "Owner EVM"),
      h("dd", hash(state.guest.owner.evm, { label: "owner EVM address" })),
      h("dt", "QOR"),
      h("dd", g ? `${amount(g.uqor, 6, 3)} QOR` : "…", " ", g && !funded ? chip("needs QOR", "warn") : null),
      h("dt", "fUSD"),
      h("dd", g ? `${amount(g.fusdBank + g.fusdErc20, FUSD_DECIMALS)} (${amount(g.fusdErc20, FUSD_DECIMALS)} as ERC-20)` : "…"),
      h("dt", "ML-DSA-87"),
      h("dd", pq),
      h("dt", "Agent"),
      h("dd", hash(agent.cosmos, { label: "agent address" })),
    ),
    h("div.wallet-step", "1. Fund the owner from the faucet: a little QOR for fees, and fUSD to bid with."),
    fundRow,
    h("div.wallet-step", "2. Register the owner's key, so your agent can check your mandates against the chain."),
    h("div.wallet-actions", register),
    h("div.wallet-actions.spaced", toggle, forget),
    phrase,
  );
}

function qorexSection(): HTMLElement {
  if (state.qorex) {
    return section(
      "QoreX",
      h("dl.kv", h("dt", "Native"), h("dd", hash(state.qorex.cosmos, { label: "QoreX address" })), state.qorex.evm ? h("dt", "EVM") : null, state.qorex.evm ? h("dd", hash(state.qorex.evm, { label: "QoreX EVM address" })) : null),
      h("p.small.muted", "QoreX funds your guest account with one transfer you approve in QoreX. It cannot send contract calls for pages yet, so the guest account does those."),
    );
  }
  const b = h("button.btn", { type: "button", disabled: qorex.available() ? undefined : true }, "Connect QoreX");
  b.addEventListener("click", async () => {
    try {
      state.qorex = await qorex.connect();
      emit();
    } catch (e) {
      fail(e);
    }
  });
  return section(
    "QoreX",
    h("p.small.muted", "QoreChain's own wallet. Connect it to fund your guest account straight from QoreX."),
    b,
    qorex.available() ? null : h("p.small.not-found", "Not found in this browser. ", h("a", { href: QOREX_HELP, target: "_blank", rel: "noopener" }, "Get QoreX")),
  );
}

function metamaskSection(): HTMLElement {
  if (state.metamask) {
    return section(
      state.metamask.wallet,
      h("dl.kv", h("dt", "Address"), h("dd", hash(state.metamask.address, { label: "MetaMask address" })), h("dt", "Network"), h("dd", state.metamask.onQoreChain ? chip("QoreChain testnet", "ok") : chip("Not switched", "warn"))),
      h("p.small.muted", "QoreChain accepts an EVM transaction only with a post-quantum key and a window, which MetaMask cannot make, so your guest owner and agent do the signing."),
    );
  }
  const name = metamask.available();
  const b = h("button.btn", { type: "button", disabled: name ? undefined : true }, `Connect ${name ?? "MetaMask"}`);
  b.addEventListener("click", async () => {
    try {
      state.metamask = await metamask.connect();
      emit();
    } catch (e) {
      fail(e);
    }
  });
  return section(
    "MetaMask",
    h("p.small.muted", "Connects and adds the QoreChain testnet network. It cannot sign for QoreChain by itself: there is no ML-DSA-87 key in it."),
    b,
    name ? null : h("p.small.not-found", "No browser wallet found."),
  );
}

function draw(): void {
  if (!root) return;
  const close = h("button.btn.btn-small", { type: "button", "aria-label": "Close the wallet" }, icon("cross"));
  close.addEventListener("click", () => setOpen(false));
  const logBox =
    state.busy || state.log.length || state.error
      ? h(
          "section.wallet-section",
          { "aria-live": "polite" },
          h("h3", state.busy ? `Working: ${state.busy}` : "Last action"),
          state.error ? h("div.note.bad", state.error) : null,
          h("ol.wallet-log", ...state.log.map((l) => h("li", l))),
        )
      : null;
  root.replaceChildren(
    h("div.wallet-head", h("div", h("strong", "Wallet"), h("div.small.muted", "Testnet only. The live agent's owner signs in the CLI, never here.")), close),
    logBox ?? "",
    guestSection(),
    qorexSection(),
    metamaskSection(),
  );
  document.querySelectorAll(".wallet-btn").forEach((b) => b.replaceWith(walletButton()));
}
