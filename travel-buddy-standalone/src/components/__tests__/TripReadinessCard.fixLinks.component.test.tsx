/**
 * TripReadinessCard — every category it calls missing leads to where it is added.
 *
 * On the owner's iPhone (2026-10-22) a freshly created trip read "missing" for stay, transport, budget, entry,
 * documents and reservations, and nothing on the card led anywhere: category rows were plain text, and the critical
 * rows' "Fix →" needs an `actionRef.href` the server (domain/trips/services/tripReadiness.ts) never sends — its
 * actionRefs are null, {dates}, {officialSourceUrl}, {reservationId} or {kind}. The editors exist on the trip page
 * (the plan's Add for stay/transport, Before you go for entry, the budget and shared-documents sections), except
 * reservations, whose import is OFF in production.
 *
 * The fixture is the shape the server sends for a new trip: actionRef null everywhere.
 *   F1  each incomplete / action-needed row is a button that reports its category;
 *   F2  a row the traveller cannot add here shows why and is not a button (reservations off; budget for non-hosts);
 *   F3  ready rows stay plain; without `onFix` nothing is a button (the card's previous behaviour).
 */
import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { TripReadinessCard } from '../trip/TripReadinessCard.tsx';

// NOTE: exhaustive override — expo-router's actual `router` is a Proxy that throws in the test environment.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn() },
}));

jest.mock('../../services/tripIntel.ts', () => ({
  ...jest.requireActual('../../services/tripIntel.ts'),
  fetchTripReadiness: jest.fn(),
}));

const item = (category: string, status: 'incomplete' | 'action_needed' | 'ready', title: string) => ({
  category, status, severity: 'normal' as const, title, detail: null, dueAt: null, actionRef: null,
});
const NEW_TRIP = {
  computedAt: '2026-10-22T16:00:00Z',
  explanation: {
    headline: '6 things to sort before this trip is ready',
    byCategory: [
      { category: 'plan', status: 'ready' as const, because: 'Nothing outstanding', nextAction: null },
      { category: 'stay', status: 'incomplete' as const, because: 'No accommodation planned', nextAction: null },
      { category: 'transport', status: 'incomplete' as const, because: 'No transport planned', nextAction: null },
      { category: 'budget', status: 'incomplete' as const, because: 'No budget set', nextAction: null },
      { category: 'entry', status: 'action_needed' as const, because: 'Select your travel passport', nextAction: null },
      { category: 'documents', status: 'incomplete' as const, because: 'No documents saved', nextAction: null },
      { category: 'reservations', status: 'incomplete' as const, because: 'No reservations added', nextAction: null },
    ],
    measured: 7,
    ready: 1,
  },
  score: 14,
  counts: { ready: 1, action_needed: 1, incomplete: 5, unknown: 0 },
  criticalItems: [],
  categories: { plan: 'ready', stay: 'incomplete', transport: 'incomplete', budget: 'incomplete', entry: 'action_needed', documents: 'incomplete', reservations: 'incomplete' },
  items: [
    item('plan', 'ready', 'Itinerary started'),
    item('stay', 'incomplete', 'No accommodation planned'),
    item('transport', 'incomplete', 'No transport planned'),
    item('budget', 'incomplete', 'No budget set'),
    item('entry', 'action_needed', 'Select your travel passport'),
    item('documents', 'incomplete', 'No documents saved'),
    item('reservations', 'incomplete', 'No reservations added'),
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  require('../../services/tripIntel.ts').fetchTripReadiness.mockResolvedValue({ state: 'ok', summary: NEW_TRIP });
});

async function mount(props: Partial<React.ComponentProps<typeof TripReadinessCard>> = {}) {
  await render(<TripReadinessCard tripId="trip-new" {...props} />);
  await waitFor(() => expect(screen.getByText('Stay')).toBeTruthy());
}

describe('TripReadinessCard — the missing rows lead somewhere', () => {
  it('F1: every incomplete / action-needed row is a button that reports its category', async () => {
    const onFix = jest.fn();
    await mount({ onFix });
    for (const key of ['stay', 'transport', 'budget', 'entry', 'documents', 'reservations']) {
      await fireEvent.press(screen.getByTestId(`readiness-row-${key}`));
      expect(onFix).toHaveBeenLastCalledWith(key);
    }
    expect(onFix).toHaveBeenCalledTimes(6);
  });

  it('F2: a row the traveller cannot add here says why and is not a button', async () => {
    const onFix = jest.fn();
    await mount({ onFix, unavailable: { reservations: 'Optional — reservations cannot be added in the app yet.', budget: 'Only the trip owner or a co-host can set the budget.' } });
    expect(screen.queryByTestId('readiness-row-reservations')).toBeNull();
    expect(screen.queryByTestId('readiness-row-budget')).toBeNull();
    expect(screen.getByTestId('readiness-note-reservations').props.children).toBe('Optional — reservations cannot be added in the app yet.');
    expect(screen.getByTestId('readiness-note-budget').props.children).toBe('Only the trip owner or a co-host can set the budget.');
    expect(screen.getByTestId('readiness-row-stay')).toBeTruthy();
  });

  it('F3: ready rows stay plain, and without onFix nothing is a button', async () => {
    await mount({ onFix: jest.fn() });
    expect(screen.queryByTestId('readiness-row-plan')).toBeNull();
    await mount();
    expect(screen.queryAllByTestId(/^readiness-row-/)).toHaveLength(0);
  });
});
