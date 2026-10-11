/**
 * deviceRevocation — §30A.7 (census-telegraph T401): "Device revocation
 * terminates realtime sessions, invalidates location capabilities and proximity
 * identities, stops push, and rotates sensitive session credentials without
 * destroying canonical conversation history."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE DEFECT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `DELETE /me/crypto-devices/:id` deleted the `devices` row and nothing else.
 * The revoked phone kept its auth session (and so its refresh token: it could
 * keep calling the API indefinitely), kept its open Telegraph SSE stream, kept
 * receiving push, and — on this instance — kept its precise-location binding.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT REVOCATION NOW DOES, STEP BY STEP (each step idempotent)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   auth_session      The device's auth session (`devices.auth_session_id`,
 *                     recorded from the access token's `session_id` claim on
 *                     register / public-key heartbeat, migration 3743) is added
 *                     to the account's `app_metadata.revoked_device_sessions`
 *                     through the Supabase admin API. Every getUser site
 *                     (requireUser, optionalUserFromToken, getGatedUser,
 *                     requireUserFromToken) refuses a token whose `session_id`
 *                     is listed — durable, cross-instance, no extra query
 *                     (`auth.getUser` already returns app_metadata). The first
 *                     time a refused token arrives, `auth.admin.signOut(token,
 *                     "local")` ends that session in GoTrue as well, so its
 *                     refresh token stops working. When the CALLER is revoking
 *                     its own device, signOut runs immediately on its own token.
 *                     No device→session link (column absent, or the device has
 *                     not called in since the column existed) is reported as the
 *                     gap `auth_session_unlinked` — never as done.
 *   push_tokens       `notification_devices` rows linked to this device
 *                     (`crypto_device_id`, 3743) are deleted, the same tokens are
 *                     detached from the legacy `profiles.expo_push_token` /
 *                     `rent_buddy_profiles.expo_push_token` copies, and removed
 *                     from queued `push_retry_queue` rows. No linked row is the
 *                     gap `push_tokens_unlinked`: a token registered without the
 *                     device header cannot be told apart from another device's.
 *   precise_location  The process-local precise binding (lib/preciseLocationDevice
 *                     .ts) is cleared when it names this device. Durably, the
 *                     binding is honoured only for a device still present in
 *                     `devices`, so deleting the row coarsens every instance.
 *   realtime          The device's Telegraph SSE connections — matched by auth
 *                     session — are closed here and on every other instance.
 *                     Without a session link, EVERY connection of the account is
 *                     closed (the other devices reconnect on their own): closing
 *                     too much is the safe direction.
 *   registry_row      The `devices` row is deleted LAST, and only when the
 *                     auth_session step did not FAIL — the row carries the
 *                     session id a retry needs.
 *
 * Messages, threads and memberships are not touched by any step.
 *
 * Proximity identities: nothing in this tree issues a device-scoped proximity
 * identity (no table or module), so there is nothing to invalidate; stated as
 * the gap `proximity_identity_none_issued` only in the census, not per call.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { activeBinding, clearPreciseShare, verifyDeviceForUser } from "./preciseLocationDevice.js";
import { terminateScopedConnections, terminateUserConnections } from "./telegraphEvents.js";
import {
  REVOKED_SESSIONS_CAP,
  REVOKED_SESSIONS_METADATA_KEY,
  UUID_RE,
  revokedSessionIds,
  sessionIdFromAccessToken,
} from "./deviceSessionGate.js";

export {
  REVOKED_DEVICE_MESSAGE,
  REVOKED_SESSIONS_CAP,
  REVOKED_SESSIONS_METADATA_KEY,
  endRevokedSession,
  isRevokedDeviceSession,
  revokedSessionIds,
  sessionIdFromAccessToken,
} from "./deviceSessionGate.js";


// ── Revocation ────────────────────────────────────────────────────────────────

export type StepOutcome =
  | "done"
  | "done_all_connections"
  | "not_applicable"
  | "unlinked"
  | "kept_for_retry"
  | "failed";

export interface RevocationReport {
  readonly deviceId: string;
  /** Whether a `devices` row for this user and id existed when revocation began. */
  readonly deviceFound: boolean;
  readonly steps: {
    auth_session: StepOutcome;
    push_tokens: StepOutcome;
    precise_location: StepOutcome;
    realtime: StepOutcome;
    registry_row: StepOutcome;
  };
  /** Steps that FAILED (retry). */
  readonly failed: string[];
  /** Things revocation could not do because the link it needs does not exist. */
  readonly gaps: string[];
  /** True only when nothing failed and nothing was a gap. */
  readonly complete: boolean;
  /** Push tokens removed (count only — tokens are not echoed). */
  readonly pushTokensRemoved: number;
}

export interface RevokeDeviceInput {
  readonly userId: string;
  readonly deviceId: string;
  /** The caller's verified bearer token. */
  readonly callerToken: string | null;
  /** The device id the caller presented in x-portava-device-id, if any. */
  readonly callerDeviceId: string | null;
  readonly nowMs?: number;
}

