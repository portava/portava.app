/**
 * Global Input Intelligence — moving VoiceOver/TalkBack focus (spec §46
 * "VoiceOver/TalkBack focus management on mobile").
 *
 * WHY THIS EXISTS
 * ---------------
 * Census G326 reads: "`setAccessibilityFocus` appears nowhere, so focus is
 * still never MOVED into the overlay when it opens or back to the field when it
 * closes."
 *
 * The half that is a real defect is the SECOND one. When the overlay unmounts —
 * after a selection, on Escape, or when the results go away — a screen-reader
 * cursor that had walked into the list is sitting on a node that no longer
 * exists. iOS VoiceOver answers that by jumping to the top of the screen and
 * Android TalkBack by picking whatever it finds; either way the user is thrown
 * out of the field they were typing in. Restoring the cursor to the input is
 * the fix, and it is what `SmartInput` calls this for.
 *
 * The FIRST half — moving focus into the overlay on open — is deliberately NOT
 * built, and that is a design decision rather than an omission. A suggestion
 * list opens on a keystroke. Taking the screen-reader cursor out of the text
 * field on every keystroke would stop the user typing: they would have to swipe
 * back to the field between characters. The correct pattern for a typeahead is
 * the one already in place — keep the cursor in the field and announce the
 * count through the overlay's polite live region (`SuggestionOverlay`) — and
 * `suggestionAccessibility.component.test.tsx` pins the no-steal behaviour so a
 * later pass cannot "fix" G326 by breaking typing.
 *
 * WHAT A GREEN TEST OF THIS MODULE PROVES, AND WHAT IT DOES NOT
 * ------------------------------------------------------------
 * It proves this function reaches the native bridge with the handle of the node
 * it was given. It does NOT prove that VoiceOver or TalkBack honoured the
 * request on a handset — no test in this environment can, and the residual is
 * recorded in `docs/architecture/input-assistance-a11y-device-protocol.md`.
 */
import { AccessibilityInfo, Platform, findNodeHandle } from 'react-native';

/**
 * Move the accessibility cursor onto `node`. Returns true only when the request
 * actually reached the platform, so a caller (and a test) can tell "moved" from
 * "nothing to move to".
 *
 * Never throws: a failed assistive-tech hint must cost the user nothing, which
 * is the same rule `SmartInput` applies around `announceForAccessibility`.
 */
export function moveAccessibilityFocusTo(node: unknown): boolean {
  if (node == null) return false;
  // react-native-web has no findNodeHandle/reactTag equivalent; the DOM moves
  // focus through the element itself and the browser's own AT follows it.
  if (Platform.OS === 'web') return false;
  try {
    const handle = findNodeHandle(node as never);
    if (handle == null) return false;
    AccessibilityInfo.setAccessibilityFocus(handle);
    return true;
  } catch {
    return false;
  }
}

/**
 * §46 — should the accessibility cursor be pulled back to the field?
 *
 * Pure so the POLICY is assertable without a screen reader, and separate from
 * the bridge call above so each half can fail on its own.
 *
 * Yes exactly when a list that WAS on screen has gone away while the user is
 * still in the field. The `stillFocused` clause is what keeps this from
 * fighting the user: when the overlay closed because they left the field
 * (blur, or a tap on something else), the cursor belongs wherever they went,
 * and yanking it back to an input they just left would be the same defect in
 * the opposite direction.
 */
export function shouldRestoreFieldFocus(args: {
  overlayWasVisible: boolean;
  overlayIsVisible: boolean;
  stillFocused: boolean;
}): boolean {
  return args.overlayWasVisible && !args.overlayIsVisible && args.stillFocused;
}
