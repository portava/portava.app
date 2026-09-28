/**
 * EmptyState's optional `primaryAction.fill` (census-media §31.13).
 *
 * The primary action is onInk text on a `signal` button (3.14:1). Without the
 * prop that must not change. The Grid's error state passes the Media-local
 * vermilion #C43B23, on which onInk reads 4.99:1.
 *
 * Run with:  pnpm test:component
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { Film } from 'lucide-react-native';
import { EmptyState } from '../EmptyState.tsx';
import { color } from '../../../theme/tokens.ts';

async function buttonFill(action: { label: string; onPress: () => void; fill?: string }): Promise<unknown> {
  const r = await render(<EmptyState icon={Film} title="Couldn’t load feed" primaryAction={action} />);
  const button = r.getByRole('button');
  const style = typeof button.props.style === 'function' ? button.props.style({ pressed: false }) : button.props.style;
  return StyleSheet.flatten(style)?.backgroundColor;
}

describe('EmptyState primaryAction.fill', () => {
  it('without a fill, the button stays `signal`', async () => {
    expect(await buttonFill({ label: 'Try again', onPress: () => {} })).toBe(color.signal);
  });
  it('a fill replaces it, and the label stays onInk', async () => {
    expect(await buttonFill({ label: 'Try again', onPress: () => {}, fill: '#C43B23' })).toBe('#C43B23');
    const r = await render(<EmptyState icon={Film} title="x" primaryAction={{ label: 'Try again', onPress: () => {}, fill: '#C43B23' }} />);
    expect(StyleSheet.flatten(r.getByText('Try again').props.style).color).toBe(color.onInk);
  });
});
