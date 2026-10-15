/**
 * CaptionAiAssist — the frame between the tap and the request (census G141).
 *
 * On a device the hook raises `loading` in an effect, which runs after the
 * first paint following the tap. In that frame the hook reports neither
 * `loading` nor any proposal. The test renderer's act() flushes that effect
 * before anything can be observed, so the real hook cannot show this frame;
 * the hook is stubbed here to hold it. The assist must say "Drafting", not
 * "No suggestion" — nothing has been asked yet.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the hook is held in the state a device shows
// for one frame after the tap: not loading, no proposals, not unavailable.
jest.mock('../../hooks/useAiWritingAssist.ts', () => ({
  useAiWritingAssist: () => ({ proposals: [], loading: false, unavailable: false }),
}));

// NOTE: intentionally exhaustive — the component reads only `isEnabled`.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, isLivePlacesEnabled: () => false, loading: false }),
}));

import { CaptionAiAssist } from '../CaptionAiAssist.tsx';

it('before the request has started, the tap shows "Drafting", not "No suggestion"', async () => {
  await render(<CaptionAiAssist fieldId="memory.caption" text="great dinner tonight" onInsert={jest.fn()} testID="cap-ai" />);
  await fireEvent.press(screen.getByTestId('cap-ai-button'));
  expect(screen.queryByTestId('cap-ai-none')).toBeNull();
  expect(screen.getByText('Drafting a suggestion…')).toBeTruthy();
});
