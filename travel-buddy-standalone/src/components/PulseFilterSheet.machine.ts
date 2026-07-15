/**
 * Pure dismiss-wiring helper for PulseFilterSheet (PulseCreate.tsx).
 *
 * Extracted here so the dismiss contract can be tested with node:test without
 * a React Native renderer — the same pattern used by PulseCreate.machine.ts
 * for UnifiedPostComposer.
 *
 * ## Dismiss contract (tested in PulseFilterSheet.backdrop.test.ts)
 *
 *   backdrop Pressable    → handlers.onBackdropPress()    → onClose()
 *   X close button        → handlers.onCloseButtonPress() → onClose()
 *   Modal onRequestClose  → handlers.onRequestClose()     → onClose()
 *   "Show results" button → handlers.onApplyPress()       → onClose()
 *
 * Tests import this function directly and exercise the production code path
 * that the component depends on. If the contract changes, the tests catch it.
 *
 * Usage in PulseCreate.tsx:
 *   const dismiss = createFilterDismissHandlers(onClose);
 *   <Modal onRequestClose={dismiss.onRequestClose}>
 *     <Pressable testID="filter-sheet-backdrop" onPress={dismiss.onBackdropPress} />
 *     <Pressable testID="filter-sheet-close-btn" onPress={dismiss.onCloseButtonPress} />
 *     <Pressable testID="filter-sheet-apply" onPress={dismiss.onApplyPress} />
 *   </Modal>
 */

export interface FilterDismissHandlers {
  /** Attached to the dark backdrop Pressable. */
  onBackdropPress: () => void;
  /** Attached to the X close-icon Pressable in the sheet header. */
  onCloseButtonPress: () => void;
  /** Passed to `<Modal onRequestClose={…}>` for the Android back button. */
  onRequestClose: () => void;
  /** Attached to the "Show results" apply button at the bottom of the sheet. */
  onApplyPress: () => void;
}

/**
 * Returns the four dismiss handlers for PulseFilterSheet.
 *
 * All four paths ultimately call `onClose`. Wrapping them in a named factory
 * lets node:test verify the contract without mounting the component, and gives
 * `testID`-annotated Pressables stable, meaningful event targets.
 */
export function createFilterDismissHandlers(onClose: () => void): FilterDismissHandlers {
  return {
    onBackdropPress: onClose,
    onCloseButtonPress: onClose,
    onRequestClose: onClose,
    onApplyPress: onClose,
  };
}
