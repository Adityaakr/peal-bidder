import { describe, expect, it } from "vitest";
import { FUSD as KIT_FUSD, PQC_KEY_STATUS as KIT_KEY_STATUS, network as kitNetwork } from "qore-pq-kit";
import { FUSD, PQC_KEY_STATUS, TESTNET_CHAIN_ID, TESTNET_EVM_CHAIN_ID } from "../common/network.ts";

describe("qore-pq-kit (v0.1.0, by git tag)", () => {
  it("agrees with this repository on the network and its addresses", () => {
    const n = kitNetwork();
    expect(n.chainId).toBe(TESTNET_CHAIN_ID);
    expect(n.evmChainId).toBe(TESTNET_EVM_CHAIN_ID);
    expect(KIT_FUSD).toBe(FUSD);
    expect(KIT_KEY_STATUS).toBe(PQC_KEY_STATUS);
  });
});
