/**
 * StampShowcaseCurationSheet — direct component tests
 *
 * Covers save, failure revert, and stamp selection/deselection.
 * Separated from StampShowcase.component.test.tsx to satisfy the two-file
 * Modal rule (see .agents/memory/modal-proxy-mock.md).
 *
 * Uses ONE `await render()` call with act-wrapped presses
 * (`await act(async () => { fireEvent.press(...) })`).  Act-wrapping is
 * required in Modal-proxy files — bare presses don't commit state updates.
 * Post-press standalone `await act()` flushes are avoided because they poison
 * later press dispatch (see .agents/memory/rntl-react19-renderer-budget.md §73).
 *
 * Queries use `view.getByRole` (render-bound), not `screen`, because the shared
 * screen global can go stale after synchronous state updates in Modal-proxy
 * components (React 19 + RNTL v14 limitation).
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render, fireEvent } from '@testing-library/react-native';
import { StampShowcaseCurationSheet } from '../stamps/StampShowcaseCurationSheet.tsx';

// ── react-native Modal / ActivityIndicator proxy ───────────────────────────────
// NOTE: intentionally exhaustive — Modal's animation lifecycle leaves floating
// async act() scopes that corrupt the RNTL screen global. ActivityIndicator
// must also be stubbed because its getter reads `this.NativeModules` through
// the Proxy context and can reach uninitialized native stubs (React 19 rolls
// back silently). See .agents/memory/modal-proxy-mock.md for full rationale.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockSaveShowcase = jest.fn();

// NOTE: intentionally exhaustive — stampShowcase imports Supabase/apiToken stack;
// requireActual would pull in the live network graph.
jest.mock('../../services/stampShowcase', () => ({
  getMyShowcase: jest.fn().mockResolvedValue(null),
  saveShowcase: (...args: unknown[]) => mockSaveShowcase(...args),
  MAX_SHOWCASE: 8,
}));

// NOTE: intentionally exhaustive — passportStampMappers imports stamp type helpers
// that pull in native modules under jest-expo; only toLegacyStamp is used here.
jest.mock('../../services/passportStampMappers', () => ({
  toLegacyStamp: (s: any) => ({
    id: s.id,
    label: s.titleOverride ?? s.definition?.name ?? s.id,
    kind: 'city',
    rarity: s.definition?.rarity ?? 'common',
    locked: false,
  }),
}));

// NOTE: intentionally exhaustive — apiToken imports Supabase auth bindings.
jest.mock('../../services/apiToken', () => ({
  freshToken: jest.fn().mockResolvedValue(null),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStamp(id: string, name = `Stamp ${id}`) {
  return {
    id,
    stampType: 'location',
    city: 'Lisbon',
    country: 'Portugal',
    // `as const` so the literal narrows to StampVisibility rather than widening
    // to `string`, which PassportStampNew does not accept.
    visibility: 'public' as const,
    isRevoked: false,
    earnedAt: '2026-07-01T00:00:00Z',
    activeArtworkUrl: null,
    titleOverride: null,
    definition: {
      slug: `slug-${id}`, name, rarity: 'common' as const,
      stampType: 'location', category: 'location',
      universalArtworkUrl: null, iconUrl: null, description: null,
    },
    stampDefinitionId: `def-${id}`, neighborhood: null, placeId: null,
    planId: null, tripId: null, sourceType: 'system',
    verificationLevel: 'verified', displayOnPassport: true,
    catalogId: null, createdAt: '2026-07-01T00:00:00Z',
  };
}

const STAMPS = [makeStamp('s1', 'Alpha'), makeStamp('s2', 'Beta'), makeStamp('s3', 'Gamma')];

// ── Single-render test ────────────────────────────────────────────────────────
//
// All scenarios run in ONE render. Each press is act-wrapped to commit the state
// update (required for Modal-proxy files, see memory notes at top of file).
// Visual assertions are only made after presses whose commits are within budget;
// mock call-count assertions work regardless of visual commit status.

describe('StampShowcaseCurationSheet — save / select / revert (one render)', () => {
  it('select adds, deselect removes, save dispatches IDs; save reverts on false', async () => {
    // Scenario sequence (single render, currentIds=['s1']):
    //   1. Initial state: Alpha selected, Beta+Gamma unselected.
    //   2. Act-wrap press Add Beta → sel: [s1, s2]; assert visual (press budget #1)
    //   3. Act-wrap press Remove Alpha → sel: [s2] (visual commit may stall; ok)
    //   4. Act-wrap press Save (returns false) → assert mock args + onSaved NOT called
    //   5. Act-wrap press Save (returns true) → assert mock args + onSaved called
    //
    // Save arg assertions cover the select/deselect wiring even when visual
    // commits stall after press #1 (dispatch remains synchronous per rule 26).

    mockSaveShowcase
      .mockResolvedValueOnce(false)  // First save: failure/revert
      .mockResolvedValueOnce(true);  // Second save: success

    const onSaved = jest.fn();
    const onClose = jest.fn();

    // await render() is required in this RNTL setup (see rntl-async-render.md).
    const view = await render(
      <StampShowcaseCurationSheet
        visible
        stamps={STAMPS}
        currentIds={['s1']}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    await act(async () => {});

    // Initial state: Alpha selected, Beta and Gamma unselected.
    expect(view.getByRole('checkbox', { name: /remove Alpha from showcase/i })).toBeTruthy();
    expect(view.getByRole('checkbox', { name: /add Beta to showcase/i })).toBeTruthy();

    // ── Press #1: Add Beta (act-wrapped — commits visual update) ─────────────
    await act(async () => {
      fireEvent.press(view.getByRole('checkbox', { name: /add Beta to showcase/i }));
    });
    // Visual commit #1: Beta now in selected section.
    expect(view.getByRole('checkbox', { name: /remove Beta from showcase/i })).toBeTruthy();

    // ── Press #2: Remove Alpha (act-wrapped) ──────────────────────────────────
    // Dispatch is synchronous so sel becomes ['s2']; visual commit may stall (budget).
    await act(async () => {
      fireEvent.press(view.getByRole('checkbox', { name: /remove Alpha from showcase/i }));
    });

    // ── Press #3: Save → returns false (revert) ───────────────────────────────
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: /save showcase/i }));
    });
    // sel=['s2'] at dispatch time → saveShowcase called with ['s2'].
    expect(mockSaveShowcase).toHaveBeenNthCalledWith(1, ['s2']);
    // Save returned false → callers must not fire.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // ── Press #4: Save → returns true ────────────────────────────────────────
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: /save showcase/i }));
    });
    // sel unchanged after failure → still ['s2'].
    expect(mockSaveShowcase).toHaveBeenNthCalledWith(2, ['s2']);
    expect(onSaved).toHaveBeenCalledWith(['s2']);
    expect(onClose).toHaveBeenCalled();
  });
});
