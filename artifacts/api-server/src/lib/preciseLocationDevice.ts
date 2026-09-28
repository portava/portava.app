/**
 * preciseLocationDevice — §17.8 (T235) and §30A.7 (T400): "active precise
 * location is DEVICE-SPECIFIC and must not automatically / silently transfer to
 * a newly authenticated device".
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS TO CLOSE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Every location store in this tree is keyed by `user_id` alone —
 * `user_location_state`, `location_sessions` (baseline:7109) and
 * `trip_crew_location_sessions` (baseline:10509) carry no device column — so a
 * precise position published by one phone is, to every read path, simply a fact
 * about the ACCOUNT. Sign in on a second device and the first device's precise
 * fix is served to it: the share transferred, silently, with no act by the
 * person and nothing on any screen saying so.
 *
 * The device registry that already exists (`routes/devices.ts`, table `devices`,
 * live in production with `id`, `user_id`, `device_fingerprint`) was never
 * consulted by a location path. This module is the path that consults it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE RULE, IN ONE SENTENCE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * A precise coordinate is served only to the device that PUBLISHED it, proven by
 * a device id the caller presents and the server resolves against that user's
 * own rows in `devices`. Everything else — no device presented, an unregistered
 * device, a different device, no active binding, an expired binding, a binding
 * whose state could not be read — degrades to the APPROXIMATE rung. It never
 * refuses outright and it never falls back to precise:
 *
 *   • not refusing matters, because a new phone still needs to know which city
 *     the account is in, and a hard refusal would have made the fix invisible
 *     rather than coarse. The requirement is that PRECISION not transfer, not
 *     that the account become locationless;
 *   • degrading rather than defaulting matters, because the degraded direction
 *     is the safe one and it is the direction an outage takes. A restart, a
 *     second server instance, a cleared registry: all of them coarsen.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THE BINDING IS PROCESS-LOCAL, AND WHAT THAT COSTS
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * There is no device column on any deployed location table, and inventing one
 * here would put the whole rule behind an unapplied migration — dark code
 * enforcing nothing. So the binding lives in this process, keyed by user, with a
 * TTL equal to the map's own freshness horizon (60 minutes): a precise share is
 * a short-lived thing by design, and a binding that outlived the fix it
 * describes would be the wrong kind of durable.
 *
 * STATED PLAINLY, because a reader must not have to discover it:
 *
 *   • after a deploy or restart, every precise share degrades to approximate
 *     until the owning device publishes its next fix (one location POST);
 *   • with more than one server instance, a fix published through instance A is
 *     approximate when read through instance B until B sees a POST of its own;
 *   • the binding is never a grant. It cannot make anything MORE precise than
 *     the other gates already allow — it is a second condition, ANDed.
 *
 * All three cost precision and none costs privacy, which is the correct
 * direction for a fallback to fail. A durable binding needs one `device_id`
 * column on `user_location_state`; until it exists this is the version of the
 * rule that runs in production instead of describing it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** How long a binding stays valid without a refresh. Matches map freshness. */
export const BINDING_TTL_MS = 60 * 60 * 1000;

/** The precision rungs this module decides between. */
export type ServedPrecision = "precise" | "approximate";

export const PRECISION_REASONS = [
  "bound_device",
  "no_device_presented",
  "device_not_registered",
  "device_registry_unreadable",
  "no_active_binding",
  "binding_expired",
  "device_mismatch",
] as const;
export type PrecisionReason = (typeof PRECISION_REASONS)[number];

export interface PreciseShareBinding {
  readonly userId: string;
  readonly deviceId: string;
  readonly boundAtMs: number;
}

/**
 * One binding per user — the most recent publishing device wins.
 *
 * A Map, not an object, so a lookup cannot answer for an inherited key: an
 * object-literal registry returns a truthy value for `constructor` and
 * `toString`, and a gate that answers for keys nobody stored is a gate that
 * cannot be shown to refuse anything.
 */
const bindings = new Map<string, PreciseShareBinding>();

