import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TrendingView } from '../TrendingView.tsx';

const list = (action: string) => ({ state: 'ok', data: { action, destination: 'Lisbon', places: [], areas: [], trails: [], unavailable: null, trailsUnavailable: null, basis: null } });

it('ignores an old tab result after a newer tab has answered', async () => {
  let finish!: (answer: any) => void;
  const slow = new Promise((r) => { finish = r; });
  const load = jest.fn().mockReturnValueOnce(slow).mockResolvedValue(list('emerging'));
  await render(<TrendingView initialDestination="Lisbon" onNavigate={jest.fn()} load={load} />);
  await fireEvent.press(screen.getByTestId('trending-tab-emerging'));
  await waitFor(() => screen.getByTestId('trending-empty'));
  await act(async () => { finish({ state: 'unavailable', detail: 'old failure' }); });
  expect(screen.queryByTestId('trending-unavailable')).toBeNull();
  expect(screen.getByTestId('trending-empty')).toBeTruthy();
});

it('a thrown read is a retryable failure, never an endless spinner', async () => {
  const load = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(list('places'));
  await render(<TrendingView initialDestination="Lisbon" onNavigate={jest.fn()} load={load} />);
  await waitFor(() => screen.getByTestId('trending-retry'));
  expect(screen.queryByTestId('trending-empty')).toBeNull();
  await fireEvent.press(screen.getByTestId('trending-retry'));
  await waitFor(() => screen.getByTestId('trending-empty'));
});
