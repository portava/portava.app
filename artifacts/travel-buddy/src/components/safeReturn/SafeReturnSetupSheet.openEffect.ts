/**
 * SafeReturnSetupSheet — open-effect logic.
 *
 * Extracted from the component's `useEffect([visible])` so that the three
 * critical branches can be covered by node:test without a React renderer:
 *
 *   A) active session exists   → call onStarted(id) + onClose, leave modal hidden
 *   B) no active session       → signal that the modal should open (form path)
 *   C) getActiveSession throws → signal that the modal should open (fail-open)
 *
 * The function is deliberately dependency-free (no React, no React Native, no
 * supabase) so it can be imported by node:test + tsx/esm with no shimming.
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
