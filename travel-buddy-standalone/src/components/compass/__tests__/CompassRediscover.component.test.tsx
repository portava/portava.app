/**
 * CompassRediscover component tests (Memory + Experience Intelligence §8).
 *
 * Covers:
 *   - happy path: memories render grouped + labelled by reason
 *   - empty path: "nothing to resurface yet" copy, never an error
 *   - error path: soft message + working retry
 *   - collapseWhenEmpty: renders nothing at all until real memory exists
 *
 * Service is mocked so no network / auth is involved. Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

const mockFetchRediscover = jest.fn();
jest.mock('../../../services/compass', () => ({
  ...jest.requireActual('../../../services/compass'),
  fetchRediscover: (...args: unknown[]) => mockFetchRediscover(...args),
}));

import { CompassRediscover } from '../CompassRediscover.tsx';

const MEMORIES = [
  { id: 'm1', memory_type: 'episodic', subject_type: 'city', subject_id: 'Lisbon', content: 'Your first night was in Alfama', confidence: 0.9, reason: 'been_here_before' },
  { id: 'm2', memory_type: 'place', subject_type: 'place', subject_id: 'p9', content: 'You saved A Brasileira', confidence: 0.7, reason: 'you_saved' },
  { id: 'm3', memory_type: 'social', subject_type: 'user', subject_id: 'u2', content: 'Marta lives here', confidence: 0.6, reason: 'you_know' },
];

describe('CompassRediscover', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('renders memories grouped and labelled by reason', async () => {
    mockFetchRediscover.mockResolvedValue({ ok: true, data: MEMORIES });
    render(<CompassRediscover city="Lisbon" />);

    await waitFor(() => expect(screen.getByTestId('rediscover-group-been_here_before')).toBeTruthy());
    expect(mockFetchRediscover).toHaveBeenCalledWith('Lisbon');
    // Reason bucket labels
    expect(screen.getByText("You've been here before")).toBeTruthy();
    expect(screen.getByText('You saved these')).toBeTruthy();
    expect(screen.getByText('People you know here')).toBeTruthy();
    // Memory contents
    expect(screen.getByText('Your first night was in Alfama')).toBeTruthy();
    expect(screen.getByText('You saved A Brasileira')).toBeTruthy();
    expect(screen.getByText('Marta lives here')).toBeTruthy();
    // Not an empty/error state
    expect(screen.queryByTestId('rediscover-empty')).toBeNull();
    expect(screen.queryByTestId('rediscover-error')).toBeNull();
  });

  it('shows a graceful "nothing to resurface yet" empty state', async () => {
    mockFetchRediscover.mockResolvedValue({ ok: true, data: [] });
    render(<CompassRediscover city="Lisbon" />);

    await waitFor(() => expect(screen.getByTestId('rediscover-empty')).toBeTruthy());
    expect(screen.getByText(/Nothing to resurface yet/i)).toBeTruthy();
    expect(screen.queryByTestId('rediscover-error')).toBeNull();
  });

  it('shows a retry-able error and reloads when tapped', async () => {
    mockFetchRediscover.mockResolvedValueOnce({ ok: false, error: 'network_error' });
    render(<CompassRediscover city="Lisbon" />);

    await waitFor(() => expect(screen.getByTestId('rediscover-error')).toBeTruthy());
    expect(screen.getByText(/Couldn't load your memories/i)).toBeTruthy();

    // Retry now succeeds → error clears, data renders.
    mockFetchRediscover.mockResolvedValueOnce({ ok: true, data: MEMORIES });
    fireEvent.press(screen.getByTestId('rediscover-retry'));
    await waitFor(() => expect(screen.getByText('You saved A Brasileira')).toBeTruthy());
    expect(mockFetchRediscover).toHaveBeenCalledTimes(2);
  });

  it('treats not_configured as empty, never an error', async () => {
    mockFetchRediscover.mockResolvedValue({ ok: false, error: 'not_configured' });
    render(<CompassRediscover city="Lisbon" />);

    await waitFor(() => expect(screen.getByTestId('rediscover-empty')).toBeTruthy());
    expect(screen.queryByTestId('rediscover-error')).toBeNull();
  });

  it('renders nothing when collapseWhenEmpty and there is no memory', async () => {
    mockFetchRediscover.mockResolvedValue({ ok: true, data: [] });
    render(<CompassRediscover city="Lisbon" collapseWhenEmpty />);

    await waitFor(() => expect(mockFetchRediscover).toHaveBeenCalled());
    expect(screen.queryByTestId('compass-rediscover')).toBeNull();
    expect(screen.queryByTestId('rediscover-empty')).toBeNull();
  });

  it('still renders the card under collapseWhenEmpty once memory exists', async () => {
    mockFetchRediscover.mockResolvedValue({ ok: true, data: MEMORIES });
    render(<CompassRediscover city="Lisbon" collapseWhenEmpty />);

    await waitFor(() => expect(screen.getByTestId('compass-rediscover')).toBeTruthy());
    expect(screen.getByText('Your first night was in Alfama')).toBeTruthy();
  });
});
