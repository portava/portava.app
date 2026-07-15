/**
 * Pure in-flight guard for like / unlike toggle actions.
 *
 * Extracted from CommentsSheet so rapid double-taps on the heart icon cannot
 * dispatch two concurrent network requests. The guard uses a plain closure
 * boolean — not React state — so the lock is acquired synchronously before
 * any async work starts, closing the re-render race window that a useState
 * check leaves open.
 *
 * Usage:
 *   const guardRef = useRef(createLikeToggleGuard());
 *   // in handler:
 *   if (guardRef.current.isToggling()) return;
 *   await guardRef.current.tryToggle(async () => { ...network call... });
 */

export interface LikeToggleGuard {
  /**
   * Attempt to run `doToggle`.
   *
   * - Returns `'in_flight'` immediately if a previous call is still awaiting.
   * - Returns `'ok'`        when `doToggle` resolved successfully.
   * - Returns `'error'`     when `doToggle` threw (guard is reset so the user
   *                         can retry).
   */
  tryToggle(doToggle: () => Promise<void>): Promise<'in_flight' | 'ok' | 'error'>;

  /** True while a toggle call is awaiting resolution. */
  isToggling(): boolean;
}

/**
 * Create a new like-toggle guard. Each guard instance tracks its own
 * in-flight state — create one per interactive like button (via useRef).
 */
export function createLikeToggleGuard(): LikeToggleGuard {
  let toggling = false;

  return {
    async tryToggle(doToggle) {
      if (toggling) return 'in_flight';
      toggling = true;
      try {
        await doToggle();
        return 'ok';
      } catch {
        return 'error';
      } finally {
        toggling = false;
      }
    },

    isToggling() {
      return toggling;
    },
  };
}