/**
 * Record that `deviceId` is the device whose precise fixes may be served back.
 *
 * Called ONLY after the device id has been resolved against `devices` for this
 * user — see `verifyDeviceForUser`. An unverified id must never reach here, or
 * a caller could bind itself by asserting an id.
 */
export function bindPreciseShare(userId: string, deviceId: string, nowMs: number): void {
  if (!userId || !deviceId) return;
  bindings.set(userId, { userId, deviceId, boundAtMs: nowMs });
}

/** The live binding, or null when there is none or it has aged out. */
export function activeBinding(userId: string, nowMs: number): PreciseShareBinding | null {
  const b = bindings.get(userId);
  if (!b) return null;
  if (nowMs - b.boundAtMs > BINDING_TTL_MS) return null;
  return b;
}

/**
 * Drop the binding.
 *
 * The revocation half: sign-out, device revocation and "stop sharing" all end
 * with the account holding no bound device, which coarsens every subsequent read
 * including the one from the device that set it.
 */
export function clearPreciseShare(userId: string): void {
  bindings.delete(userId);
}

/** Test hook. Clears the whole registry. */
export function _resetPreciseShareBindings(): void {
  bindings.clear();
}

export interface PrecisionDecisionInput {
  /** The binding in force for this user, from `activeBinding`. */
  readonly binding: PreciseShareBinding | null;
  /** The device id the caller presented, or null when it presented none. */
  readonly presentedDeviceId: string | null;
  /** Outcome of resolving that id against `devices` for this user. */
  readonly deviceState: DeviceVerification;
}

/**
 * The decision. Pure, total, and precise in exactly one case.
 *
 * Written as "precise only if every condition holds" rather than "approximate
 * if any condition fails", because the two are not the same under a later edit:
 * the first shape makes a NEW condition default to coarse, the second makes a
 * new condition default to precise until someone remembers to add it.
 */
export function precisionForDevice(
  input: PrecisionDecisionInput,
): { precision: ServedPrecision; reason: PrecisionReason } {
  if (input.deviceState === "unreadable") {
    return { precision: "approximate", reason: "device_registry_unreadable" };
  }
  if (!input.presentedDeviceId) {
    return { precision: "approximate", reason: "no_device_presented" };
  }
  if (input.deviceState !== "registered") {
    return { precision: "approximate", reason: "device_not_registered" };
  }
  if (!input.binding) {
    return { precision: "approximate", reason: "no_active_binding" };
  }
  if (input.binding.deviceId !== input.presentedDeviceId) {
    // The case the requirement is about: a newly authenticated device asking
    // for the account's live precise position.
    return { precision: "approximate", reason: "device_mismatch" };
  }
  return { precision: "precise", reason: "bound_device" };
}

// ── The device registry, consulted ────────────────────────────────────────────

export type DeviceVerification = "registered" | "unknown" | "unreadable";

/** Header a client presents its registered device id in. */
export const DEVICE_ID_HEADER = "x-portava-device-id";

/** UUIDs only — `devices.id` is a uuid, and a non-uuid cannot be one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The presented device id, or null.
 *
 * Shape-checked here so a malformed header never reaches a query, and so
 * "present but nonsense" and "absent" land on the same coarse answer.
 */
export function presentedDeviceId(headers: Record<string, unknown>): string | null {
  const raw = headers[DEVICE_ID_HEADER] ?? headers[DEVICE_ID_HEADER.toUpperCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

/**
 * Does this device belong to this user?
 *
 * `unreadable` is a THIRD answer, not folded into `unknown`: supabase-js
 * RESOLVES a failed read as `{ data: null, error }`, so `!data` alone would read
 * an outage as "not your device" — which is the safe direction here, but the
 * reason matters. `precisionForDevice` treats the two identically (both
 * coarsen) and the caller can log which happened without guessing.
 */
export async function verifyDeviceForUser(
  db: SupabaseClient,
  userId: string,
  deviceId: string | null,
): Promise<DeviceVerification> {
  if (!deviceId) return "unknown";
  const { data, error } = await db
    .from("devices")
    .select("id")
    .eq("id", deviceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return "unreadable";
  return data ? "registered" : "unknown";
}
