/**
 * acousticPermission — §4.1's "optional coarse acoustic energy/rhythm ONLY
 * under separate explicit permission", and §3's "collect, retain, aggregate,
 * infer, personalize, surface and share are distinct permissions/policies".
 *
 * ── WHAT "SEPARATE" HAS TO MEAN HERE, AND WHY ────────────────────────────────
 * Portava ALREADY holds a microphone permission. `app.json` declares
 * `NSMicrophoneUsageDescription` ("voice and video calls … and for video
 * content attached to posts") and `android.permission.RECORD_AUDIO`, both for
 * LiveKit calls and expo-av video capture. Neither iOS nor Android offers a
 * second microphone permission to ask for: the OS grant is one switch, and once
 * a user has taken a video call the switch is already on.
 *
 * So if "separate" meant only "an OS microphone permission exists", this
 * requirement would already be satisfied by a permission the user granted to
 * talk to a friend — which is precisely the thing §3 forbids ("Social location
 * data never silently becomes anonymous crowd intelligence"). Separate
 * therefore means a SECOND, PURPOSE-SCOPED grant that:
 *
 *   • has its own identifier (`sensing.acoustic.energy`),
 *   • has its own storage key, so revoking it does not touch calls and
 *     granting calls does not touch it,
 *   • is default-DENIED and can only become granted through an explicit act,
 *   • is NOT satisfied by any call or video microphone grant, which this module
 *     enumerates by name and refuses, and
 *   • is required IN ADDITION to the OS microphone permission, never instead
 *     of it.
 *
 * `app.json` carries the matching declaration under
 * `expo.extra.sensingPermissions.acousticEnergy`, with its own usage string, so
 * the separateness is visible in configuration and not only in code.
 *
 * ── PURE ─────────────────────────────────────────────────────────────────────
 * Storage arrives as a `StorageLike`, following the app's `*Storage.ts`
 * convention (see src/lib/intel/promptPauseStorage.ts). No clock: callers pass
 * their instant.
 */

export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The purpose scope. Not a microphone permission — a permission to SENSE with one. */
export const ACOUSTIC_SENSING_SCOPE = 'sensing.acoustic.energy';

/** Its own key. Sharing a key with any call/media preference is the bug this avoids. */
export const ACOUSTIC_PERMISSION_STORAGE_KEY = 'sensing_acoustic_permission_v1';

/**
 * Grants that exist in this app for a microphone and DO NOT satisfy this one.
 * Named rather than implied so that a future reviewer adding a third microphone
 * use has to decide about it explicitly.
 */
export const MICROPHONE_GRANTS_THAT_DO_NOT_SATISFY = [
  'call.microphone',
  'livekit.microphone',
  'video.microphone',
  'expo-av.recording',
] as const;

export interface AcousticPermission {
  /** Always the acoustic scope. A stored record with any other scope is invalid. */
  scope: string;
  /** The explicit, purpose-scoped grant. Default false. */
  granted: boolean;
  grantedAt: string | null;
  revokedAt: string | null;
  /**
   * Whether the OS microphone permission is currently held. REQUIRED but never
   * SUFFICIENT — holding it because of a video call grants nothing here.
   */
  osMicrophoneGranted: boolean;
}

export const ACOUSTIC_PERMISSION_DENIED: AcousticPermission = Object.freeze({
  scope: ACOUSTIC_SENSING_SCOPE,
  granted: false,
  grantedAt: null,
  revokedAt: null,
  osMicrophoneGranted: false,
});

/**
 * May the coarse acoustic extractor run?
 *
 * Both halves, every time: the separate purpose-scoped grant AND the OS
 * microphone permission. A record carrying any other scope — including one of
 * the call/video microphone grants — is refused outright rather than coerced,
 * so a caller cannot satisfy this by handing over the permission it already had.
 */
export function acousticCaptureAllowed(
  permission: AcousticPermission | null | undefined,
): boolean {
  if (!permission) return false;
  if (permission.scope !== ACOUSTIC_SENSING_SCOPE) return false;
  if (permission.granted !== true) return false;
  if (permission.revokedAt !== null) return false;
  return permission.osMicrophoneGranted === true;
}

function sanitize(raw: unknown): AcousticPermission {
  if (typeof raw !== 'object' || raw === null) return { ...ACOUSTIC_PERMISSION_DENIED };
  const r = raw as Record<string, unknown>;
  // A record that is not this scope is not this permission. Fail closed.
  if (r.scope !== ACOUSTIC_SENSING_SCOPE) return { ...ACOUSTIC_PERMISSION_DENIED };
  return {
    scope: ACOUSTIC_SENSING_SCOPE,
    granted: r.granted === true,
    grantedAt: typeof r.grantedAt === 'string' ? r.grantedAt : null,
    revokedAt: typeof r.revokedAt === 'string' ? r.revokedAt : null,
    // Never persisted as true: the OS answer is asked for fresh every launch,
    // because the user can revoke it in Settings while the app is not running.
    osMicrophoneGranted: false,
  };
}

/** Read the stored grant. Any failure reads as DENIED. */
export async function loadAcousticPermission(storage: StorageLike): Promise<AcousticPermission> {
  try {
    const raw = await storage.getItem(ACOUSTIC_PERMISSION_STORAGE_KEY);
    if (!raw) return { ...ACOUSTIC_PERMISSION_DENIED };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...ACOUSTIC_PERMISSION_DENIED };
  }
}

/**
 * Record an explicit grant. `osMicrophoneGranted` is the CURRENT OS answer and
 * is deliberately not persisted — see `sanitize`. Granting with the OS
 * permission absent stores the intent but `acousticCaptureAllowed` stays false.
 */
export async function grantAcousticPermission(
  storage: StorageLike,
  nowMs: number,
  osMicrophoneGranted: boolean,
): Promise<AcousticPermission> {
  const next: AcousticPermission = {
    scope: ACOUSTIC_SENSING_SCOPE,
    granted: true,
    grantedAt: new Date(nowMs).toISOString(),
    revokedAt: null,
    osMicrophoneGranted,
  };
  try {
    await storage.setItem(ACOUSTIC_PERMISSION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Fire-and-forget, per the app's storage convention. An unpersisted grant
    // lapses at relaunch, which is the safe direction.
  }
  return next;
}

/** Withdraw the grant. Leaves every other microphone permission untouched. */
export async function revokeAcousticPermission(
  storage: StorageLike,
  nowMs: number,
): Promise<AcousticPermission> {
  const next: AcousticPermission = {
    scope: ACOUSTIC_SENSING_SCOPE,
    granted: false,
    grantedAt: null,
    revokedAt: new Date(nowMs).toISOString(),
    osMicrophoneGranted: false,
  };
  try {
    await storage.setItem(ACOUSTIC_PERMISSION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // As above.
  }
  return next;
}
