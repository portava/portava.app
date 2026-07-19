/**
 * calls/livekitService — the ONLY place Portava talks to LiveKit.
 *
 * - Mints short-TTL access tokens AFTER Portava authorization has passed
 *   (a LiveKit connection is never proof of Portava authorization — spec §11).
 * - Generates opaque room names (never predictable thread/event ids — §9).
 * - Terminates rooms server-side on end/block/moderation/cap (addendum B).
 * - Verifies webhook signatures with the official receiver — unsigned
 *   payloads are rejected.
 *
 * Requires: `livekit-server-sdk` in api-server dependencies and secrets
 * LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET.
 */
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';
import { CALL_CONFIG } from './callTypes';

export interface LivekitEnv {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** Presence check for Phase-0 prerequisite gate. Never logs values. */
export function livekitEnvStatus(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean; report: Record<'LIVEKIT_URL' | 'LIVEKIT_API_KEY' | 'LIVEKIT_API_SECRET', 'present' | 'missing'>;
} {
  const report = {
    LIVEKIT_URL: env.LIVEKIT_URL ? 'present' : 'missing',
    LIVEKIT_API_KEY: env.LIVEKIT_API_KEY ? 'present' : 'missing',
    LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET ? 'present' : 'missing',
  } as const;
  return { ok: Object.values(report).every((v) => v === 'present'), report };
}

export function readLivekitEnv(env: NodeJS.ProcessEnv = process.env): LivekitEnv {
  const { ok } = livekitEnvStatus(env);
  if (!ok) throw new Error('LiveKit environment incomplete — run livekitEnvStatus() for the report');
  return { url: env.LIVEKIT_URL!, apiKey: env.LIVEKIT_API_KEY!, apiSecret: env.LIVEKIT_API_SECRET! };
}

/** Opaque, unguessable room name — session-scoped, never thread/event derived. */
export function generateRoomName(): string {
  return `pcall_${randomBytes(18).toString('base64url')}`;
}

/**
 * Mint a participant token for an ALREADY-AUTHORIZED user.
 * Video permission is enforced at the token level too: a voice-only grant
 * cannot publish camera tracks even with a hacked client.
 */
export async function mintCallToken(opts: {
  env: LivekitEnv;
  roomName: string;
  userId: string;
  displayName?: string | null;
  allowVideo: boolean;
  /** Group rooms: listeners join subscribe-only until promoted. */
  canPublishAudio?: boolean;
}): Promise<string> {
  const at = new AccessToken(opts.env.apiKey, opts.env.apiSecret, {
    identity: opts.userId,
    name: opts.displayName ?? undefined,
    ttl: CALL_CONFIG.TOKEN_TTL_SECONDS,
  });
  at.addGrant({
    room: opts.roomName,
    roomJoin: true,
    canPublish: opts.canPublishAudio ?? true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: opts.allowVideo
      ? undefined // all sources
      : [TrackSource.MICROPHONE], // audio-only grant (SDK v2 requires the enum)
  });
  return await at.toJwt();
}

/** Server-side room termination — the DB session state is the source of truth. */
export function makeRoomAdmin(env: LivekitEnv): {
  roomExists(roomName: string): Promise<boolean>;
  endRoom(roomName: string): Promise<void>;
  removeParticipant(roomName: string, userId: string): Promise<void>;
  muteParticipantAudio(roomName: string, userId: string): Promise<void>;
} {
  const svc = new RoomServiceClient(env.url, env.apiKey, env.apiSecret);
  return {
    async roomExists(roomName: string) {
      // listRooms with a name filter — read-only probe for ghost healing.
      const rooms = await svc.listRooms([roomName]);
      return rooms.some((r: any) => r.name === roomName);
    },
    async endRoom(roomName) {
      try { await svc.deleteRoom(roomName); } catch (e: any) {
        // Room already gone = success for our purposes (idempotent teardown).
        if (!String(e?.message ?? e).toLowerCase().includes('not found')) throw e;
      }
    },
    async removeParticipant(roomName, userId) {
      try { await svc.removeParticipant(roomName, userId); } catch (e: any) {
        if (!String(e?.message ?? e).toLowerCase().includes('not found')) throw e;
      }
    },
    async muteParticipantAudio(roomName, userId) {
      // Mute all published audio tracks for the participant (host moderation).
      const parts = await svc.listParticipants(roomName).catch(() => []);
      const p = parts.find((x: any) => x.identity === userId);
      if (!p) return;
      for (const t of (p as any).tracks ?? []) {
        if (t.type === 0 /* AUDIO */ || t.source === 2 /* MICROPHONE */) {
          await svc.mutePublishedTrack(roomName, userId, t.sid, true).catch(() => {});
        }
      }
    },
  };
}

/**
 * Verified webhook decode. Throws on bad/missing signature — callers must
 * 401 and never process the payload (addendum B).
 * NOTE: verify event names against the installed livekit-server-sdk version;
 * the reconciler treats unknown events as no-ops so version drift is safe.
 */
export function makeWebhookVerifier(env: LivekitEnv): {
  receive(rawBody: string, authHeader: string | undefined): Promise<{ event: string; room?: { name?: string }; participant?: { identity?: string } }>;
} {
  const receiver = new WebhookReceiver(env.apiKey, env.apiSecret);
  return {
    async receive(rawBody, authHeader) {
      if (!authHeader) throw new Error('missing webhook auth header');
      return (await receiver.receive(rawBody, authHeader)) as any;
    },
  };
}
