/**
 * pnpm cbom: the Bidder's cryptographic inventory with QoreScan.
 *
 * Scans the testnet (protocol features, the PQC and KEM keys of the owner,
 * agent-account and relayer accounts, validator keys) and handshakes with the
 * three public endpoints the Bidder talks to, then writes the CycloneDX 1.6
 * CBOM to docs/cbom/peal-bidder.cdx.json and its summary to
 * docs/cbom/README.md. Read-only: QoreScan never reads a private key value,
 * and no account key is passed to it, only addresses.
 *
 * QoreScan's npm launcher downloads its release binary on first use and runs it
 * only if its SHA-256 matches the digest shipped in the package.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renderCbomSummary, summarizeCbom, type Cbom } from "../common/cbom.ts";

const BIDDER_ACCOUNTS: Record<string, string> = {
  qor14ndj6q3zp7hku9a4hkjnmhvsk3kegf46g002j5: "Owner",
  qor1k7at260yd632szpqt8fguukwuf3l52fpfz8lur: "Agent account",
  qor16tsewlj6jpt4v2esmrhuk7z2xems6e09z5rpzc: "Relayer",
};
const BIDDER_ENDPOINTS = ["evm-testnet.qore.host:443", "api-testnet.qore.host:443", "rpc-testnet.qore.host:443"];

const out = new URL("../docs/cbom/", import.meta.url);
mkdirSync(out, { recursive: true });
const cbomFile = new URL("peal-bidder.cdx.json", out).pathname;
execFileSync(
  "qorescan",
  [
    "scan",
    "--name",
    "peal-bidder",
    "--network",
    "testnet",
    ...Object.keys(BIDDER_ACCOUNTS).flatMap((a) => ["--address", a]),
    ...BIDDER_ENDPOINTS.flatMap((e) => ["--tls", e]),
    "--out",
    cbomFile,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
const summary = summarizeCbom(JSON.parse(readFileSync(cbomFile, "utf8")) as Cbom);
writeFileSync(new URL("README.md", out), renderCbomSummary(summary, BIDDER_ACCOUNTS));
console.log(
  JSON.stringify({
    cbom: "docs/cbom/peal-bidder.cdx.json",
    summary: "docs/cbom/README.md",
    accounts: summary.accounts.length,
    tls: summary.tls.map((t) => `${t.endpoint} ${t.keyExchange}`),
  }),
);
