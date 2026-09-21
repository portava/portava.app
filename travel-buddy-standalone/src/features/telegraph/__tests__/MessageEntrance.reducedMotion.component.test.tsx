/**
 * Telegraph §11.3 — "Provide reduced-motion behavior for media, GIFs and
 * animations."
 *
 * THE DEFECT THIS PINS. `MessageEntrance` had exactly one gate, `animate`, and
 * it is a PAGINATION rule: a message that predates mount does not replay its
 * entrance. Nothing in the Telegraph tree read the OS "reduce motion" setting;
 * the hook that does exists two directories away
 * (`src/features/wall/hooks/useReducedMotionSetting.ts`) and had one consumer,
 * a Wall video item. A traveler who had switched reduced motion ON still got a
 * spring-and-fade on every arriving message.
 *
 * WHAT IS EXERCISED: the real `MessageEntrance`, rendered both ways. The
 * reduced-motion HOOK is stubbed because AccessibilityInfo is not backed in
 * the jest preset — the thing under test is whether the component CONSULTS it,
 * which a stub proves precisely.
 *
 * SHOWN RED before commit: with `useReducedMotionSetting` removed from
 * `MessageEntrance` (the state before this change), the first test fails —
 * the animated wrapper is still in the tree with reduced motion ON. Restored,
 * both pass.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional stub — AccessibilityInfo.isReduceMotionEnabled is not
// backed by the jest preset's native layer; this test is about the component's
// USE of the setting, not the hook's own read of the platform.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({
  useReducedMotionSetting: jest.fn(() => false),
}));

import { MessageEntrance } from '../../../components/MessageEntrance.tsx';
import { useReducedMotionSetting } from '../../wall/hooks/useReducedMotionSetting.ts';

const mockedReduceMotion = useReducedMotionSetting as jest.MockedFunction<typeof useReducedMotionSetting>;

/** The animated wrapper carries an `entering` prop; the static one cannot. */
function enteringPropsInTree(json: any): number {
  let count = 0;
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.entering) count += 1;
    const kids = node.children ?? [];
    for (const k of Array.isArray(kids) ? kids : [kids]) walk(k);
  };
  walk(json);
  return count;
}

describe('MessageEntrance — §11.3 reduced motion', () => {
  it('with reduced motion ON, an arriving message does NOT animate', async () => {
    mockedReduceMotion.mockReturnValue(true);
    const view = await render(
      <MessageEntrance animate>
        <Text>hello</Text>
      </MessageEntrance>,
    );
    expect(screen.getByText('hello')).toBeTruthy();
    expect(enteringPropsInTree(view.toJSON())).toBe(0);
    expect(mockedReduceMotion).toHaveBeenCalled();
  });

  it('with reduced motion OFF, an arriving message still animates', async () => {
    mockedReduceMotion.mockReturnValue(false);
    const view = await render(
      <MessageEntrance animate>
        <Text>hello</Text>
      </MessageEntrance>,
    );
    expect(enteringPropsInTree(view.toJSON())).toBeGreaterThan(0);
  });

  it('a backfilled message never animates, whatever the setting says', async () => {
    mockedReduceMotion.mockReturnValue(false);
    const view = await render(
      <MessageEntrance animate={false}>
        <Text>old</Text>
      </MessageEntrance>,
    );
    expect(enteringPropsInTree(view.toJSON())).toBe(0);
  });
});