/** The registry could not be read: nothing was changed. */
export class DeviceRegistryUnreadableError extends Error {
  constructor(detail: string) {
    super(`device registry unreadable — nothing revoked: ${detail}`);
    this.name = "DeviceRegistryUnreadableError";
  }
}

/** Postgres 42703 / PostgREST PGRST204: the column a link needs is not in this database yet. */
export function isMissingColumnError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  const code = String(e.code ?? "");
  const msg = String(e.message ?? "");
  return code === "42703" || code === "PGRST204" || /column .* does not exist|could not find the .* column/i.test(msg);
}

async function addRevokedSession(sc: SupabaseClient, userId: string, sid: string): Promise<boolean> {
  const admin = (sc as any).auth?.admin;
  if (!admin?.getUserById || !admin?.updateUserById) return false;
  const { data, error } = await admin.getUserById(userId);
  if (error || !data?.user) return false;
  const current = revokedSessionIds(data.user);
  if (current.includes(sid)) return true; // idempotent
  const next = [...current, sid].slice(-REVOKED_SESSIONS_CAP);
  const { error: writeErr } = await admin.updateUserById(userId, {
    app_metadata: { [REVOKED_SESSIONS_METADATA_KEY]: next },
  });
  return !writeErr;
}

/**
 * Revoke one of the caller's own devices. Never throws for a step failure —
 * each is reported; throws DeviceRegistryUnreadableError only when the device
 * row could not be read at all, in which case nothing was changed.
 */
export async function revokeDevice(sc: SupabaseClient, input: RevokeDeviceInput): Promise<RevocationReport> {
  const { userId, deviceId } = input;
  const nowMs = input.nowMs ?? Date.now();
  const callerSessionId = sessionIdFromAccessToken(input.callerToken);

  // ── read the row (and its session link, when the column exists) ────────────
  let linkColumn = true;
  let row: { id: string; auth_session_id?: string | null } | null = null;
  {
    const first = await sc.from("devices").select("id, auth_session_id").eq("id", deviceId).eq("user_id", userId).maybeSingle();
    if (first.error && isMissingColumnError(first.error)) {
      linkColumn = false;
      const second = await sc.from("devices").select("id").eq("id", deviceId).eq("user_id", userId).maybeSingle();
      if (second.error) throw new DeviceRegistryUnreadableError(String(second.error.message ?? second.error.code));
      row = (second.data as any) ?? null;
    } else if (first.error) {
      throw new DeviceRegistryUnreadableError(String(first.error.message ?? first.error.code));
    } else {
      row = (first.data as any) ?? null;
    }
  }
  const deviceFound = row !== null;
  const linkedSid = row && typeof row.auth_session_id === "string" && UUID_RE.test(row.auth_session_id)
    ? row.auth_session_id.toLowerCase()
    : null;
  const selfRevocation = deviceFound && (
    (callerSessionId !== null && linkedSid === callerSessionId) || input.callerDeviceId === deviceId
  );
  const sid = linkedSid ?? (selfRevocation ? callerSessionId : null);

  const failed: string[] = [];
  const gaps: string[] = [];

  // ── auth_session ──────────────────────────────────────────────────────────
  let authSession: StepOutcome;
  if (!deviceFound) {
    authSession = "not_applicable";
  } else if (selfRevocation && input.callerToken) {
    // The caller IS the device: end its own session in GoTrue now. If GoTrue
    // refuses, list the session so every later token of it is refused anyway.
    let ended = false;
    try {
      const r = await (sc as any).auth?.admin?.signOut?.(input.callerToken, "local");
      ended = !!r && !r.error;
    } catch { ended = false; }
    authSession = ended || (sid !== null && (await addRevokedSession(sc, userId, sid).catch(() => false)))
      ? "done"
      : "failed";
  } else if (sid) {
    authSession = (await addRevokedSession(sc, userId, sid).catch(() => false)) ? "done" : "failed";
  } else {
    authSession = "unlinked";
  }
  if (authSession === "failed") failed.push("auth_session");
  if (authSession === "unlinked") gaps.push(linkColumn ? "auth_session_unlinked" : "auth_session_link_column_absent");

  // ── push_tokens ───────────────────────────────────────────────────────────
  let pushTokens: StepOutcome = "done";
  let pushTokensRemoved = 0;
  {
    const del = await sc
      .from("notification_devices")
      .delete()
      .eq("user_id", userId)
      .eq("crypto_device_id", deviceId)
      .select("push_token");
    if (del.error && isMissingColumnError(del.error)) {
      pushTokens = "unlinked";
      gaps.push("push_tokens_link_column_absent");
    } else if (del.error) {
      pushTokens = "failed";
      failed.push("push_tokens");
    } else {
      const tokens = [...new Set(((del.data as any[]) ?? []).map((r) => r?.push_token).filter((t): t is string => typeof t === "string" && !!t))];
      pushTokensRemoved = tokens.length;
      if (tokens.length === 0) {
        pushTokens = "unlinked";
        gaps.push("push_tokens_unlinked");
      }
      for (const t of tokens) {
        const p = await sc.from("profiles").update({ expo_push_token: null }).eq("id", userId).eq("expo_push_token", t);
        const b = await sc.from("rent_buddy_profiles").update({ expo_push_token: null }).eq("user_id", userId).eq("expo_push_token", t);
        if (p.error || b.error) pushTokens = "failed";
      }
      if (tokens.length > 0) {
        const q = await sc.from("push_retry_queue").select("id, tokens").eq("user_id", userId).eq("status", "queued");
        if (q.error) {
          pushTokens = "failed";
        } else {
          for (const r of ((q.data as any[]) ?? [])) {
            const before: string[] = Array.isArray(r?.tokens) ? r.tokens : [];
            const after = before.filter((t) => !tokens.includes(t));
            if (after.length === before.length) continue;
            const u = await sc.from("push_retry_queue").update({ tokens: after }).eq("id", r.id).eq("user_id", userId);
            if (u.error) pushTokens = "failed";
          }
        }
      }
      if (pushTokens === "failed") failed.push("push_tokens");
    }
  }

  // ── precise_location ──────────────────────────────────────────────────────
  let preciseLocation: StepOutcome = "not_applicable";
  if (activeBinding(userId, nowMs)?.deviceId === deviceId) {
    clearPreciseShare(userId);
    preciseLocation = "done";
  }

  // ── realtime ──────────────────────────────────────────────────────────────
  let realtime: StepOutcome;
  if (sid) {
    terminateScopedConnections(userId, { sessionId: sid, deviceId });
    realtime = "done";
  } else {
    terminateUserConnections(userId);
    realtime = "done_all_connections";
  }

  // ── registry_row (last) ───────────────────────────────────────────────────
  let registryRow: StepOutcome;
  if (authSession === "failed") {
    registryRow = "kept_for_retry";
  } else {
    const { error } = await sc.from("devices").delete().eq("id", deviceId).eq("user_id", userId);
    registryRow = error ? "failed" : deviceFound ? "done" : "not_applicable";
    if (error) failed.push("registry_row");
  }

  return {
    deviceId,
    deviceFound,
    steps: {
      auth_session: authSession,
      push_tokens: pushTokens,
      precise_location: preciseLocation,
      realtime,
      registry_row: registryRow,
    },
    failed,
    gaps,
    complete: failed.length === 0 && gaps.length === 0,
    pushTokensRemoved,
  };
}

