const textEncoder = new TextEncoder();

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        throw new TypeError(`${path}: lone high surrogate is not valid canonical JSON.`);
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${path}: lone low surrogate is not valid canonical JSON.`);
    }
  }
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path}: canonical JSON rejects non-finite numbers.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalize(entry, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path}: canonical JSON accepts plain objects only.`);
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => {
      assertUnicodeScalarString(key, `${path} key`);
      const entry = object[key];
      if (entry === undefined) {
        throw new TypeError(`${path}.${key}: canonical JSON rejects undefined.`);
      }
      return `${JSON.stringify(key)}:${canonicalize(entry, `${path}.${key}`)}`;
    }).join(",")}}`;
  }
  throw new TypeError(`${path}: value is not representable as canonical JSON.`);
}

/**
 * RFC 8785 JSON Canonicalization Scheme-style serialization. Inputs must use
 * JSON-compatible plain values and valid Unicode scalar strings.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, "$");
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalizeJson(value));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const cryptoImplementation = globalThis.crypto;
  if (!cryptoImplementation?.subtle) {
    throw new Error("A Web Crypto SHA-256 implementation is required.");
  }
  const digest = await cryptoImplementation.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalSha256Hex(value: unknown): Promise<string> {
  return sha256Hex(canonicalJsonBytes(value));
}
