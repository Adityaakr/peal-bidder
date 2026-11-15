import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addressFromPublicKey, deriveCanonicalPqKey, deriveClassicalKey, signMessage, verifyMessage } from "@qorechain/qoresign";
import { deriveUnifiedAccount, generateMnemonic } from "@qorechain/sdk";
import { hexToBytes, type Hex } from "viem";
import { accountAddress, createAccount, exportAgentAccount, loadAccount, loadAgentAccount, qoreSignKeys } from "../common/accounts.ts";
import { agentPaths, ownerPaths } from "../common/home.ts";
import { TESTNET_CHAIN_ID } from "../common/network.ts";
import { initAgentKeys, loadAgentIdentity, readAgentPublicInfo } from "../agent/identity.ts";

function home() {
  return mkdtempSync(join(tmpdir(), "peal-bidder-home-"));
}

describe("accounts", () => {
  it("the SDK and QoreSign derive the same account, classical key and ML-DSA-87 key", async () => {
    const mnemonic = generateMnemonic(256);
    const sdk = await deriveUnifiedAccount(mnemonic, 0);
    const ck = deriveClassicalKey({ mnemonic, type: "eth_secp256k1" });
    const addr = addressFromPublicKey(ck.publicKey, "eth_secp256k1");
    expect(addr.bech32).toBe(sdk.cosmos);
    expect(addr.hex.toLowerCase()).toBe(sdk.evm.toLowerCase());
    expect(deriveCanonicalPqKey({ mnemonic, address: sdk.cosmos }).publicKey).toEqual(sdk.pqc.publicKey);
    const k = qoreSignKeys(sdk);
    expect(k.classicalKey.privateKey).toEqual(ck.privateKey);
    const sig = signMessage({ chainId: TESTNET_CHAIN_ID, signer: sdk.cosmos, data: "x", classicalKey: k.classicalKey, pqKey: k.pqKey });
    expect(() => verifyMessage({ chainId: TESTNET_CHAIN_ID, signer: sdk.cosmos, data: "x", signature: sig, pqPublicKey: sdk.pqc.publicKey })).not.toThrow();
  });

  it("writes account files 0600, never overwrites them, and reloads the same account", async () => {
    const op = ownerPaths(home());
    const a = await createAccount(op.owner, "owner");
    expect(statSync(op.owner).mode & 0o777).toBe(0o600);
    await expect(createAccount(op.owner, "owner")).rejects.toThrow(/refusing to overwrite/);
    expect((await loadAccount(op.owner)).cosmos).toBe(a.cosmos);
    expect(accountAddress(op.owner)).toEqual(a);
  });

  it("refuses an account file other users can read", async () => {
    const op = ownerPaths(home());
    await createAccount(op.owner, "owner");
    chmodSync(op.owner, 0o644);
    await expect(loadAccount(op.owner)).rejects.toThrow(/mode 644/);
  });
});

describe("the key split", () => {
  it("gives the agent its classical key only; the mnemonic, and so the ML-DSA key, stays with the owner", async () => {
    const h = home();
    const op = ownerPaths(h);
    const ag = agentPaths(h);
    const owner = await createAccount(op.owner, "owner");
    const agentAcc = await createAccount(op.agentAccount, "agent account");
    await exportAgentAccount(op.agentAccount, ag.account, owner.cosmos);
    const text = readFileSync(ag.account, "utf8");
    expect(text).not.toMatch(/QORE_MNEMONIC/);
    const full = await loadAccount(op.agentAccount);
    const exported = loadAgentAccount(ag.account);
    expect(exported).toMatchObject({ cosmos: agentAcc.cosmos, evm: agentAcc.evm, owner: owner.cosmos });
    expect(exported.privateKey).toBe(full.privateKey);
    // Nothing in the agent's file is the ML-DSA secret key or derives it.
    expect(text).not.toContain(Buffer.from(full.pqc.secretKey.slice(0, 32)).toString("hex"));
    expect(statSync(ag.account).mode & 0o777).toBe(0o600);
  });

  it("refuses to run the agent from a file that holds a mnemonic", async () => {
    const h = home();
    const op = ownerPaths(h);
    await createAccount(op.agentAccount, "agent account");
    writeFileSync(join(h, "bad.env"), `${readFileSync(op.agentAccount, "utf8")}PRIVATE_KEY="0x01"\nOWNER="qor1x"\n`, { mode: 0o600 });
    expect(() => loadAgentAccount(join(h, "bad.env"))).toThrow(/holds a mnemonic/);
  });

  it("the agent makes its own seal and receipt keys and publishes only their public halves", async () => {
    const h = home();
    const op = ownerPaths(h);
    const ag = agentPaths(h);
    const owner = await createAccount(op.owner, "owner");
    await createAccount(op.agentAccount, "agent account");
    await exportAgentAccount(op.agentAccount, ag.account, owner.cosmos);
    const info = initAgentKeys(ag);
    expect(initAgentKeys(ag)).toEqual(info); // idempotent: the keys are made once
    const id = loadAgentIdentity(ag);
    const pub = readAgentPublicInfo(ag.publicInfo);
    expect(pub).toEqual(info);
    expect(hexToBytes(`0x${pub.mlkemPublicKey}` as Hex)).toEqual(id.sealKeys.mlkemPublicKey);
    const published = readFileSync(ag.publicInfo, "utf8");
    expect(published).not.toContain(Buffer.from(id.sealKeys.mlkemSecretKey.slice(0, 32)).toString("hex"));
    expect(published).not.toContain(Buffer.from(id.sealKeys.seed).toString("hex"));
    expect(statSync(ag.keys).mode & 0o777).toBe(0o600);
  });

  it("refuses a public.json whose receipt key hash does not match", async () => {
    const h = home();
    const op = ownerPaths(h);
    const ag = agentPaths(h);
    const owner = await createAccount(op.owner, "owner");
    await createAccount(op.agentAccount, "agent account");
    await exportAgentAccount(op.agentAccount, ag.account, owner.cosmos);
    const info = initAgentKeys(ag);
    writeFileSync(ag.publicInfo, JSON.stringify({ ...info, receiptKeyHash: "0".repeat(64) }));
    expect(() => readAgentPublicInfo(ag.publicInfo)).toThrow(/receiptKeyHash/);
  });
});