/**
 * Record the auth session a device is calling from (the device→session link
 * revocation needs). Tolerates a database without the 3743 column: the link is
 * then simply absent, and revocation reports `auth_session_link_column_absent`.
 */
export async function recordDeviceSession(
  sc: SupabaseClient,
  userId: string,
  deviceId: string,
  token: string | null,
): Promise<"recorded" | "no_session_claim" | "column_absent" | "failed"> {
  const sid = sessionIdFromAccessToken(token);
  if (!sid) return "no_session_claim";
  const { error } = await sc.from("devices").update({ auth_session_id: sid }).eq("id", deviceId).eq("user_id", userId);
  if (!error) return "recorded";
  return isMissingColumnError(error) ? "column_absent" : "failed";
}

/** The bearer token on a request, or null. */
export function bearerToken(authorization: unknown): string | null {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  const t = authorization.slice(7).trim();
  return t || null;
}

/**
 * Link a just-registered push token row to the crypto device that registered it
 * (`notification_devices.crypto_device_id`, 3743), so revoking that device can
 * drop exactly this token and no other device's. The presented id is resolved
 * against the caller's own `devices` rows first — an id that is not theirs is
 * never written. Never fails the registration; returns what happened.
 */
export async function linkPushTokenToDevice(
  sc: SupabaseClient,
  userId: string,
  notificationDeviceRowId: string | null | undefined,
  presentedCryptoDeviceId: string | null,
  log?: { warn?: (o: unknown, m: string) => void; debug?: (o: unknown, m: string) => void },
): Promise<"linked" | "no_device_presented" | "device_not_registered" | "column_absent" | "failed"> {
  if (!presentedCryptoDeviceId || !notificationDeviceRowId) return "no_device_presented";
  const state = await verifyDeviceForUser(sc, userId, presentedCryptoDeviceId);
  if (state !== "registered") return state === "unreadable" ? "failed" : "device_not_registered";
  const { error } = await sc
    .from("notification_devices")
    .update({ crypto_device_id: presentedCryptoDeviceId })
    .eq("id", notificationDeviceRowId)
    .eq("user_id", userId);
  if (!error) return "linked";
  if (isMissingColumnError(error)) {
    log?.debug?.({ userId }, "push: crypto_device_id column absent (3743 unapplied) — token not linked to its device");
    return "column_absent";
  }
  log?.warn?.({ err: error, userId }, "push: linking the token to its device failed — revoking that device will not drop it");
  return "failed";
}
