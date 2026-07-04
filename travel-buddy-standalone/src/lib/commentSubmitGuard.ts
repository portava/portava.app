/**
 * Pure submit-guard logic for comment / reply inputs.
 *
 * Extracted from CommentsSheet.handleSubmit so the in-flight duplicate
 * prevention can be unit-tested without React or React Native dependencies.
 *
 * Usage:
 *   const guard = createSubmitGuard();
 *   await guard.trySubmit(text, async (trimmed) => { ...network call... });
 */

export interface SubmitGuard {
  /**
   * Attempt to submit `text`.
   *
   * - Returns `'empty'`      if the text is blank after trimming (no-op).
   * - Returns `'in_flight'`  if a previous call is still awaiting (no-op).
   * - Returns `'ok'`         when `doSubmit` was called and has resolved.
   * - Returns `'error'`      when `doSubmit` threw an error (guard is reset).
   */
  trySubmit(
    text: string,
    doSubmit: (trimmed: string) => Promise<void>,
  ): Promise<'empty' | 'in_flight' | 'ok' | 'error'>;

  /** True while a submit call is awaiting resolution. */
  isSubmitting(): boolean;
}

/**
 * Create a new submit guard. Each guard instance tracks its own in-flight
 * state — create one per comment input.
 */
export function createSubmitGuard(): SubmitGuard {
  let submitting = false;

  return {
    async trySubmit(text, doSubmit) {
      const trimmed = text.trim();
      if (!trimmed) return 'empty';
      if (submitting) return 'in_flight';

      submitting = true;
      try {
        await doSubmit(trimmed);
        return 'ok';
      } catch {
        return 'error';
      } finally {
        submitting = false;
      }
    },

    isSubmitting() {
      return submitting;
    },
  };
}
