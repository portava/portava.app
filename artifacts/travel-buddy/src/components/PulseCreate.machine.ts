/**
 * Pure dismiss-wiring helpers for UnifiedPostComposer (PulseCreate.tsx).
 *
 * Extracted here so the dismiss contract can be tested with node:test without
 * a React Native renderer. The component imports `createComposerDismissHandlers`
 * instead of wiring `onClose` to each Pressable inline — the same pattern used
 * by ReportPostSheet.tsx / ReportPostSheet.state.ts.
 *
 * ## What is under test
 *
 * The layout fix that moved the backdrop to `StyleSheet.absoluteFillObject`
 * preserved the `onPress={onClose}` wiring. A dedicated module makes the
 * contract explicit and testable without RNTL:
 *
 *   backdrop Pressable  → handlers.onBackdropPress()    → onClose()
 *   X close button      → handlers.onCloseButtonPress() → onClose()
 *   Modal onRequestClose→ handlers.onRequestClose()     → onClose()
 *
 * Tests in PulseCreate.backdrop.test.ts import this module directly and assert
 * that each handler invokes `onClose`. Because the component also imports this
 * module, the tests verify the production code path, not a disconnected fixture.
 */

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
