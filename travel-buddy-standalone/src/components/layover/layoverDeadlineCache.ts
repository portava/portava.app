/**
 * §16 L150 — "Return deadline: persist latest certified value + snapshot
 * timestamp." The client half.
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────────
 * The server closed its half several passes ago: every offline bundle carries
 * `certifiedAt`, `staleAfter` and the `inputHash` of the computation behind it,
 * precisely so a client rendering it an hour later can SAY SO. Nothing on this
 * client ever wrote any of it down — there was no AsyncStorage write in the
 * layover surface at all — so a traveller who lost signal between the airport
 * and the city lost the one number §16 says must survive everything else going
 * dark.
 *
 * ── THIS MODULE STORES; IT DOES NOT DECIDE ───────────────────────────────────
 * Every field is the SERVER's, copied verbatim. `staleAfter` in particular is
 * stored exactly as received and is NEVER extended, renewed or recomputed at
 * write time. A cache that refreshed the bound as it wrote would turn an
 * hour-old deadline into a current one — which is the single failure this whole
 * requirement exists to prevent, and it is pinned from both sides of the
 * boundary in `__tests__/layoverDeadlineCache.component.test.tsx`.
 *
 * `cachedAt` is recorded for support and is NEVER a freshness input.
 * `bundleFreshness` compares device-now against the server's `staleAfter`;
 * measuring age from the WRITE would make the stale badge fire late on a bundle
 * that was already old when it was stored, which is the same mistake as
 * measuring it from when a screen mounted.
 *
 * ── EVERY FAILURE ANSWERS `null` / `false`, NOT A PARTIAL RECORD ─────────────
 * Unparseable bytes, an unknown version, another session's record, and a
 * storage layer that throws all answer `null` on read. A caller renders `null`
 * as "nothing is cached", which is true. A half-populated record would be a
 * return time with no provenance, which is the worst possible thing to put in
 * front of someone deciding whether to catch a train back.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CACHE ──────────────────────────────────────
 * Only the deadline and its certification instants. Not the plan, not the map,
 * not the envelope, not the airport intelligence. §16 gives each of those its
 * own row (L151-L155) and each is a separate decision about what may be shown
 * from a cache; bundling them behind this one would close those rows by
 * accident rather than by argument.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LayoverOfflineBundle, LayoverReturnState } from '../../services/layover.ts';

/**
 * Bumped whenever the stored SHAPE changes. A record written by a different
 * version is discarded rather than read field-by-field, because a field that
 * moved is indistinguishable from a field that is absent once it is JSON.
 */
export const CACHED_DEADLINE_VERSION = 1;

const KEY_PREFIX = 'layover.deadline.v1';

/** Per-session, because the deadline is per-layover. Exported for the suite. */
export function cachedDeadlineKey(sessionId: string): string {
  return `${KEY_PREFIX}:${sessionId}`;
}

export interface CachedCertifiedDeadline {
  sessionId: string;
  /** The server's own bundle-shape version, carried so support can read it. */
  bundleVersion: string;
  /** Instant the underlying feasibility record was certified for. */
  certifiedAt: string;
  /** After this instant the deadline MUST be labelled last-certified. */
  staleAfter: string;
  hardReturnTime: string;
  hardReturnLocal: string | null;
  returnState: LayoverReturnState;
  bufferMinutes: number;
  /** DEVICE instant of the write. For support only — never a freshness input. */
  cachedAt: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Persist the deadline from a freshly-read bundle.
 *
 * Returns whether anything was written, and `false` is a real answer with two
 * causes worth keeping apart from a throw:
 *
 *   NO BUNDLE / NO DEADLINE   an overview that arrived without one is not a new
 *                             answer about the deadline, so the existing record
 *                             is LEFT ALONE rather than cleared. Erasing it
 *                             would take the deadline away from a traveller on
 *                             the strength of a response that said nothing
 *                             about it.
 *   STORAGE REFUSED           a full or unavailable store. Reported, not thrown:
 *                             the caller is a render path and a rejected write
 *                             must not take the screen down with it.
 */
export async function cacheCertifiedDeadline(
  sessionId: string,
  bundle: LayoverOfflineBundle | null | undefined,
): Promise<boolean> {
  const deadline = bundle?.returnDeadline;
  if (!bundle || !deadline) return false;
  if (!isNonEmptyString(bundle.certifiedAt) || !isNonEmptyString(bundle.staleAfter)) return false;
  if (!isNonEmptyString(deadline.hardReturnTime)) return false;

  const record: CachedCertifiedDeadline & { v: number } = {
    v: CACHED_DEADLINE_VERSION,
    sessionId,
    bundleVersion: bundle.bundleVersion,
    // VERBATIM. See the header: the bound is the server's.
    certifiedAt: bundle.certifiedAt,
    staleAfter: bundle.staleAfter,
    hardReturnTime: deadline.hardReturnTime,
    hardReturnLocal: deadline.hardReturnLocal ?? null,
    returnState: deadline.returnState,
    bufferMinutes: deadline.bufferMinutes,
    cachedAt: new Date().toISOString(),
  };

  try {
    await AsyncStorage.setItem(cachedDeadlineKey(sessionId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * The last certified deadline this device wrote down for this session.
 *
 * `null` means NOTHING IS CACHED, and a caller must render it as that rather
 * than as a deadline it could not find — the two look identical on screen if
 * the caller invents a placeholder, and only one of them is true.
 */
export async function readCachedDeadline(
  sessionId: string,
): Promise<CachedCertifiedDeadline | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(cachedDeadlineKey(sessionId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;

  // A shape this build does not understand is discarded whole.
  if (rec.v !== CACHED_DEADLINE_VERSION) return null;
  // One layover's return time shown on another is worse than showing none.
  if (rec.sessionId !== sessionId) return null;

  if (
    !isNonEmptyString(rec.certifiedAt) ||
    !isNonEmptyString(rec.staleAfter) ||
    !isNonEmptyString(rec.hardReturnTime) ||
    !isNonEmptyString(rec.returnState)
  ) {
    return null;
  }

  return {
    sessionId,
    bundleVersion: typeof rec.bundleVersion === 'string' ? rec.bundleVersion : '',
    certifiedAt: rec.certifiedAt,
    staleAfter: rec.staleAfter,
    hardReturnTime: rec.hardReturnTime,
    hardReturnLocal: typeof rec.hardReturnLocal === 'string' ? rec.hardReturnLocal : null,
    returnState: rec.returnState as LayoverReturnState,
    bufferMinutes: typeof rec.bufferMinutes === 'number' ? rec.bufferMinutes : 0,
    cachedAt: isNonEmptyString(rec.cachedAt) ? rec.cachedAt : rec.certifiedAt,
  };
}

/**
 * The cached record in the shape `describeDeadline` and `localReplan` read.
 *
 * It exists so that a cached deadline goes through the SAME staleness rule as a
 * live one rather than getting a second, gentler one written for the offline
 * path. That second rule is exactly how a cache ends up presenting an old
 * answer as a current one.
 */
export function cachedDeadlineAsBundle(
  rec: CachedCertifiedDeadline,
): Pick<LayoverOfflineBundle, 'certifiedAt' | 'staleAfter' | 'returnDeadline'> {
  return {
    certifiedAt: rec.certifiedAt,
    staleAfter: rec.staleAfter,
    returnDeadline: {
      hardReturnTime: rec.hardReturnTime,
      hardReturnLocal: rec.hardReturnLocal,
      returnState: rec.returnState,
      bufferMinutes: rec.bufferMinutes,
      returnReminderAt: null,
    },
  };
}
