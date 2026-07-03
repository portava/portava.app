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

// ── Submit lock ───────────────────────────────────────────────────────────────

/**
 * A mutual-exclusion lock for the handleSubmit() async flow.
 *
 * The `submitting` flag from usePostActions is only set to true inside
 * create() — which runs AFTER uploadMedia(). This means a rapid double-tap
 * can re-enter handleSubmit() while the upload is in flight, with `submitting`
 * still false. Both concurrent invocations would then reach handleUploadResult
 * and, on an unauthenticated failure, each call onClose() — corrupting
 * navigation state.
 *
 * createSubmitLock() returns a lock object whose acquire() method returns true
 * exactly once (atomically in the JS single-threaded sense) and returns false
 * on all subsequent calls until release() is called. The component stores the
 * lock in a useRef so the same lock instance is shared across concurrent
 * handleSubmit() invocations.
 *
 * Usage in PulseCreate.tsx:
 *   const submitLock = useRef(createSubmitLock());
 *
 *   async function handleSubmit() {
 *     if (!selectedType || submitting) return;
 *     if (!submitLock.current.acquire()) return;   // ← concurrent re-entry guard
 *     try {
 *       // ... uploadMedia + handleUploadResult + create + handleSubmitResult
 *     } finally {
 *       submitLock.current.release();
 *     }
 *   }
 *
 * The lock is pure and stateless at the module level — each call to
 * createSubmitLock() returns an independent lock object. This makes it
 * testable with node:test without any React Native imports or mocking.
 */
export interface SubmitLock {
  /** Returns true and acquires the lock if it was free; returns false if already held. */
  acquire: () => boolean;
  /** Releases the lock so the next acquire() call succeeds. */
  release: () => void;
}

export function createSubmitLock(): SubmitLock {
  let locked = false;
  return {
    acquire: () => {
      if (locked) return false;
      locked = true;
      return true;
    },
    release: () => {
      locked = false;
    },
  };
}

// ── Once-guard ────────────────────────────────────────────────────────────────

/**
 * Wraps a callback so it fires at most once.
 *
 * Defense-in-depth for the close path within a single submit invocation.
 * The primary guard against concurrent double-close is the submit lock
 * (createSubmitLock + useRef), which prevents re-entry at the handleSubmit
 * boundary. createOnceGuard is an additional safeguard passed as the `onClose`
 * handler to both handleUploadResult and handleSubmitResult, ensuring that even
 * if both paths somehow resolve in the same invocation, onClose fires exactly once.
 *
 * Usage in PulseCreate.tsx (one guard per handleSubmit call, created after
 * the lock is acquired):
 *   const closeOnce = createOnceGuard(onClose);
 *   // pass closeOnce as onClose to handleUploadResult and handleSubmitResult
 */
export function createOnceGuard(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

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

export interface FilteredMedia {
  uri: string;
  [key: string]: unknown;
}

export type FilterApplyOutcome =
  | { ok: true; filteredMedia: FilteredMedia; filterId: string; filterIntensity: number }
  | { ok: false; message?: string };

export interface FilterApplyResultHandlers {
  setMedia: (m: FilteredMedia) => void;
  setFilterId: (id: string) => void;
  setFilterIntensity: (n: number) => void;
  setFilterEditorPending: (m: null) => void;
  setFilterEditorOpen: (open: boolean) => void;
  setError: (msg: string) => void;
}

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
