/**
 * Phase 0 — LiveKit prerequisite check (task 1752).
 * Reports secret presence (never values), mints a short-TTL test token,
 * and validates connectivity via listRooms (read-only; no room created).
 */
import { RoomServiceClient } from 'livekit-server-sdk';
import { livekitEnvStatus, readLivekitEnv, mintCallToken, generateRoomName } from '../src/lib/calls/livekitService';

async function main() {
  const status = livekitEnvStatus();
  console.log('Secret presence:', JSON.stringify(status.report));
  if (!status.ok) {
    console.log('VERDICT: FAILED — missing secrets');
    process.exit(1);
  }
  const env = readLivekitEnv();
  // 1. Mint a short-lived token (local operation, proves key/secret usable for signing)
  // allowVideo:true path avoids the canPublishSources string literal (see audit
  // finding M1: 'microphone' string vs TrackSource enum in installed SDK).
  const token = await mintCallToken({
    env, roomName: generateRoomName(), userId: 'phase0-prereq-check', allowVideo: true,
  });
  console.log('Token minted: yes (length', token.length, ', JWT segments:', token.split('.').length, ')');
  try {
    await mintCallToken({ env, roomName: generateRoomName(), userId: 'phase0-prereq-check', allowVideo: false });
    console.log('Audio-only token mint: OK');
  } catch (e: any) {
    console.log('Audio-only token mint: FAILED —', String(e?.message ?? e), '(known foundation↔SDK mismatch M1)');
  }
  // 2. Connectivity: listRooms is read-only and creates nothing.
  const svc = new RoomServiceClient(env.url, env.apiKey, env.apiSecret);
  const rooms = await svc.listRooms();
  console.log('Connectivity: OK — listRooms returned', rooms.length, 'active room(s)');
  console.log('VERDICT: PASSED');
}

main().catch((e) => {
  console.error('Connectivity/auth failure:', String(e?.message ?? e));
  console.log('VERDICT: FAILED');
  process.exit(1);
});
