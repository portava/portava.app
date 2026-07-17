/**
 * KeyboardSafeView / KeyboardSafeScrollView — Android keyboard-avoidance behavior
 *
 * Run with: pnpm test:component
 *
 * ## What & Why
 *
 * Several screens previously passed
 *   behavior={Platform.OS === 'ios' ? 'padding' : undefined}
 * which left Android with no keyboard avoidance at all. After migration they
 * all use the shared KeyboardSafeScrollView wrapper, which gives Android
 * behavior='height' (see KeyboardSafeView.tsx line 34 and the companion
 * keyboardAndroidMigration.test.ts static check).
 *
 * These component tests verify the three guarantees that are observable in the
 * Jest environment without requiring an Android device or a react-native shim:
 *
 *   1. The behavior prop is never undefined — any truthy value means the
 *      KeyboardAvoidingView is actively engaged.
 *   2. The value matches the platform formula (ios → 'padding', else → 'height').
 *   3. Offset and style props are forwarded correctly on both platforms.
 *
 * The Android-specific 'height' value is confirmed statically by
 * keyboardAndroidMigration.test.ts, which reads the source and asserts the
 * Platform.OS branch formula is present.
 *
 * Uses react-test-renderer so composite props are inspectable directly —
 * RNTL v14 dropped UNSAFE_getByProps.
 */
import React from 'react';
import { Platform, KeyboardAvoidingView, ScrollView } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  KeyboardSafeView,
  KeyboardSafeScrollView,
} from '../KeyboardSafeView.tsx';

// The formula in KeyboardSafeView.tsx: Platform.OS === 'ios' ? 'padding' : 'height'
// Under jest-expo, Platform.OS='ios', so expectedBehavior='padding' in this
// environment.  The companion static test confirms the formula gives 'height'
// for any non-iOS OS string (i.e. Android).
const expectedBehavior = Platform.OS === 'ios' ? 'padding' : 'height';

function create(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => {
    tr = TestRenderer.create(el);
  });
  return tr;
}

// ── KeyboardSafeScrollView ────────────────────────────────────────────────────

describe('KeyboardSafeScrollView — platform-correct behavior', () => {
  it('behavior prop is defined — KeyboardAvoidingView is always engaged (not undefined)', () => {
    const tr = create(
      <KeyboardSafeScrollView>
        <></>
      </KeyboardSafeScrollView>,
    );
    const behavior = tr.root.findByType(KeyboardAvoidingView).props.behavior;
    // The pre-migration bug: screens passed `undefined` on Android. This asserts
    // the shared wrapper never leaves behavior unset on any platform.
    expect(behavior).not.toBeUndefined();
  });

  it('behavior matches platform formula (ios → "padding", other → "height")', () => {
    const tr = create(
      <KeyboardSafeScrollView>
        <></>
      </KeyboardSafeScrollView>,
    );
    expect(tr.root.findByType(KeyboardAvoidingView).props.behavior).toBe(
      expectedBehavior,
    );
  });

  it('does not add an inner ScrollView — caller supplies the scroll container', () => {
    const tr = create(
      <KeyboardSafeScrollView>
        <></>
      </KeyboardSafeScrollView>,
    );
    expect(tr.root.findAllByType(ScrollView)).toHaveLength(0);
  });

  it('forwards keyboardVerticalOffset from the offset prop', () => {
    const tr = create(
      <KeyboardSafeScrollView offset={56}>
        <></>
      </KeyboardSafeScrollView>,
    );
    expect(
      tr.root.findByType(KeyboardAvoidingView).props.keyboardVerticalOffset,
    ).toBe(56);
  });

  it('defaults keyboardVerticalOffset to 0', () => {
    const tr = create(
      <KeyboardSafeScrollView>
        <></>
      </KeyboardSafeScrollView>,
    );
    expect(
      tr.root.findByType(KeyboardAvoidingView).props.keyboardVerticalOffset,
    ).toBe(0);
  });

  it('merges custom style over the flex:1 base', () => {
    const tr = create(
      <KeyboardSafeScrollView style={{ backgroundColor: '#fff' }}>
        <></>
      </KeyboardSafeScrollView>,
    );
    const flat = Object.assign(
      {},
      ...[tr.root.findByType(KeyboardAvoidingView).props.style].flat(Infinity),
    );
    expect(flat.flex).toBe(1);
    expect(flat.backgroundColor).toBe('#fff');
  });
});

// ── KeyboardSafeView ──────────────────────────────────────────────────────────

describe('KeyboardSafeView — platform-correct behavior', () => {
  it('behavior prop is defined — KeyboardAvoidingView is always engaged', () => {
    const tr = create(
      <KeyboardSafeView>
        <></>
      </KeyboardSafeView>,
    );
    expect(
      tr.root.findByType(KeyboardAvoidingView).props.behavior,
    ).not.toBeUndefined();
  });

  it('behavior matches platform formula (ios → "padding", other → "height")', () => {
    const tr = create(
      <KeyboardSafeView>
        <></>
      </KeyboardSafeView>,
    );
    expect(
      tr.root.findByType(KeyboardAvoidingView).props.behavior,
    ).toBe(expectedBehavior);
  });

  it('includes an inner ScrollView with keyboardShouldPersistTaps="handled"', () => {
    const tr = create(
      <KeyboardSafeView>
        <></>
      </KeyboardSafeView>,
    );
    const scroll = tr.root.findByType(ScrollView);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scroll.props.showsVerticalScrollIndicator).toBe(false);
  });

  it('forwards keyboardVerticalOffset from the offset prop', () => {
    const tr = create(
      <KeyboardSafeView offset={44}>
        <></>
      </KeyboardSafeView>,
    );
    expect(
      tr.root.findByType(KeyboardAvoidingView).props.keyboardVerticalOffset,
    ).toBe(44);
  });
});
