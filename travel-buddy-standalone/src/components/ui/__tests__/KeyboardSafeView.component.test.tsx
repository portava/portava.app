/**
 * KeyboardSafeView / KeyboardSafeScrollView — verifies the canonical
 * keyboard-avoidance wrappers render the expected structure:
 *  - KeyboardAvoidingView with platform-correct behavior
 *  - offset prop forwarded to keyboardVerticalOffset
 *  - inner ScrollView (KeyboardSafeView only) with
 *    keyboardShouldPersistTaps="handled" and no scroll indicator
 *
 * Uses react-test-renderer directly so composite props (behavior,
 * keyboardVerticalOffset) are inspectable — RNTL v14 dropped the
 * UNSAFE_getByProps helpers.
 */
import React from 'react';
import { Text, Platform, KeyboardAvoidingView, ScrollView } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  KeyboardSafeView,
  KeyboardSafeScrollView,
} from '../KeyboardSafeView.tsx';

const expectedBehavior = Platform.OS === 'ios' ? 'padding' : 'height';

function create(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => {
    tr = TestRenderer.create(el);
  });
  return tr;
}

describe('KeyboardSafeView', () => {
  it('renders children inside a KeyboardAvoidingView + ScrollView', () => {
    const tr = create(
      <KeyboardSafeView offset={42}>
        <Text>hello</Text>
      </KeyboardSafeView>,
    );
    const kav = tr.root.findByType(KeyboardAvoidingView);
    expect(kav.props.behavior).toBe(expectedBehavior);
    expect(kav.props.keyboardVerticalOffset).toBe(42);

    const scroll = tr.root.findByType(ScrollView);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scroll.props.showsVerticalScrollIndicator).toBe(false);

    expect(tr.root.findByType(Text).props.children).toBe('hello');
  });

  it('defaults offset to 0', () => {
    const tr = create(
      <KeyboardSafeView>
        <Text>x</Text>
      </KeyboardSafeView>,
    );
    expect(
      tr.root.findByType(KeyboardAvoidingView).props.keyboardVerticalOffset,
    ).toBe(0);
  });
});

describe('KeyboardSafeScrollView', () => {
  it('renders a bare KeyboardAvoidingView (no inner ScrollView)', () => {
    const tr = create(
      <KeyboardSafeScrollView offset={7}>
        <Text>body</Text>
      </KeyboardSafeScrollView>,
    );
    const kav = tr.root.findByType(KeyboardAvoidingView);
    expect(kav.props.behavior).toBe(expectedBehavior);
    expect(kav.props.keyboardVerticalOffset).toBe(7);
    expect(tr.root.findAllByType(ScrollView)).toHaveLength(0);
  });

  it('merges custom style over the flex:1 base', () => {
    const tr = create(
      <KeyboardSafeScrollView style={{ justifyContent: 'flex-end' }}>
        <Text>s</Text>
      </KeyboardSafeScrollView>,
    );
    const kav = tr.root.findByType(KeyboardAvoidingView);
    const flat = Object.assign({}, ...[kav.props.style].flat(Infinity));
    expect(flat.flex).toBe(1);
    expect(flat.justifyContent).toBe('flex-end');
  });
});
