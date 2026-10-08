/**
 * Discovery Trending, user-facing (owner decision 2026-10-04). SHOWN RED FIRST:
 * the view did not exist at `2e46835263`. Off, no-run and failed are each said
 * in words; none is drawn as "nothing is trending"; rows carry no number.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TrendingView } from '../TrendingView.tsx';
import { DiscoveryExploreLinks, exploreHref } from '../../DiscoveryExploreLinks.tsx';

const reason = { code: 'gaining_independent_groups', text: 'More separate groups are visiting than before.' };
const list = (over: Record<string, unknown> = {}) => ({
  state: 'ok', data: { action: 'places', destination: 'lisbon', places: [{ placeId: 'p1', state: 'trending', reason }], areas: [], trails: [], unavailable: null, trailsUnavailable: null, basis: null, ...over },
});
const placeName = jest.fn().mockResolvedValue({ state: 'ok', data: { name: 'Time Out Market', category: 'food' } });

it('reads the city it opened on, names each place, gives the server\'s reason, and links the place', async () => {
  const load = jest.fn().mockResolvedValue(list());
  const onNavigate = jest.fn();
  await render(<TrendingView initialDestination="Lisbon" onNavigate={onNavigate} load={load} loadPlaceName={placeName} />);
  await waitFor(() => screen.getByText('Time Out Market'));
  expect(load).toHaveBeenCalledWith('places', 'Lisbon');
  expect(screen.getByText(`Trending · ${reason.text}`)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('trending-place-p1'));
  expect(onNavigate).toHaveBeenCalledWith('/place/p1');
});

it('switching tab reads that list; emerging Trails link to the Trail', async () => {
  const load = jest.fn().mockImplementation(async (a: string) => a === 'emerging'
    ? list({ action: 'emerging', places: [], trails: [{ trailId: 't1', state: 'emerging', reason }] })
    : list());
  const onNavigate = jest.fn();
  await render(<TrendingView initialDestination="Lisbon" onNavigate={onNavigate} load={load} loadPlaceName={placeName} />);
  await waitFor(() => screen.getByTestId('trending-place-p1'));
  await fireEvent.press(screen.getByTestId('trending-tab-emerging'));
  await waitFor(() => screen.getByTestId('trending-trail-t1'));
  await fireEvent.press(screen.getByTestId('trending-trail-t1'));
  expect(onNavigate).toHaveBeenCalledWith('/trails/t1');
});

it('off, a list with no current run, and a failed read are each said — none is "nothing is trending"', async () => {
  await render(<TrendingView initialDestination="Lisbon" onNavigate={jest.fn()} load={jest.fn().mockResolvedValue({ state: 'off' })} loadPlaceName={placeName} />);
  await waitFor(() => screen.getByText("Trending isn't available yet."));
  expect(screen.queryByTestId('trending-empty')).toBeNull();

  await render(<TrendingView initialDestination="Lisbon" onNavigate={jest.fn()} load={jest.fn().mockResolvedValue(list({ places: [], unavailable: 'no_snapshot' }))} loadPlaceName={placeName} />);
  await waitFor(() => screen.getByTestId('trending-list-unavailable'));
  expect(screen.queryByTestId('trending-empty')).toBeNull();

  const retry = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 503' }).mockResolvedValue(list());
  await render(<TrendingView initialDestination="Lisbon" onNavigate={jest.fn()} load={retry} loadPlaceName={placeName} />);
  await waitFor(() => screen.getByTestId('trending-retry'));
  await fireEvent.press(screen.getByTestId('trending-retry'));
  await waitFor(() => screen.getByTestId('trending-place-p1'));
});

it('no city: asks for one and makes no request', async () => {
  const load = jest.fn();
  await render(<TrendingView onNavigate={jest.fn()} load={load} loadPlaceName={placeName} />);
  await waitFor(() => screen.getByTestId('trending-no-city'));
  expect(load).not.toHaveBeenCalled();
});

it('the Discovery tab links carry the city into both screens', async () => {
  expect(exploreHref('trails', 'Ho Chi Minh City')).toBe('/trails?destination=Ho%20Chi%20Minh%20City');
  expect(exploreHref('trending', null)).toBe('/trending');
  const onNavigate = jest.fn();
  await render(<DiscoveryExploreLinks city="Lisbon" onNavigate={onNavigate} />);
  await fireEvent.press(screen.getByTestId('discovery-link-trending'));
  expect(onNavigate).toHaveBeenCalledWith('/trending?destination=Lisbon');
});
