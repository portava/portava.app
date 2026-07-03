/**
 * Pure dismiss-wiring and submit-result helpers for UnifiedPostComposer (PulseCreate.tsx).
 *
 * Extracted here so both contracts can be tested with node:test without a
 * React Native renderer. The component imports `createComposerDismissHandlers`
 * and `handleSubmitResult` instead of wiring them inline — the same pattern
 * used by ReportPostSheet.tsx / ReportPostSheet.state.ts.
 *
 * ## Dismiss contract (tested in PulseCreate.backdrop.test.ts)
 *
 *   backdrop Pressable  → handlers.onBackdropPress()    → onClose()
 *   X close button      → handlers.onCloseButtonPress() → onClose()
 *   Modal onRequestClose→ handlers.onRequestClose()     → onClose()
 *
 * ## Submit-result contract (tested in PulseCreate.submit.test.ts)
 *
 *   create() resolves { ok: true }               → onSuccess?.() + onClose()
 *   create() resolves { ok: false, errorKind: 'unauthenticated' }
 *                                                → signOut() + navigate() + onClose()
 *   create() resolves { ok: false, errorKind: * } → setError(msg)  (onClose NOT called)
 *
 * Tests import these functions directly and exercise the production code path
 * that the component depends on. If either contract changes, the tests catch it.
 */

// ── Dismiss handlers ──────────────────────────────────────────────────────────

export interface ComposerDismissHandlers {
  /** Attached to the dark backdrop Pressable. */
  onBackdropPress: () => void;
  /** Attached to the X close-icon Pressable in the sheet header. */
  onCloseButtonPress: () => void;
  /** Passed to `<Modal onRequestClose={…}>` for the Android back button. */
  onRequestClose: () => void;
}

/**
 * Returns the three dismiss handlers for UnifiedPostComposer.
 *
 * All three paths ultimately call `onClose`. Wrapping them in a named factory
 * lets node:test verify the contract without mounting the component, and gives
 * `testID`-annotated Pressables a stable, meaningful event target.
 *
 * Usage in PulseCreate.tsx:
 *   const dismiss = createComposerDismissHandlers(onClose);
 *   <Modal onRequestClose={dismiss.onRequestClose}>
 *     <Pressable testID="post-composer-backdrop" onPress={dismiss.onBackdropPress} />
 *     <Pressable testID="post-composer-close-btn" onPress={dismiss.onCloseButtonPress} />
 *   </Modal>
 */
export function createComposerDismissHandlers(onClose: () => void): ComposerDismissHandlers {
  return {
    onBackdropPress: onClose,
    onCloseButtonPress: onClose,
    onRequestClose: onClose,
  };
}

// ── Submit-result machine ─────────────────────────────────────────────────────

/** Shape returned by the `create()` service call in handleSubmit(). */
export interface CreateResult {
  ok: boolean;
  errorKind?: string;
  message?: string;
}

/**
 * Side-effect handlers injected by the component so the result machine stays
 * pure and testable with node:test (no React Native imports required).
 */
export interface SubmitResultHandlers {
  /** Called before onClose() when the post was created successfully. */
  onSuccess?: () => void;
  /** Closes the composer sheet. Called on success AND on unauthenticated error. */
  onClose: () => void;
  /** Clears the session when the server returns unauthenticated. */
  signOut: () => Promise<void>;
  /** Redirects to sign-in after signOut(). */
  navigate: (path: string) => void;
  /** Surfaces an inline error message when create() fails (non-unauthenticated). */
  setError: (msg: string) => void;
}

/** Error-kind → user-facing message map, kept in sync with handleSubmit(). */
const SUBMIT_ERROR_MESSAGES: Record<string, string> = {
  network_unreachable: 'Network unavailable. Try again.',
  invalid_payload: 'Check your post and try again.',
  config_error: 'Posting unavailable right now.',
};

/**
 * Handles the result of a `create()` call and routes to the correct side effect.
 *
 * Three branches mirror the handleSubmit() logic in PulseCreate.tsx:
 *
 *   1. ok → onSuccess?.() then onClose()
 *   2. unauthenticated → signOut() + navigate('/sign-in') + onClose()
 *   3. other error → setError(message)  — composer stays open
 *
 * Usage in PulseCreate.tsx:
 *   const res = await create({ ... });
 *   await handleSubmitResult(res, { onSuccess, onClose, signOut, navigate: router.replace, setError });
 *
 * ## Double-invocation responsibility
 *
 * This function is intentionally stateless — it has no internal guard against
 * being called more than once. If called twice with ok: true, onClose() will
 * fire twice, which can silently corrupt navigation state.
 *
 * The caller is responsible for preventing this. PulseCreate.tsx guards against
 * double-submission at the top of handleSubmit():
 *
 *   if (!selectedType || submitting) return;
 *
 * The `submitting` flag from usePostActions() is set to true before create() is
 * awaited, so a second tap will always bail out before reaching handleSubmitResult.
 * Any future call site must apply the same caller-side guard.
 */
export async function handleSubmitResult(
  result: CreateResult,
  handlers: SubmitResultHandlers,
): Promise<void> {
  if (result.ok) {
    handlers.onSuccess?.();
    handlers.onClose();
    return;
  }

  if (result.errorKind === 'unauthenticated') {
    await handlers.signOut();
    handlers.navigate('/(auth)/sign-in');
    handlers.onClose();
    return;
  }

  const msg =
    SUBMIT_ERROR_MESSAGES[result.errorKind ?? ''] ??
    result.message ??
    'Could not post.';
  handlers.setError(msg);
}
