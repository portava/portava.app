/**
 * The "Trip Memory" block on the trip screen — memories created from trips.
 *
 * WHAT WAS WRONG (lane highlights, 2026-10-03). The block read
 * `GET /trips/:tripId/memory` and treated EVERY failure as "this trip has no
 * Memory": a 503 (`degraded_unavailable`), an unreachable network and a real
 * 404 all rendered the same thing. For the trip owner of a completed trip that
 * meant the "Create a memory from this trip" button — an offer to write a
 * second Memory for a trip that may already have one — and for everybody else
 * the sentence "No memory for this trip yet", a claim nobody had checked.
 *
 * WHAT THIS SUITE PINS:
 *   - an unreadable read is an error with a retry, never the create offer and
 *     never "no memory";
 *   - a real `not_found` is still the create offer (owner, completed trip) or
 *     "no memory yet" (everybody else);
 *   - a refused create is said, and the person stays on the trip;
 *   - a create that answers the trip's existing Memory opens that Memory.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
// NOTE: intentionally exhaustive — CachedImage resolves through expo-image.
jest.mock('../../../components/CachedImage.tsx', () => ({ CachedImage: () => null }));

const mockGetTripMemory = jest.fn();
const mockCreateTripMemory = jest.fn();
jest.mock('../../../services/memories.ts', () => ({
  ...jest.requireActual('../../../services/memories.ts'),
  getTripMemory: (...a: unknown[]) => mockGetTripMemory(...a),
  createTripMemory: (...a: unknown[]) => mockCreateTripMemory(...a),
}));

import { TripMemorySection } from '../TripMemorySection.tsx';

const TRIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const memory = { id: 'mem-1', title: 'Lisbon week', caption: null, state: 'draft', cover: null };

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  mockPush.mockReset();
  mockGetTripMemory.mockReset();
  mockCreateTripMemory.mockReset();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alertSpy.mockRestore());

it('an unreadable trip Memory is an error with a retry — never the create offer, never "no memory"', async () => {
  mockGetTripMemory.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'Could not read the trip. Please try again.' });
  await render(<TripMemorySection tripId={TRIP} isOwner tripStatus="completed" />);
  expect(await screen.findByTestId('trip-memory-error')).toBeTruthy();
  expect(screen.queryByText('Create a memory from this trip')).toBeNull();
  expect(screen.queryByText('No memory for this trip yet')).toBeNull();

  mockGetTripMemory.mockResolvedValueOnce({ ok: true, memory });
  await act(async () => { fireEvent.press(screen.getByTestId('trip-memory-retry')); });
  expect(await screen.findByText('Lisbon week')).toBeTruthy();
  expect(screen.queryByTestId('trip-memory-error')).toBeNull();
  expect(mockGetTripMemory).toHaveBeenCalledTimes(2);
});

it('an unreachable network is the same error for a crew member — not "no memory yet"', async () => {
  mockGetTripMemory.mockResolvedValueOnce({ ok: false, kind: 'network_unreachable', message: 'Network request failed' });
  await render(<TripMemorySection tripId={TRIP} isOwner={false} tripStatus="completed" />);
  expect(await screen.findByTestId('trip-memory-error')).toBeTruthy();
  expect(screen.queryByText('No memory for this trip yet')).toBeNull();
});

it('a real not_found offers the owner of a completed trip the create', async () => {
  mockGetTripMemory.mockResolvedValueOnce({ ok: false, kind: 'not_found', message: 'No memory for this trip' });
  await render(<TripMemorySection tripId={TRIP} isOwner tripStatus="completed" />);
  expect(await screen.findByText('Create a memory from this trip')).toBeTruthy();
  expect(screen.queryByTestId('trip-memory-error')).toBeNull();
});

it('a real not_found tells everybody else there is no memory yet', async () => {
  mockGetTripMemory.mockResolvedValueOnce({ ok: false, kind: 'not_found', message: 'No memory for this trip' });
  await render(<TripMemorySection tripId={TRIP} isOwner={false} tripStatus="completed" />);
  expect(await screen.findByText('No memory for this trip yet')).toBeTruthy();
});

it('a refused create is said and the person stays; a create answering the existing Memory opens it', async () => {
  mockGetTripMemory.mockResolvedValueOnce({ ok: false, kind: 'not_found', message: 'No memory for this trip' });
  await render(<TripMemorySection tripId={TRIP} isOwner tripStatus="completed" />);
  const button = await screen.findByText('Create a memory from this trip');

  mockCreateTripMemory.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'Could not check for this trip’s Memory. Please try again.', operationId: 'op-1' });
  await act(async () => { fireEvent.press(button); });
  expect(alertSpy).toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();

  mockCreateTripMemory.mockResolvedValueOnce({ ok: true, memory, existing: true, operationId: 'op-1' });
  await act(async () => { fireEvent.press(screen.getByText('Create a memory from this trip')); });
  expect(mockPush).toHaveBeenCalledWith('/memory/mem-1');
  expect(mockCreateTripMemory).toHaveBeenCalledWith(TRIP);
});
