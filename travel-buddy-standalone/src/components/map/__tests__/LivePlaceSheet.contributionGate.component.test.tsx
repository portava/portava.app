/**
 * LivePlaceSheet — §22 capture affordances are hidden when capture is OFF.
 *
 * ## The defect
 *
 * `map_contributions_enabled` is seeded OFF (2216_map_observations.sql) and
 * capture additionally requires `intel_capture_quick_signal`, yet this sheet
 * offered both §22 entry points unconditionally:
 *
 *   1. the "…. Add what you see?" prompt, rendered wherever a §8 section could
 *      not be built on a `contributable` object; and
 *   2. the `Report` button in the ACTIONS row, which on a contributable object
 *      means "report what is here", not moderation.
 *
 * Both land on `POST /api/map/observations`, which with the flag off answers
 * HTTP 200 `{ ok: true, accepted: 0, enabled: false }` — so the user was asked a
 * question, answered it, and only THEN told the answer was discarded.
 *
 * ## Why the REAL component, not a stub
 *
 * The two affordances are rendered here, by this file, from `vm.actions` and
 * `canContribute`. A stub would assert that the map screen passes a prop, which
 * is exactly the thing that can be true while the buttons still render. So this
 * renders `LivePlaceSheet` itself and reads the tree.
 *
 * ## Why the flag-ON cases are here too
 *
 * Anti-vacuity. Without them, every OFF assertion is satisfiable by deleting
 * §22 from the sheet entirely, or by handing it a fixture that never reaches
 * the branch at all. The ON cases prove the fixture DOES reach it.
 */
import React from 'react';
import { Dimensions } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { LivePlaceSheet } from '../LivePlaceSheet.tsx';
import { point, type MapObject } from '../../../types/mapObjects.ts';

/**
 * PRE-EXISTING, UNRELATED, AND DELIBERATELY NOT FIXED HERE.
 *
 * The sheet's scrim reads `translateY.interpolate({ inputRange: [offsetFor
 * ('half'), offsetFor('full')] })`, and `offsetFor(p) = sheetH - screenH *
 * FRACTION[p]`, so for ANY positive screen height that range is [0.42H, 0] —
 * decreasing. React Native validates interpolation ranges only under `__DEV__`
 * (AnimatedInterpolation's constructor), which is why nothing has caught it:
 * production skips the check, and every other test in this repo stubs
 * `LivePlaceSheet` out entirely.
 *
 * Pinning the window to zero height makes both ends of that range 0 — equal,
 * which the validator accepts — so the REAL component can be rendered. Layout
 * has no bearing on what this file asserts: React Native Testing Library builds
 * the element tree without a layout pass, so every child is present and
 * queryable at any size.
 *
 * The inverted range is a separate defect and is reported separately; fixing it
 * here would mean this change could no longer be mutation-proven on its own.
 */
beforeAll(() => {
  jest
    .spyOn(Dimensions, 'get')
    .mockReturnValue({ width: 390, height: 0, scale: 2, fontScale: 1 });
});

afterAll(() => {
  jest.restoreAllMocks();
});

// NOTE: intentional stub — safe-area insets are irrelevant to what is rendered
// here, and the real provider is not mounted in this test's tree.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// §35 emits. Everything else in the module stays real; only the recording point
// is a double, so opening the sheet does not try to reach a transport.
jest.mock('../../../features/map/telemetry/mapTelemetry', () => ({
  ...jest.requireActual('../../../features/map/telemetry/mapTelemetry'),
  emitMapEvent: jest.fn(),
}));

/**
 * A contributable place with NO observed activity — so `live_state` is a
 * missing section and the §22 prompt is the thing that fills its slot — and
 * with `report` among its actions, which on a contributable object is the
 * capture entry point rather than a moderation one.
 */
const CONTRIBUTABLE_PLACE: MapObject = {
  id: 'place:p1',
  kind: 'place',
  geometry: point(16.05, 108.22),
  title: 'Cong Caphe',
  privacyClass: 'place_level',
  renderingPriority: 50,
  interaction: {
    actions: ['view', 'report'],
    detailRoute: '/place/p1',
    opensSheet: true,
    contributable: true,
  },
};

/**
 * A buddy LISTING. `report` here is MODERATION — a different flow, behind no
 * flag — and it must survive the §22 gate untouched.
 */
const MODERATABLE_LISTING: MapObject = {
  id: 'buddy:b7',
  kind: 'buddy_zone',
  geometry: point(16.06, 108.21),
  title: 'Marco',
  privacyClass: 'approximate',
  renderingPriority: 30,
  interaction: {
    actions: ['view', 'report'],
    detailRoute: '/(rent-a-buddy)/buddy/b7',
    opensSheet: true,
  },
};

async function renderSheet(object: MapObject, contributionsEnabled: boolean) {
  return render(
    <LivePlaceSheet
      object={object}
      contributionsEnabled={contributionsEnabled}
      onClose={() => {}}
      onAction={() => {}}
      onContribute={() => {}}
    />,
  );
}

describe('LivePlaceSheet — §22 capture is OFF', () => {
  it('does not offer the "Add what you see?" prompt', async () => {
    await renderSheet(CONTRIBUTABLE_PLACE, false);
    expect(screen.queryByText(/Add what you see\?/)).toBeNull();
  });

  it('does not render Report on a contributable object', async () => {
    // Pre-fix this button existed, was tappable, and led to a 200 that recorded
    // nothing. A silent no-op affordance is worse than no affordance.
    await renderSheet(CONTRIBUTABLE_PLACE, false);
    expect(screen.queryByLabelText('Report')).toBeNull();
  });

  it('still renders the object’s other actions', async () => {
    // The gate removes ONE action, not the ACTIONS block. If View disappeared
    // too, the sheet would be broken rather than gated.
    await renderSheet(CONTRIBUTABLE_PLACE, false);
    expect(screen.getByLabelText('View')).toBeTruthy();
  });

  it('leaves MODERATION reporting alone', async () => {
    // A buddy listing is not contributable: its Report is the abuse queue,
    // which is behind no flag and must never be switched off by this gate.
    await renderSheet(MODERATABLE_LISTING, false);
    expect(screen.getByLabelText('Report')).toBeTruthy();
  });
});

describe('LivePlaceSheet — §22 capture is ON', () => {
  it('offers the "Add what you see?" prompt', async () => {
    // Anti-vacuity for the OFF case above: proves this fixture really does
    // reach the ContributePrompt branch.
    await renderSheet(CONTRIBUTABLE_PLACE, true);
    expect(screen.getByText(/Add what you see\?/)).toBeTruthy();
  });

  it('renders Report on a contributable object', async () => {
    await renderSheet(CONTRIBUTABLE_PLACE, true);
    expect(screen.getByLabelText('Report')).toBeTruthy();
  });
});

describe('LivePlaceSheet — §22 fails closed', () => {
  it('hides both affordances when the caller says nothing about the flag', async () => {
    // A caller that has not thought about the flag has not established that a
    // contribution can reach storage. Absent must never read as permitted.
    await render(
      <LivePlaceSheet object={CONTRIBUTABLE_PLACE} onClose={() => {}} onAction={() => {}} />,
    );
    expect(screen.queryByText(/Add what you see\?/)).toBeNull();
    expect(screen.queryByLabelText('Report')).toBeNull();
  });
});
