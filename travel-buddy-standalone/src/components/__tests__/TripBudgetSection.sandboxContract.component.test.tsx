/**
 * "What if…" sends only what POST /trips/:tripId/budget/sandbox accepts.
 *
 * THE DEFECTS. The server's SandboxSchema (artifacts/api-server/src/routes/
 * tripBudgetIntel.ts) takes `protectedCategories` from BASELINE_CATEGORIES —
 * lodging, food, transport, activities, nightlife, other — and `extraDays` as
 * an INTEGER from -90 to 90. The sheet offered accommodation / shopping / misc
 * (three of its six chips) and parsed extra days with parseFloat, so protecting
 * "accommodation" or typing "1.5" got a 400 that the traveller saw only as
 * "Could not run scenario".
 *
 * Separate file, ONE render (async Modal tests need their own worker; RNTL v14
 * + React 19 render-count limit).
 *
 * RED on the tree before this change: 1 failed / 0 passed.
 */
import React from 'react';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import { TripBudgetSection } from '../trip/TripBudgetSection.tsx';

// NOTE: intentional stub — Modal's native animation lifecycle corrupts
// actScopeDepth under jest-expo; only Modal and ActivityIndicator are replaced.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: any) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target: any, prop: string, receiver: any) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

jest.mock('../../services/tripIntel', () => ({
  ...jest.requireActual('../../services/tripIntel'),
  fetchCostEstimate:  jest.fn(),
  fetchManualBudget:  jest.fn(),
  updateManualBudget: jest.fn(),
  runBudgetSandbox:   jest.fn(),
}));

/** The server's BASELINE_CATEGORIES, read from the server source (it does not import under jest-expo). */
const SERVER_CATEGORIES: readonly string[] = (() => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const src = readFileSync(join(__dirname, '../../../../artifacts/api-server/src/domain/trips/services/tripBudgetIntel.ts'), 'utf8');
  const block = /export const BASELINE_CATEGORIES = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
  return [...block.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
})();

const ESTIMATE = {
  available: true, currency: 'USD',
  perDay: { low: 80, mid: 120, high: 200 }, total: { low: 560, mid: 840, high: 1400 },
  confidence: 'medium', assumptions: [],
};
const RESULT = {
  available: true, days: 9,
  dailySpend: { low: 80, mid: 120, high: 200 }, total: { low: 720, mid: 1080, high: 1800 },
  budget: null, fitsBudget: null, gap: null, suggestions: [], protectedCategories: ['lodging'], notes: [],
};

describe('TripBudgetSection — the sandbox request matches the server schema', () => {
  it('offers exactly the server categories, refuses a fractional day count, and sends integers', async () => {
    const m = require('../../services/tripIntel.ts');
    m.fetchCostEstimate.mockResolvedValue(ESTIMATE);
    m.fetchManualBudget.mockResolvedValue(null);
    m.runBudgetSandbox.mockResolvedValue(RESULT);

    const view = await render(<TripBudgetSection tripId="trip-1" isOwnerOrCohost={false} isOwner={false} />);
    fireEvent.press(await view.findByText('What if…'));
    await waitFor(() => view.getByLabelText('Extra days'));

    // Exactly the server's six — none of the three it refuses.
    expect(SERVER_CATEGORIES.length).toBe(6); // vacuity: the server list was read
    for (const c of SERVER_CATEGORIES) expect(view.getByText(c)).toBeTruthy();
    for (const c of ['accommodation', 'shopping', 'misc']) expect(view.queryByText(c)).toBeNull();

    // "1.5" is not sent (the server would refuse it); the traveller is told why.
    fireEvent.changeText(view.getByLabelText('Extra days'), '1.5');
    await waitFor(() => expect(view.getByLabelText('Extra days').props.value).toBe('1.5'));
    fireEvent.press(view.getByText('Run scenario'));
    await waitFor(() => expect(view.getByText(/Extra days must be a whole number/)).toBeTruthy());
    expect(m.runBudgetSandbox).not.toHaveBeenCalled();

    // A whole number and a server category go through as the schema expects.
    fireEvent.changeText(view.getByLabelText('Extra days'), '2');
    await waitFor(() => expect(view.getByLabelText('Extra days').props.value).toBe('2'));
    await act(async () => { fireEvent.press(view.getByText('lodging')); });
    await act(async () => { fireEvent.press(view.getByText('nightlife')); });
    await act(async () => { fireEvent.press(view.getByText('Run scenario')); });
    await waitFor(() => expect(m.runBudgetSandbox).toHaveBeenCalledWith('trip-1', { extraDays: 2, protectedCategories: ['lodging', 'nightlife'] }));
    const sent = m.runBudgetSandbox.mock.calls[0][1];
    expect(Number.isInteger(sent.extraDays)).toBe(true);
    for (const c of sent.protectedCategories) expect(SERVER_CATEGORIES).toContain(c);
  });
});
