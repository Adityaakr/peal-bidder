/** Small helpers shared by the command-line tools. */
import { parseUnits } from "viem";

export type Flags = Record<string, string | boolean | undefined>;

/** `--name value`, `--name=value` and bare `--flag` (true). Positional words are returned in order. */
export function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { positional, flags };
}

export function str(flags: Flags, name: string, fallback?: string): string {
  const v = flags[name];
  if (typeof v === "string" && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

export function int(flags: Flags, name: string, fallback?: number): number {
  const v = flags[name];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new Error(`--${name} must be a whole number`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`--${name} is too large`);
  return n;
}

/** A token amount in whole units ("12.5") to base units, refusing more decimals than the token has. */
export function units(flags: Flags, name: string, decimals: number, fallback?: string): bigint {
  const v = str(flags, name, fallback);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(v)) throw new Error(`--${name} must be a plain decimal amount`);
  const frac = v.split(".")[1] ?? "";
  if (frac.length > decimals) throw new Error(`--${name} has more than ${decimals} decimals`);
  return parseUnits(v, decimals);
}

export function list(flags: Flags, name: string): string[] {
  return str(flags, name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Print one result as JSON (bigints as strings). Never pass a secret here. */
export function out(value: unknown): void {
  console.log(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

export async function main(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
