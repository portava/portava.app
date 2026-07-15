/**
 * Pure dismiss-wiring, submit-result, and category-picker helpers for
 * UnifiedPostComposer (PulseCreate.tsx).
 *
 * Extracted here so all contracts can be tested with node:test without a
 * React Native renderer. The component imports from this module instead of
 * wiring logic inline — the same pattern used by
 * ReportPostSheet.tsx / ReportPostSheet.state.ts.
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
 * ## Category chip-picker contract (tested in PulseCreate.submit.test.ts)
 *
 *   type selected  → resolveDefaultCategory(typeId)   → selectedCategory (state)
 *   chip tapped    → handleCategoryChipPress(value)   → selectedCategory (state)
 *   handleSubmit() → resolveCreateCategory(selected)  → create({ category })
 *
 * Tests import these functions directly and exercise the production code path
 * that the component depends on. If either contract changes, the tests catch it.
 */
import type { PostCategory } from '../types/models.ts';

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
 *
 * The guard is intentionally stateless at the module level — each call to
 * createOnceGuard() returns a fresh closure. This makes it trivially testable
 * with node:test without any imports or mocking.
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
 *
 * ## Double-invocation responsibility
 *
 * This function is intentionally stateless — it has no internal guard against
 * being called more than once. If called twice with the unauthenticated error
 * kind, onClose() will fire twice, which can silently corrupt navigation state.
 *
 * The caller MUST pass a guarded onClose created via createOnceGuard(). In
 * PulseCreate.tsx this is done at the start of handleSubmit(), before
 * uploadMedia() is awaited, so the same guard covers both the upload and submit
 * phases:
 *
 *   const closeOnce = createOnceGuard(onClose);   // top of handleSubmit()
 *   // ...
 *   await handleUploadResult(up, { onClose: closeOnce, ... });
 *   // ...
 *   await handleSubmitResult(res, { onClose: closeOnce, ... });
 *
 * Note: the `submitting` flag from usePostActions is only set inside create()
 * (after the upload phase), so it does NOT protect the upload failure path.
 * createOnceGuard() is the actual runtime guard for this path.
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

// ── Category chip-picker — canonical data + helpers ───────────────────────────
//
// These are the *single source of truth* for the category system.
// PulseCreate.tsx imports TYPE_CATEGORY and CATEGORY_OPTIONS from here
// (not the reverse) so the machine tests always exercise the exact objects
// the component uses in production.

/**
 * Maps every post-type ID to the raw category string it auto-defaults to.
 *
 * Canonical source — imported by PulseCreate.tsx. Changing a value here
 * immediately changes both the component behavior and the test expectations.
 */
export const TYPE_CATEGORY: Record<string, string> = {
  post_update: 'tip',
  ask_question: 'question',
  share_moment: 'activity',
  share_postcard: 'activity',
  share_hidden_gem: 'activity',
  share_food_spot: 'food',
  share_highlight: 'highlight',
};

/**
 * Ordered list of categories rendered as chip-picker options in the composer.
 *
 * Canonical source — imported by PulseCreate.tsx. Note: 'highlight' is absent
 * because it is a TYPE_CATEGORY default for the dedicated-composer type
 * (share_highlight) where the chip picker is hidden.
 */
export const CATEGORY_OPTIONS: ReadonlyArray<{ readonly value: PostCategory; readonly label: string }> = [
  { value: 'food',      label: 'Food' },
  { value: 'beach',     label: 'Beach' },
  { value: 'nightlife', label: 'Nightlife' },
  { value: 'activity',  label: 'Activity' },
  { value: 'hotel',     label: 'Hotel' },
  { value: 'tip',       label: 'Tip' },
  { value: 'safety',    label: 'Safety' },
  { value: 'transport', label: 'Transport' },
  { value: 'airport',   label: 'Airport' },
  { value: 'visa',      label: 'Visa' },
  { value: 'question',  label: 'Question' },
];

/**
 * Returns the auto-default category when a post type is selected.
 *
 * Mirrors the useEffect in UnifiedPostComposer:
 *
 *   const defaultCat = TYPE_CATEGORY[selectedType];
 *   const asCat = CATEGORY_OPTIONS.find(o => o.value === defaultCat)?.value ?? null;
 *   setSelectedCategory(asCat);
 *
 * Returns `null` when the type's raw default is not in CATEGORY_OPTIONS
 * (e.g. share_highlight → 'highlight' → null because highlight is not a
 * picker chip and the picker is hidden for dedicated composers).
 */
export function resolveDefaultCategory(typeId: string): PostCategory | null {
  const raw = TYPE_CATEGORY[typeId];
  if (!raw) return null;
  return CATEGORY_OPTIONS.find(o => o.value === raw)?.value ?? null;
}

/**
 * Returns the new selectedCategory after the user taps a category chip.
 *
 * Mirrors the chip Pressable's onPress handler in UnifiedPostComposer:
 *   onPress={() => setSelectedCategory(handleCategoryChipPress(value))}
 *
 * Named as a machine function (rather than an inline `value => value`) so:
 *   1. Tests confirm the exact value that enters component state.
 *   2. Future validation logic (e.g. disabling chips while submitting) can be
 *      added here with test coverage rather than inline in JSX.
 */
export function handleCategoryChipPress(value: PostCategory): PostCategory {
  return value;
}

/**
 * Returns the `category` argument value for the `create()` call in
 * handleSubmit().
 *
 * Mirrors: `category: resolveCreateCategory(selectedCategory)` in PulseCreate.tsx.
 *
 * Returns `undefined` (field omitted from payload) when `selectedCategory` is
 * `null`, letting the server apply its own default.
 */
export function resolveCreateCategory(selectedCategory: PostCategory | null): PostCategory | undefined {
  return selectedCategory ?? undefined;
}

// ── Category-gate validation ───────────────────────────────────────────────────

export interface CategoryGateValidation {
  ok: boolean;
  error?: 'missing_category';
}

/**
 * Validates that a post with the given type has a category before submission.
 *
 * When a new post type ships without a TYPE_CATEGORY entry the chip picker is
 * hidden (gated on !!TYPE_CATEGORY[selectedType]) and selectedCategory stays
 * null. If submission were allowed in that state the post would be created
 * without a category, silently breaking the feed filter. This guard catches
 * that case and returns an error so handleSubmit() can surface feedback.
 *
 * Rules:
 *   - TYPE_CATEGORY[typeId] is present  → ok (picker was shown, category may
 *     have been auto-set or manually overridden; resolveCreateCategory handles
 *     the null→undefined conversion for the payload)
 *   - TYPE_CATEGORY[typeId] is absent   → selectedCategory MUST be non-null
 *     (caller provided a category through another means); if it is null the
 *     submission is blocked with error: 'missing_category'.
 *
 * Usage in PulseCreate.tsx (handleSubmit):
 *   const gate = validateCategoryGate(selectedType, selectedCategory);
 *   if (!gate.ok) { setError('Please select a category.'); return; }
 */
export function validateCategoryGate(
  typeId: string,
  selectedCategory: PostCategory | null,
): CategoryGateValidation {
  if (!TYPE_CATEGORY[typeId] && selectedCategory === null) {
    return { ok: false, error: 'missing_category' };
  }
  return { ok: true };
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
