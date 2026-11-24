/**
 * The compiled vault, committed so that the owner's command line can deploy it
 * and anyone can compare it with what is on chain.
 *
 *   ( cd contracts && forge build ) && pnpm vault:artifact [--check]
 *
 * `--check` (CI) fails if `contracts/BidderVault.artifact.json` is not what the sources compile to.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, out, parseFlags } from "../common/cli.ts";

await main(async () => {
  const { flags } = parseFlags(process.argv.slice(2));
  const root = join(import.meta.dirname, "..", "contracts");
  const built = JSON.parse(readFileSync(join(root, "out", "BidderVault.sol", "BidderVault.json"), "utf8")) as {
    abi: unknown[];
    bytecode: { object: string };
    deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> };
  };
  const artifact = {
    contract: "BidderVault",
    source: "contracts/src/BidderVault.sol",
    compiler: "solc 0.8.28, cancun, via IR, optimizer 200 runs, no metadata",
    audited: false,
    abi: built.abi,
    bytecode: built.bytecode.object,
    deployedBytecode: built.deployedBytecode.object,
    immutables: Object.values(built.deployedBytecode.immutableReferences)
      .flat()
      .sort((a, b) => a.start - b.start),
  };
  const path = join(root, "BidderVault.artifact.json");
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  if (flags.check === true) {
    if (readFileSync(path, "utf8") !== text) throw new Error("contracts/BidderVault.artifact.json is not what the sources compile to: run pnpm vault:artifact");
    out({ ok: true, runtimeBytes: (artifact.deployedBytecode.length - 2) / 2 });
    return;
  }
  writeFileSync(path, text);
  out({ written: path, runtimeBytes: (artifact.deployedBytecode.length - 2) / 2 });
});
