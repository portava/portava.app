/**
 * vendorCommon — what every Media vendor seam shares (census-media §37).
 *
 * Four §37/§38/§36/§9 capabilities cannot be built inside this tier, because
 * each needs a capability this server does not have and no lane may buy:
 *
 *   vision            MD63 · MD289 · MD293   mediaVisionProvider.ts
 *   moderation        MD269 · MD283          mediaModerationClassifier.ts
 *   transcoding       MD277                  mediaTranscoder.ts
 *   captions (ASR)    MD280                  mediaCaptionSource.ts
 *
 * Each seam has the same three parts, and this file holds what they share:
 *
 *   1. A TYPED ADAPTER INTERFACE. A vendor adapter implements it; nothing
 *      outside the seam knows which vendor is behind it.
 *   2. A REFUSING DEFAULT. Until an adapter is implemented AND named in its env
 *      variable, the seam answers `{ ok: false, reason: "not_configured" }` to
 *      every call. There is no mock that answers in production.
 *   3. WIRING AT THE POINT OF USE, FAIL-CLOSED. The caller treats every refusal,
 *      error, timeout and malformed answer the same way: as NO answer. A refusal
 *      never becomes a default "allow", "looks social" or "has renditions".
 *
 * `selectVendor` is the only way a seam picks its adapter. An env value that
 * names no IMPLEMENTED adapter — a typo, a vendor nobody wrote, an empty
 * string — selects the refusing default, and says so in `configuredButUnknown`
 * so a readiness check can report the typo rather than a silent refusal.
 */

/** Why a vendor call produced no usable answer. Every one of these is treated as "no answer". */
export type VendorRefusal =
  /** No adapter is configured: the refusing default answered. */
  | "not_configured"
  /** The configured adapter cannot do this (e.g. a frame-only classifier asked about a whole video). */
  | "unsupported"
  /** The adapter threw or returned an error. */
  | "error"
  /** The adapter did not answer within the seam's bound. */
  | "timeout"
  /** The adapter answered, and the answer failed the seam's own validation. */
  | "invalid_answer";

export type VendorAnswer<T> = { ok: true; value: T } | { ok: false; reason: VendorRefusal; detail?: string };

/** The bound on any single vendor call. The stages run after the upload has answered, but a hung vendor must not pin a promise forever. */
export const VENDOR_CALL_TIMEOUT_MS = 20_000;

export function refused<T = never>(reason: VendorRefusal, detail?: string): VendorAnswer<T> {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * Run one vendor call. NEVER throws: a throw becomes `error`, a slow call
 * becomes `timeout`, and an answer that is not a VendorAnswer becomes
 * `invalid_answer`. The timer is always cleared, so a fast call leaves nothing
 * running.
 */
export async function callVendor<T>(
  fn: () => Promise<VendorAnswer<T>>,
  timeoutMs: number = VENDOR_CALL_TIMEOUT_MS,
): Promise<VendorAnswer<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<VendorAnswer<T>>((resolve) => {
    timer = setTimeout(() => resolve(refused("timeout", `no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const answer = await Promise.race([
      Promise.resolve().then(fn),
      timeout,
    ]);
    if (!answer || typeof answer !== "object" || typeof (answer as { ok?: unknown }).ok !== "boolean") {
      return refused("invalid_answer", "the adapter did not return a VendorAnswer");
    }
    return answer;
  } catch (err) {
    return refused("error", err instanceof Error ? err.message : String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface VendorSelection<A> {
  adapter: A;
  /** The env value, trimmed; null when unset or blank. */
  configured: string | null;
  /** True when the env names something that is not an implemented adapter — the refusing default was selected anyway. */
  configuredButUnknown: boolean;
}

/**
 * Pick the adapter an env variable names from the IMPLEMENTED table, or the
 * refusing default. The table is empty in this tree for every seam: choosing a
 * vendor is the owner's decision, and writing its adapter follows it.
 */
export function selectVendor<A>(
  envValue: string | undefined,
  implemented: Readonly<Record<string, () => A>>,
  refusing: A,
): VendorSelection<A> {
  const configured = typeof envValue === "string" && envValue.trim().length > 0 ? envValue.trim() : null;
  if (configured === null) return { adapter: refusing, configured: null, configuredButUnknown: false };
  const make = Object.prototype.hasOwnProperty.call(implemented, configured) ? implemented[configured] : undefined;
  if (!make) return { adapter: refusing, configured, configuredButUnknown: true };
  return { adapter: make(), configured, configuredButUnknown: false };
}

/** Bounded confidence: a finite number in [0, 1], or null when the vendor sent anything else. */
export function boundedConfidence(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > 1) return null;
  return v;
}
