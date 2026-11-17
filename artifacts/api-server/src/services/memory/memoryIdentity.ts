import { createHash } from "node:crypto";

/** Stable IDs for existing Memory command and candidate identities. */
export function derivedUuid(namespace: string, name: string): string {
  const h = createHash("sha256").update(`${namespace}\u0000${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
