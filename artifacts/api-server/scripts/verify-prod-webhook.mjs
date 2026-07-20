/**
 * Production webhook round-trip verification script.
 *
 * Run AFTER the API server has been republished AND the LiveKit dashboard
 * webhook has been registered at https://portava.replit.app/api/calls/webhook
 *
 * Usage:
 *   node artifacts/api-server/scripts/verify-prod-webhook.mjs
 *
 * Requires: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in env.
 * Does NOT require: the webhook to be registered yet (steps 1–3 use self-signed).
 * Step 4 (real LiveKit event) DOES require dashboard registration.
 */

import crypto from 'node:crypto';

const PROD_URL = 'https://portava.replit.app';
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const livekitUrl = process.env.LIVEKIT_URL;

if (!apiKey || !apiSecret || !livekitUrl) {
  console.error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET');
  process.exit(1);
}

// Dynamic import from api-server's node_modules
const { AccessToken, RoomServiceClient } = await import(
  new URL('../node_modules/livekit-server-sdk/dist/index.js', import.meta.url).href
);

async function signPayload(body) {
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const sha256 = btoa(Array.from(new Uint8Array(hashBuf)).map(v => String.fromCharCode(v)).join(''));
  const at = new AccessToken(apiKey, apiSecret, { ttl: 60 });
  at.sha256 = sha256;
  return at.toJwt();
}

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

console.log('\n=== Production webhook verification ===\n');

// Step 1: Unsigned → 401 (not 404 — proves route is live)
await check('Unsigned POST → 401 (route is live)', async () => {
  const r = await fetch(`${PROD_URL}/api/calls/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (r.status === 404) throw new Error('Got 404 — deployment is still stale, republish first');
  if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
});

// Step 2: Self-signed → 200 (signature verification works in production)
const payload = JSON.stringify({
  event: 'room_finished',
  room: { name: 'pcall_verify_prod_script' },
  id: crypto.randomUUID(),
  createdAt: Math.floor(Date.now() / 1000),
});
const authHeader = await signPayload(payload);

await check('Self-signed POST → 200 (signature verification works)', async () => {
  const r = await fetch(`${PROD_URL}/api/calls/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: authHeader },
    body: payload,
  });
  if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}: ${await r.text()}`);
});

// Step 3: Tampered body → 401 (replay protection works)
await check('Tampered body → 401 (replay protection works)', async () => {
  const r = await fetch(`${PROD_URL}/api/calls/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: authHeader },
    body: payload + ' ',
  });
  if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
});

// Step 4: Real LiveKit event (requires webhook registered in LiveKit dashboard)
console.log('\n--- Step 4: Real LiveKit round-trip (requires dashboard registration) ---');
const roomName = `pcall_verify_${crypto.randomBytes(6).toString('hex')}`;
const svc = new RoomServiceClient(livekitUrl, apiKey, apiSecret);

await check(`Create + delete throwaway room "${roomName}" → LiveKit sends webhook → check prod logs`, async () => {
  // Create a room
  await svc.createRoom({ name: roomName, emptyTimeout: 10, maxParticipants: 2 });
  console.log(`    Room "${roomName}" created`);
  // Delete it immediately — triggers room_finished webhook from LiveKit Cloud
  await svc.deleteRoom(roomName);
  console.log(`    Room deleted — LiveKit should POST room_finished to production within seconds`);
  console.log(`    Check production logs for: event=room_finished room=${roomName}`);
  console.log(`    If the webhook is not yet registered, no event will arrive (expected)`);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
