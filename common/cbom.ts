/**
 * The Bidder's cryptographic inventory, read from the CycloneDX 1.6 CBOM that
 * QoreScan (`@qorechain/qorescan`) writes for the deployment the Bidder
 * depends on: the testnet, the three accounts, and the TLS endpoints the
 * agent, relayer and owner talk to (`pnpm cbom`).
 *
 * The summary answers the threat model's question "what is post-quantum here,
 * and what is not", from the scan rather than from memory, and the tests hold
 * the threat model to it.
 */

interface Property {
  name: string;
  value: string;
}

interface Component {
  type: string;
  "bom-ref"?: string;
  name: string;
  properties?: Property[];
  cryptoProperties?: {
    assetType?: string;
    algorithmProperties?: { nistQuantumSecurityLevel?: number };
  };
}

export interface Cbom {
  bomFormat: string;
  specVersion: string;
  metadata: { timestamp: string; properties?: Property[] };
  components: Component[];
}

export type Classification = "post-quantum" | "hybrid" | "quantum-vulnerable" | "symmetric" | "unknown";

export interface CbomSummary {
  scannedAt: string;
  chainId: string | null;
  protocolFeatures: string[];
  algorithms: { name: string; classification: Classification; nistLevel: number | null }[];
  tls: { endpoint: string; keyExchange: string | null; keyExchangeClass: Classification }[];
  certificateKeys: { algorithm: string; classification: Classification }[];
  accounts: { address: string; pqcKey: boolean; pqcKeyType: string | null; kemKey: boolean }[];
  validatorKeys: { algorithm: string; count: number } | null;
}

function props(c: { properties?: Property[] }): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of c.properties ?? []) m.set(p.name, [...(m.get(p.name) ?? []), p.value]);
  return m;
}

function one(m: Map<string, string[]>, k: string): string | null {
  return m.get(k)?.[0] ?? null;
}

function classification(v: string | null): Classification {
  return v === "post-quantum" || v === "hybrid" || v === "quantum-vulnerable" || v === "symmetric" ? v : "unknown";
}

export function summarizeCbom(cbom: Cbom): CbomSummary {
  if (cbom.bomFormat !== "CycloneDX") throw new Error("not a CycloneDX document");
  const meta = props(cbom.metadata);
  const algorithms = cbom.components
    .filter((c) => c.cryptoProperties?.assetType === "algorithm")
    .map((c) => ({
      name: c.name,
      classification: classification(one(props(c), "qorescan:classification")),
      nistLevel: c.cryptoProperties?.algorithmProperties?.nistQuantumSecurityLevel ?? null,
    }));
  const classOf = (name: string | null): Classification => algorithms.find((a) => a.name === name)?.classification ?? "unknown";

  const tls = cbom.components
    .filter((c) => c.cryptoProperties?.assetType === "protocol" && c.name.startsWith("TLS"))
    .map((c) => {
      const keyExchange = one(props(c), "qorescan:tls:key-exchange-group");
      return { endpoint: c.name.replace(/^TLS [0-9.]+ at /, ""), keyExchange, keyExchangeClass: classOf(keyExchange) };
    })
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint));

  const certificateKeys = [
    ...new Set(
      cbom.components
        .filter((c) => c.name.startsWith("Certificate public key ("))
        .map((c) => /\((.+)\)$/.exec(c.name)?.[1] ?? c.name),
    ),
  ]
    .sort()
    .map((algorithm) => ({ algorithm, classification: classOf(algorithm) }));

  const accounts = new Map<string, CbomSummary["accounts"][number]>();
  for (const c of cbom.components) {
    const m = /^Account (classical|PQC|KEM) public key (qor1[0-9a-z]+)$/.exec(c.name);
    if (!m) continue;
    const address = m[2] as string;
    const a = accounts.get(address) ?? { address, pqcKey: false, pqcKeyType: null, kemKey: false };
    if (m[1] === "PQC") {
      a.pqcKey = true;
      a.pqcKeyType = one(props(c), "qorescan:pqc:key-type");
    }
    if (m[1] === "KEM") a.kemKey = true;
    accounts.set(address, a);
  }

  const v = cbom.components.find((c) => c.name.startsWith("Active validator consensus public keys"));
  const validatorKeys = v ? { algorithm: /\((.+)\)$/.exec(v.name)?.[1] ?? "unknown", count: Number(one(props(v), "qorescan:count") ?? 0) } : null;

  return {
    scannedAt: cbom.metadata.timestamp,
    chainId: one(meta, "qorescan:chain:id"),
    protocolFeatures: meta.get("qorescan:chain:protocol-feature") ?? [],
    algorithms: algorithms.sort((a, b) => a.name.localeCompare(b.name)),
    tls,
    certificateKeys,
    accounts: [...accounts.values()].sort((a, b) => a.address.localeCompare(b.address)),
    validatorKeys,
  };
}

/** The summary as Markdown, for docs/cbom/README.md. */
export function renderCbomSummary(s: CbomSummary, roles: Record<string, string>): string {
  const lines = [
    "# Cryptographic inventory",
    "",
    `Written by \`pnpm cbom\` with QoreScan (\`@qorechain/qorescan\`) on ${s.scannedAt}; the full CycloneDX 1.6 CBOM is [peal-bidder.cdx.json](peal-bidder.cdx.json). QoreScan's output is an inventory aid, not a certification. What it means for the Bidder is in [THREAT_MODEL.md](../../THREAT_MODEL.md#cryptographic-inventory).`,
    "",
    `Chain: \`${s.chainId ?? "?"}\`. Protocol features reported: ${s.protocolFeatures.map((f) => `\`${f}\``).join(", ") || "none"}.`,
    "",
    "## The Bidder's accounts",
    "",
    "| Role | Address | ML-DSA-87 key | ML-KEM-1024 key |",
    "|---|---|---|---|",
    ...s.accounts.map((a) => `| ${roles[a.address] ?? "?"} | \`${a.address}\` | ${a.pqcKey ? `registered (${a.pqcKeyType ?? "?"})` : "none"} | ${a.kemKey ? "registered" : "—"} |`),
    "",
    "## The endpoints the agent, relayer and owner talk to",
    "",
    "| Endpoint | TLS key exchange | Class |",
    "|---|---|---|",
    ...s.tls.map((t) => `| \`${t.endpoint}\` | ${t.keyExchange ?? "?"} | ${t.keyExchangeClass} |`),
    "",
    `Certificate keys on those endpoints: ${s.certificateKeys.map((c) => `${c.algorithm} (${c.classification})`).join(", ") || "none"}.`,
    "",
    s.validatorKeys ? `Validator consensus keys: ${s.validatorKeys.count} × ${s.validatorKeys.algorithm}.` : "Validator consensus keys: not reported.",
    "",
    "## Algorithms found",
    "",
    "| Algorithm | Class | NIST PQ level |",
    "|---|---|---|",
    ...s.algorithms.map((a) => `| ${a.name} | ${a.classification} | ${a.nistLevel ?? "—"} |`),
    "",
  ];
  return lines.join("\n");
}
