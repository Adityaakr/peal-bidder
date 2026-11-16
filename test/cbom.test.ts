/**
 * The committed QoreScan CBOM (docs/cbom/, `pnpm cbom`) and what the threat
 * model says about it. If a rescan changes any of these facts, the threat
 * model's "Cryptographic inventory" section has to change with it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderCbomSummary, summarizeCbom, type Cbom } from "../common/cbom.ts";

const dir = new URL("../docs/cbom/", import.meta.url);
const cbom = JSON.parse(readFileSync(new URL("peal-bidder.cdx.json", dir), "utf8")) as Cbom;
const s = summarizeCbom(cbom);

const OWNER = "qor14ndj6q3zp7hku9a4hkjnmhvsk3kegf46g002j5";
const AGENT_ACCOUNT = "qor1k7at260yd632szpqt8fguukwuf3l52fpfz8lur";
const RELAYER = "qor16tsewlj6jpt4v2esmrhuk7z2xems6e09z5rpzc";

describe("the Bidder's cryptographic inventory (QoreScan CBOM)", () => {
  it("is a CycloneDX 1.6 CBOM of the testnet", () => {
    expect(cbom.bomFormat).toBe("CycloneDX");
    expect(cbom.specVersion).toBe("1.6");
    expect(s.chainId).toBe("qorechain-diana");
    expect(s.protocolFeatures).toEqual(expect.arrayContaining(["pqc-sign-bytes-v2", "pqc-kem-registry", "evm-pqc-window-targets", "pqc-possession-flag"]));
  });

  it("all three accounts hold a hybrid ML-DSA-87 key, and the agent account its ML-KEM-1024 key", () => {
    expect(s.accounts).toEqual([
      { address: OWNER, pqcKey: true, pqcKeyType: "hybrid", kemKey: false },
      { address: RELAYER, pqcKey: true, pqcKeyType: "hybrid", kemKey: false },
      { address: AGENT_ACCOUNT, pqcKey: true, pqcKeyType: "hybrid", kemKey: true },
    ]);
    const levels = Object.fromEntries(s.algorithms.map((a) => [a.name, [a.classification, a.nistLevel]]));
    expect(levels["ML-DSA-87"]).toEqual(["post-quantum", 5]);
    expect(levels["ML-KEM-1024"]).toEqual(["post-quantum", 5]);
  });

  it("the endpoints negotiate a hybrid ML-KEM key exchange, but authenticate with classical certificates", () => {
    expect(s.tls.map((t) => t.endpoint)).toEqual(["api-testnet.qore.host:443", "evm-testnet.qore.host:443", "rpc-testnet.qore.host:443"]);
    expect(s.tls.every((t) => t.keyExchange === "X25519MLKEM768" && t.keyExchangeClass === "hybrid")).toBe(true);
    expect(s.certificateKeys.length).toBeGreaterThan(0);
    expect(s.certificateKeys.every((c) => c.classification === "quantum-vulnerable")).toBe(true);
  });

  it("the validators' consensus keys are classical", () => {
    expect(s.validatorKeys?.algorithm).toBe("Ed25519");
    expect(s.algorithms.find((a) => a.name === "Ed25519")?.classification).toBe("quantum-vulnerable");
  });

  it("the committed summary is the one the CBOM renders to", () => {
    const roles = { [OWNER]: "Owner", [AGENT_ACCOUNT]: "Agent account", [RELAYER]: "Relayer" };
    expect(readFileSync(new URL("README.md", dir), "utf8")).toBe(renderCbomSummary(s, roles));
  });

  it("refuses something that is not a CycloneDX document", () => {
    expect(() => summarizeCbom({ ...cbom, bomFormat: "SPDX" })).toThrow(/CycloneDX/);
  });
});
