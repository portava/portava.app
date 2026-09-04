/**
 * Client-side 45-minute prompt throttle (spec §6: "Maximum one unsolicited prompt
 * per active experience per 45 minutes").
 *
 * The server's prompt-eligibility endpoint (GET /v1/intel/prompt-eligibility) is
 * the authority — it derives the same throttle from the actor's recent
 * observations. This is the LOCAL mirror: it records when a prompt was last shown
 * for a subject on THIS device and suppresses another within the window, so the UI
 * never fires a second prompt while a slow/failed network round-trip is pending,
 * and it works offline. It is one input to useIntelPrompts, not the whole decision
 * (pause + Safe Return + flags still apply).
 *
 * RUNTIME EFFECT: NONE beyond AsyncStorage reads/writes.
 */
import type { StorageLike } from './promptPauseStorage.ts';

/** Spec §6 window — must match api-server lib/intelThrottle.PROMPT_THROTTLE_WINDOW_MS. */
export const PROMPT_THROTTLE_WINDOW_MS = 45 * 60_000;

export const PROMPT_THROTTLE_STORAGE_KEY = 'intel_prompt_throttle_v1';

/** subjectId → epoch-ms of the last prompt shown for it. */
export type PromptThrottleMap = Record<string, number>;

let _memoryCache: PromptThrottleMap = {};

export function cachedThrottle(): PromptThrottleMap {
  return { ..._memoryCache };
}

function sanitize(raw: unknown): PromptThrottleMap {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: PromptThrottleMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export async function loadPromptThrottle(storage: StorageLike): Promise<PromptThrottleMap> {
  try {
    const raw = await storage.getItem(PROMPT_THROTTLE_STORAGE_KEY);
    _memoryCache = raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    _memoryCache = {};
  }
  return cachedThrottle();
}

/**
 * True when a prompt for `subjectId` was shown within the 45-minute window and so
 * a new unsolicited prompt must be suppressed. Fail-open on a MISSING record (never
 * seen ⇒ not throttled); fail-CLOSED on a malformed/future timestamp (treat as
 * just-shown), so a corrupt entry silences rather than spams.
 */
export function isSubjectThrottled(
  throttle: PromptThrottleMap,
  subjectId: string,
  now: number = Date.now(),
): boolean {
  const last = throttle[subjectId];
  if (last === undefined) return false;
  if (!Number.isFinite(last)) return true;
  // A future timestamp (clock skew / tampering) is treated as within-window.
  if (last > now) return true;
  return now - last < PROMPT_THROTTLE_WINDOW_MS;
}

/**
 * Record that a prompt was shown for `subjectId` now. Prunes entries older than the
 * window so the map cannot grow without bound. Persists best-effort.
 */
export function recordPromptShown(
  storage: StorageLike,
  subjectId: string,
  now: number = Date.now(),
): PromptThrottleMap {
  const next: PromptThrottleMap = {};
  for (const [k, v] of Object.entries(_memoryCache)) {
    if (Number.isFinite(v) && now - v < PROMPT_THROTTLE_WINDOW_MS) next[k] = v;
  }
  next[subjectId] = now;
  _memoryCache = next;
  storage.setItem(PROMPT_THROTTLE_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  return cachedThrottle();
}
