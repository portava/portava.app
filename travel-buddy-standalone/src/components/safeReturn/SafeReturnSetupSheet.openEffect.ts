/**
 * SafeReturnSetupSheet — open-effect logic.
 *
 * Extracted from the component's `useEffect([visible])` so that the critical
 * branches can be covered by node:test without a React renderer:
 *
 * `runOpenEffect` (pure, no timeout):
 *   A) active session exists   → call onStarted(id) + onClose, leave modal hidden
 *   B) no active session       → signal that the modal should open (form path)
 *   C) getActiveSession throws → signal that the modal should open (fail-open)
 *
 * `startCheckedOpenEffect` (full effect with safety-net timeout):
 *   Wraps runOpenEffect with a configurable safety-net timeout so that the
 *   trigger button cannot get permanently stuck when the network stalls.
 *   Returns a handle with `cancel()` (cleanup) and `isLive()` (state query).
 *
 * Both exports are deliberately dependency-free (no React, no React Native, no
 * supabase) so they can be imported by node:test + tsx/esm with no shimming.
 *
 * Run tests with:
 *   node --import tsx/esm --test \
 *     src/components/__tests__/SafeReturnSetupSheet.openEffect.test.ts
 */

export interface ActiveSession {
  id: string;
}

export interface OpenEffectCallbacks {
  onStarted?: (sessionId: string) => void;
  onClose: () => void;
  getActiveSession: () => Promise<{ session: ActiveSession | null }>;
}

export interface OpenEffectResult {
  /** True when the form modal should become visible. False when an active
   *  session was found and the caller was redirected via onStarted + onClose. */
  modalShouldOpen: boolean;
}

/**
 * Core logic of SafeReturnSetupSheet's `useEffect` when `visible` flips to
 * `true`. Call this from the component instead of inlining the logic so that
 * the branches can be exercised directly in tests.
 *
 * Does NOT mutate React state — callers act on the returned `modalShouldOpen`
 * flag (and the side effects produced via `onStarted` / `onClose`).
 */
export async function runOpenEffect(opts: OpenEffectCallbacks): Promise<OpenEffectResult> {
  const { onStarted, onClose, getActiveSession } = opts;

  try {
    const { session } = await getActiveSession();

    if (session) {
      // Active session found — redirect instead of showing the form.
      onStarted?.(session.id);
      onClose();
      return { modalShouldOpen: false };
    }

    // No active session — let the form open.
    return { modalShouldOpen: true };
  } catch {
    // Network / server error — fail-open so the user can still attempt setup.
    return { modalShouldOpen: true };
  }
}

// ── startCheckedOpenEffect ─────────────────────────────────────────────────────

export interface CheckedOpenEffectCallbacks {
  /** Called with `true` when the check starts and `false` when it resolves. */
  onCheckingChange?: (checking: boolean) => void;
  onStarted?: (sessionId: string) => void;
  onClose: () => void;
  getActiveSession: () => Promise<{ session: ActiveSession | null }>;
  /**
   * Called when no active session was found and the form modal should become
   * visible. This is the point where the component should set `modalVisible`
   * and start loading contacts.
   */
  onModalShouldOpen?: () => void;
  /**
   * Called when the safety-net timeout fires and `onTimeout` is provided.
   * When this is set, `onClose` is NOT called by the timeout path — the
   * caller is responsible for showing brief feedback and then opening the
   * form (fail-open). `isLive()` stays `true` while the caller lingers so
   * it can be used as a cancellation guard in the follow-up timer.
   * If omitted, the original behaviour is preserved: the timeout calls
   * `onCheckingChange(false)` + `onClose()`.
   */
  onTimeout?: () => void;
}

export interface CheckedOpenEffectOptions {
  /**
   * Safety-net timeout in milliseconds. If `getActiveSession` doesn't resolve
   * before this fires, `onCheckingChange(false)` + `onClose()` are called so
   * the trigger button never appears permanently stuck. Defaults to 5 000 ms.
   */
  timeoutMs?: number;
}

export interface CheckedOpenEffectHandle {
  /**
   * Cancel the in-flight effect — call from the useEffect cleanup function
   * (i.e. when `visible` flips back to false or the component unmounts).
   * Clears the safety-net timer, prevents any pending callbacks from firing,
   * and calls `onCheckingChange(false)` to reset the caller's indicator.
   */
  cancel: () => void;
  /**
   * Returns whether the effect is still live (not yet cancelled or timed out).
   * Useful for callers that do async work after `onModalShouldOpen` fires and
   * need to guard subsequent state mutations.
   */
  isLive: () => boolean;
}

/**
 * Full open-effect runner: wraps `runOpenEffect` with a safety-net timeout so
 * the trigger button cannot get permanently stuck when the network stalls.
 *
 * Lifecycle:
 *   1. Immediately calls `onCheckingChange(true)`.
 *   2. Awaits `runOpenEffect` (which calls `getActiveSession`).
 *   3a. If `getActiveSession` resolves before `timeoutMs`:
 *       – Clears the timer.
 *       – Calls `onCheckingChange(false)`.
 *       – Calls `onModalShouldOpen()` when no active session was found.
 *   3b. If `timeoutMs` elapses first (stalled network):
 *       – Sets `live = false` so the in-flight promise cannot fire callbacks.
 *       – Calls `onCheckingChange(false)` + `onClose()`.
 *
 * @returns A handle with `cancel()` and `isLive()`. Pass `handle.cancel` as
 *   the useEffect cleanup function.
 */
export function startCheckedOpenEffect(
  callbacks: CheckedOpenEffectCallbacks,
  { timeoutMs = 5_000 }: CheckedOpenEffectOptions = {},
): CheckedOpenEffectHandle {
  const { onCheckingChange, onStarted, onClose, getActiveSession, onModalShouldOpen, onTimeout } = callbacks;
  let live = true;
  // Set to true when the safety-net timeout fires. Prevents the still-in-flight
  // promise from calling onCheckingChange(false) or onModalShouldOpen after the
  // timeout handler has already taken over (avoiding a double-open race).
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    if (!live) return;
    timedOut = true;
    if (onTimeout) {
      // Caller manages fail-open feedback; keep live = true so isLive() can
      // still be used as a cancellation guard in the caller's linger timer.
      onTimeout();
    } else {
      // Legacy fall-back: dismiss silently so the trigger button unsticks.
      live = false;
      onCheckingChange?.(false);
      onClose();
    }
  }, timeoutMs);

  (async () => {
    onCheckingChange?.(true);

    let modalShouldOpen = true;
    try {
      ({ modalShouldOpen } = await runOpenEffect({
        onStarted: (id) => { if (live && !timedOut) onStarted?.(id); },
        onClose: () => { if (live && !timedOut) onClose(); },
        getActiveSession,
      }));
    } catch {
      // runOpenEffect has its own try/catch; this guard prevents a permanently
      // stuck indicator in the unlikely event it throws anyway.
    } finally {
      clearTimeout(timeoutId);
      // Only reset the checking indicator if the timeout hasn't already taken
      // over — the caller's linger timer will call onCheckingChange(false).
      if (live && !timedOut) onCheckingChange?.(false);
    }

    if (!live || timedOut) return;
    if (modalShouldOpen) onModalShouldOpen?.();
  })();

  return {
    cancel: () => {
      live = false;
      clearTimeout(timeoutId);
      onCheckingChange?.(false);
    },
    isLive: () => live,
  };
}
