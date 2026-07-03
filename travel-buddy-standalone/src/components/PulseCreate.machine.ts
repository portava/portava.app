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

// ── Upload-result machine ──────────────────────────────────────────────────────

/** Shape returned by uploadMedia() in PulseCreate.tsx. */
export interface MediaUploadResult {
  ok: boolean;
  url: string | null;
  mediaType: string | null;
  errorKind?: string;
  message?: string;
}

/** Side-effect handlers injected so handleUploadResult stays testable. */
export interface UploadResultHandlers {
  /** Closes the composer sheet. Called only on unauthenticated upload failure. */
  onClose: () => void;
  /** Clears the session when the server returns unauthenticated. */
  signOut: () => Promise<void>;
  /** Redirects to sign-in after signOut(). */
  navigate: (path: string) => void;
  /** Surfaces an inline error message when upload fails (non-unauthenticated). */
  setError: (msg: string) => void;
}

/** Discriminated union returned by handleUploadResult. */
export type UploadOutcome =
  | { continue: false }
  | { continue: true; url: string; mediaType: string | null };

/**
 * Handles the result of an uploadMedia() call inside handleSubmit().
 *
 * Three branches mirror the inline block in PulseCreate.tsx:
 *
 *   1. ok && url present  → { continue: true, url, mediaType } — caller proceeds
 *   2. unauthenticated     → signOut() + navigate('/sign-in') + onClose()
 *                            → { continue: false }  — composer closes
 *   3. other failure       → setError(msg)
 *                            → { continue: false }  — composer stays open
 *
 * Usage in PulseCreate.tsx:
 *   const outcome = await handleUploadResult(up, { onClose, signOut, navigate, setError });
 *   if (!outcome.continue) return;
 *   mediaUrl = outcome.url;
 *   mediaType = outcome.mediaType ?? undefined;
 */
export async function handleUploadResult(
  result: MediaUploadResult,
  handlers: UploadResultHandlers,
): Promise<UploadOutcome> {
  if (result.ok && result.url) {
    return { continue: true, url: result.url, mediaType: result.mediaType };
  }

  if (result.errorKind === 'unauthenticated') {
    await handlers.signOut();
    handlers.navigate('/(auth)/sign-in');
    handlers.onClose();
    return { continue: false };
  }

  handlers.setError(result.message ?? 'Media upload failed.');
  return { continue: false };
}

// ── Filter-apply-result machine ───────────────────────────────────────────────

/**
 * Minimal shape of the processed media written back to composer state on a
 * successful filter apply. Defined here (not imported from MediaFilterEditor.tsx)
 * so machine.ts stays free of React Native module imports and is importable
 * in node:test without a renderer.
 */
export interface FilteredMedia {
  uri: string;
  [key: string]: unknown;
}

/**
 * Outcome of a filter-apply step passed to handleFilterApplyResult.
 *
 *   ok: true  — filter rendered / metadata recorded; caller supplies the merged
 *               media object + resolved filterId / intensity.
 *   ok: false — renderFilteredImage threw or the editor signalled an error.
 */
export type FilterApplyOutcome =
  | { ok: true; filteredMedia: FilteredMedia; filterId: string; filterIntensity: number }
  | { ok: false; message?: string };

/**
 * Side-effect handlers injected so handleFilterApplyResult stays testable.
 *
 * `onClose` is intentionally ABSENT. The composer must stay open when the
 * filter step fails — the type signature is the machine-layer enforcement of
 * that rule.
 */
export interface FilterApplyResultHandlers {
  /** Called with the merged media object (pending media + new URI) on success. */
  setMedia: (m: FilteredMedia) => void;
  setFilterId: (id: string) => void;
  setFilterIntensity: (n: number) => void;
  /** Called with null to clear the pending slot after a successful apply. */
  setFilterEditorPending: (m: null) => void;
  /** Always called — closes the filter editor modal regardless of outcome. */
  setFilterEditorOpen: (open: boolean) => void;
  /** Called ONLY on failure. Composer stays open; onClose is not available here. */
  setError: (msg: string) => void;
}

/**
 * Handles the result of a MediaFilterEditor onApply callback.
 *
 * ## Filter-apply contract (tested in PulseCreate.filter.test.ts)
 *
 *   ok: true  → setMedia + setFilterId + setFilterIntensity + clear pending
 *               + close editor → { continue: true }
 *   ok: false → setError (composer stays open) + close editor
 *               → { continue: false }
 *
 * Usage in PulseCreate.tsx:
 *   handleFilterApplyResult(
 *     { ok: true, filteredMedia: { ...pending, uri: applyResult.uri },
 *       filterId: applyResult.filterId, filterIntensity: applyResult.filterIntensity },
 *     { setMedia, setFilterId, setFilterIntensity,
 *       setFilterEditorPending: () => setFilterEditorPending(null),
 *       setFilterEditorOpen, setError },
 *   );
 */
export function handleFilterApplyResult(
  outcome: FilterApplyOutcome,
  handlers: FilterApplyResultHandlers,
): { continue: boolean } {
  handlers.setFilterEditorOpen(false);

  if (!outcome.ok) {
    handlers.setError(outcome.message ?? 'Filter could not be applied.');
    return { continue: false };
  }

  handlers.setMedia(outcome.filteredMedia);
  handlers.setFilterId(outcome.filterId);
  handlers.setFilterIntensity(outcome.filterIntensity);
  handlers.setFilterEditorPending(null);
  return { continue: true };
}
