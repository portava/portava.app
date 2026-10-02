/**
 * §46 — the accessibility-focus bridge call itself, unmocked.
 *
 * WHY THIS FILE IS SEPARATE FROM `suggestionAccessibility.component.test.tsx`
 * --------------------------------------------------------------------------
 * That file drives the real `SmartInput` and asserts WHEN the cursor is asked
 * for. It cannot also assert that the ask reaches the platform, because under
 * the jest renderer `findNodeHandle` returns `undefined` for every host node —
 * an unmocked assertion there could only ever say "nothing happened", which is
 * exactly what the defect looked like.
 *
 * So the chain is proven in two links, each of which can fail on its own:
 *   link 1 (here)  — given a node that HAS a handle, the module calls
 *                    `AccessibilityInfo.setAccessibilityFocus` with that handle;
 *   link 2 (there) — `SmartInput` calls this module on the right transitions.
 *
 * `findNodeHandle` returns a number handed to it verbatim, so passing a numeric
 * handle exercises the real module with the real React Native function and no
 * mock anywhere. That is deliberate: a mocked `findNodeHandle` would make this
 * a test of the mock.
 *
 * WHAT IT STILL DOES NOT PROVE: that VoiceOver or TalkBack moved its cursor.
 * That is a handset observation and it lives in
 * `docs/architecture/input-assistance-a11y-device-protocol.md`, unrun.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `cmp` byte-identical):
 *   - a11yFocus.ts: delete the `setAccessibilityFocus` call → "reaches the
 *     platform with the handle it was given" goes red.
 *   - a11yFocus.ts: drop the `handle == null` guard → "a node with no handle
 *     asks for nothing" goes red.
 *   - a11yFocus.ts: drop the `node == null` guard → "a null node asks for
 *     nothing" goes red.
 *   - a11yFocus.ts: `shouldRestoreFieldFocus` → `return true` → three of the
 *     policy cases go red.
 */
import { AccessibilityInfo } from 'react-native';
import { moveAccessibilityFocusTo, shouldRestoreFieldFocus } from '../a11yFocus.ts';

describe('§46: moveAccessibilityFocusTo', () => {
  let focus: jest.SpyInstance;

  beforeEach(() => {
    focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(() => {});
  });
  afterEach(() => focus.mockRestore());

  test('reaches the platform with the handle it was given', () => {
    expect(moveAccessibilityFocusTo(4242)).toBe(true);
    expect(focus).toHaveBeenCalledWith(4242);
  });

  test('a null node asks for nothing', () => {
    expect(moveAccessibilityFocusTo(null)).toBe(false);
    expect(moveAccessibilityFocusTo(undefined)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  test('a node with no handle asks for nothing rather than for handle 0', () => {
    // A view that is not mounted natively has no react tag. Passing `null`
    // through to the bridge, or coercing it to 0, would move the cursor to
    // whatever node 0 happens to be.
    expect(moveAccessibilityFocusTo({})).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  test('a failure in the bridge is never a failure for the user', () => {
    focus.mockImplementation(() => {
      throw new Error('bridge is down');
    });
    expect(() => moveAccessibilityFocusTo(4242)).not.toThrow();
    expect(moveAccessibilityFocusTo(4242)).toBe(false);
  });
});

describe('§46: shouldRestoreFieldFocus — the policy, without a screen reader', () => {
  test('a list that closed while the user is still in the field: restore', () => {
    expect(
      shouldRestoreFieldFocus({ overlayWasVisible: true, overlayIsVisible: false, stillFocused: true }),
    ).toBe(true);
  });

  test('a list that just OPENED: do not restore — that would be stealing focus', () => {
    expect(
      shouldRestoreFieldFocus({ overlayWasVisible: false, overlayIsVisible: true, stillFocused: true }),
    ).toBe(false);
  });

  test('a list that closed because the user LEFT the field: do not drag them back', () => {
    expect(
      shouldRestoreFieldFocus({ overlayWasVisible: true, overlayIsVisible: false, stillFocused: false }),
    ).toBe(false);
  });

  test('a list that was never up: nothing to restore from', () => {
    expect(
      shouldRestoreFieldFocus({ overlayWasVisible: false, overlayIsVisible: false, stillFocused: true }),
    ).toBe(false);
  });
});
