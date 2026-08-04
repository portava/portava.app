/**
 * PortavaShareButton — component tests
 *
 * Covers:
 *  1. Fires the provided onPress handler unchanged (no behavior added/lost).
 *  2. Exposes the caller-provided accessibilityLabel (action-specific, e.g.
 *     "Share this trip") rather than any generic "Share" default.
 *  3. Computes hitSlop so the total touch target is >=44x44 even for a
 *     small (14px) icon.
 *  4. Does not fire onPress when disabled, and reflects disabled in
 *     accessibilityState.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PortavaShareButton } from '../PortavaShareButton.tsx';

describe('PortavaShareButton', () => {
  it('fires the provided onPress handler', async () => {
    const onPress = jest.fn();
    await render(<PortavaShareButton onPress={onPress} accessibilityLabel="Share this trip" />);
    fireEvent.press(screen.getByLabelText('Share this trip'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('exposes the action-specific accessibilityLabel passed by the caller', async () => {
    await render(<PortavaShareButton onPress={() => {}} accessibilityLabel="Share this stamp" />);
    expect(screen.getByLabelText('Share this stamp')).toBeTruthy();
  });

  it('pads a small icon out to a >=44x44 touch target via hitSlop', async () => {
    await render(<PortavaShareButton onPress={() => {}} iconSize={14} accessibilityLabel="Share" testID="share-btn" />);
    const btn = screen.getByTestId('share-btn');
    const hitSlop = btn.props.hitSlop;
    // iconSize 14 -> pad = (44-14)/2 = 15 on each side -> 14 + 15*2 = 44
    expect(hitSlop).toBe(15);
  });

  it('does not fire onPress and reflects disabled state when disabled', async () => {
    const onPress = jest.fn();
    await render(
      <PortavaShareButton onPress={onPress} accessibilityLabel="Share" disabled testID="share-btn-disabled" />,
    );
    const btn = screen.getByTestId('share-btn-disabled');
    fireEvent.press(btn);
    expect(onPress).not.toHaveBeenCalled();
    expect(btn.props.accessibilityState).toEqual({ disabled: true });
  });
});
