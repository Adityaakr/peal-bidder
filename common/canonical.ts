/**
 * Canonical JSON for signed documents.
 *
 * One value has exactly one encoding, so a signature over the bytes is a
 * signature over the value:
 * - object keys are ASCII and sorted (byte order), with no duplicates;
 * - no whitespace;
 * - numbers are safe integers only (amounts that can exceed 2^53 travel as
 *   decimal strings);
 * - strings use JSON.stringify escaping;
 * - `undefined`, floats, NaN, Infinity and non-plain objects are refused.
 *
 * A verifier parses the signed bytes and re-encodes them; if the result is not
 * byte-identical, the document is refused (this also catches duplicate keys,
 * which JSON.parse would silently collapse).
 */

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export class CanonicalJsonError extends Error {
  override name = "CanonicalJsonError";
}

const ASCII_KEY = /^[\x20-\x7e]+$/;

export function canonicalize(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${path}: only safe integers are allowed`);
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(`${path}: not a plain object`);
      const keys = Object.keys(value as object);
      for (const k of keys) {
        if (!ASCII_KEY.test(k)) throw new CanonicalJsonError(`${path}: key ${JSON.stringify(k)} is not printable ASCII`);
      }
      keys.sort();
      const parts = keys.map((k) => {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) throw new CanonicalJsonError(`${path}.${k}: undefined is not allowed`);
        return `${JSON.stringify(k)}:${encode(v, `${path}.${k}`)}`;
      });
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} is not allowed`);
  }
}

/** Parse `text` and require it to be in canonical form. */
export function parseCanonical(text: string): CanonicalValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CanonicalJsonError(`not JSON: ${(err as Error).message}`);
  }
  const again = canonicalize(parsed);
  if (again !== text) throw new CanonicalJsonError("not in canonical form");
  return parsed as CanonicalValue;
}
