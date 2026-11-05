import React from 'react';
import { useWindowDimensions } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { StampGrid } from '../StampGrid.tsx';
import { mapStamp } from '../../../services/passportStampMappers.ts';

const mockColumns = jest.fn();
// Observe the real FlatList configuration while retaining its real rendering.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const React = require('react');
  return Object.defineProperties(Object.create(actual), {
    useWindowDimensions: { value: jest.fn() },
    FlatList: { value: React.forwardRef((props: Record<string, unknown>, ref: unknown) => { mockColumns(props.numColumns); return React.createElement(actual.FlatList, { ...props, ref }); }) },
  });
});

const stamps = ['First Step', 'Trip Planner', 'First Post', 'First Postcard'].map((name, i) => mapStamp({
  id: `stamp-${i}`, stamp_type: 'plan', title_override: name, earned_at: '2026-10-22T12:00:00Z',
}));

it('reflows larger text into fewer columns without losing stamps or press targets', async () => {
  const dimensions = jest.mocked(useWindowDimensions);
  dimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
  const onStampPress = jest.fn();
  const grid = () => <StampGrid stamps={stamps} loading={false} error={null} isOwner={false} onRetry={() => {}} onStampPress={onStampPress} emptyTitle="No stamps" emptySub="" />;
  const view = await render(grid());
  expect(mockColumns).toHaveBeenLastCalledWith(3);
  dimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 2 });
  await view.rerender(grid());
  expect(mockColumns).toHaveBeenLastCalledWith(2);
  await fireEvent.press(screen.getAllByText('First Postcard')[0]);
  expect(onStampPress).toHaveBeenCalledWith(stamps[3]);
  dimensions.mockReturnValue({ width: 320, height: 844, scale: 3, fontScale: 3 });
  await view.rerender(grid());
  expect(mockColumns).toHaveBeenLastCalledWith(1);
  expect(screen.getAllByText(/^(First Step|Trip Planner|First Post|First Postcard)$/)).toHaveLength(8);
});
