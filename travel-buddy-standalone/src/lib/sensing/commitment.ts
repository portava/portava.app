/**
 * commitment — the device's half of the anonymous contribution identity.
 *
 * ── THE SCHEME, AS THE SERVER DEFINES IT ─────────────────────────────────────
 * `artifacts/api-server/src/lib/sensingAnonStore.ts` derives a contributor
 * token from a ROTATION EPOCH and a COMMITMENT the device sends:
 *
 *   epochSecret = HMAC-SHA256(deviceSecret, "sensing-anon/epoch/v1|" + epoch)
 *   commitment  = SHA-256(lower(trim(epochSecret)))                 — sent
 *   token       = HMAC-SHA256(serverPepper, "…|" + epoch + "|" + commitment)
 *                                                                   — stored
 *
 * The device secret never leaves the device. The epoch secret never leaves
 * the device either, EXCEPT when the contributor withdraws: revealing one
 * epoch's secret lets the server verify `SHA-256(secret) == commitment`,
 * re-derive that epoch's token, and delete that epoch's rows — and nothing
 * else, because every other epoch's secret is a different HMAC output.
 *
 * So the commitment is: stable within an epoch (distinct contributors can be
 * counted once), unlinkable across epochs (no long-lived pseudonym), and not
 * derivable by anyone without the device secret. It is NOT an account id, a
 * device id or an installation id, and this module takes none of those.
 *
 * ── WHY THE HASHES ARE IMPLEMENTED HERE ──────────────────────────────────────
 * The app declares no crypto dependency that runs on Hermes (`expo-crypto` is
 * absent; `node:crypto` does not exist on a handset), and a native module for
 * two hashes is not worth a build. SHA-256 and HMAC are ~100 lines of
 * arithmetic with published test vectors; `commitment.test.ts` checks this
 * implementation against `node:crypto` on the exact strings the server uses,
 * so a divergence — which would make every contribution unrevocable — fails a
 * test rather than a withdrawal.
 */

const EPOCH_CONTEXT = 'sensing-anon/epoch/v1';

// ── SHA-256 (FIPS 180-4), byte-oriented, no dependencies ─────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Bytes(message: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = message.length * 8;
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  // 64-bit big-endian length; messages here are far below 2^32 bits.
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15]!, 7) ^ rotr(W[t - 15]!, 18) ^ (W[t - 15]! >>> 3);
      const s1 = rotr(W[t - 2]!, 17) ^ rotr(W[t - 2]!, 19) ^ (W[t - 2]! >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [H[0]!, H[1]!, H[2]!, H[3]!, H[4]!, H[5]!, H[6]!, H[7]!];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t]! + W[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]!, false);
  return out;
}

export function hmacSha256Bytes(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256Bytes(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = block[i]! ^ 0x36;
    opad[i] = block[i]! ^ 0x5c;
  }
  const inner = new Uint8Array(64 + message.length);
  inner.set(ipad); inner.set(message, 64);
  const innerHash = sha256Bytes(inner);
  const outer = new Uint8Array(64 + 32);
  outer.set(opad); outer.set(innerHash, 64);
  return sha256Bytes(outer);
}

export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function sha256Hex(message: string): string {
  return hex(sha256Bytes(utf8(message)));
}

export function hmacSha256Hex(key: string, message: string): string {
  return hex(hmacSha256Bytes(utf8(key), utf8(message)));
}

// ── The server's derivations, mirrored byte for byte ─────────────────────────

/** Mirrors the server's canon(): trim + lower-case. */
function canon(s: string): string {
  return s.trim().toLowerCase();
}

/** `deriveEpochSecret` in the server's sensingAnonStore. Never leaves the device except to revoke. */
export function deriveEpochSecret(deviceSecret: string, epoch: number): string {
  if (!deviceSecret) throw new Error('deriveEpochSecret: device secret is required');
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('deriveEpochSecret: epoch must be a non-negative integer');
  return hmacSha256Hex(deviceSecret, `${EPOCH_CONTEXT}|${epoch}`);
}

/** `revocationCommitment` in the server's sensingAnonStore. This is what is SENT. */
export function commitmentFor(epochSecret: string): string {
  if (!epochSecret) throw new Error('commitmentFor: epoch secret is required');
  return sha256Hex(canon(epochSecret));
}

/** One call for the transport: the commitment for THIS device in THIS epoch. */
export function deviceCommitment(deviceSecret: string, epoch: number): string {
  return commitmentFor(deriveEpochSecret(deviceSecret, epoch));
}

/**
 * A device secret from 32 random bytes, hex. The BYTES are the caller's — the
 * installer supplies a CSPRNG — because this module must not decide what
 * "random" means on a handset. Fewer than 32 bytes is refused: a short secret
 * is a guessable commitment, and a guessable commitment is a linkable one.
 */
export function deviceSecretFromBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length < 32) {
    throw new Error('deviceSecretFromBytes: at least 32 random bytes are required');
  }
  return hex(bytes.subarray(0, 32));
}
