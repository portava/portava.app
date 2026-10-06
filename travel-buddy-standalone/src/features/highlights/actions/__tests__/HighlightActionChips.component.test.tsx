/**
 * HighlightActionChips — §12's executable verbs in the Highlight viewer
 * (census-highlights-memories H102).
 *
 * WHAT THIS SUITE PINS
 *   - Only what the server offers is shown; a Highlight with nothing to act on
 *     (sourceless, or a Memory not shared with the viewer) shows nothing.
 *   - A failed read is said, with Try again — not an empty row. That includes a
 *     menu whose venue verbs were refused as could-not-check (verifier finding 4).
 *   - Do this / Add to trip close the viewer and open the SOURCE Memory with the
 *     action to start there; View place opens the CURRENT catalog place; Save
 *     saves the source Memory and says when it could not.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockCloseThenNavigate = jest.fn();
jest.mock('../../../../lib/deferredNavigate.ts', () => ({
  ...jest.requireActual('../../../../lib/deferredNavigate.ts'),
  closeThenNavigate: (...a: unknown[]) => mockCloseThenNavigate(...a),
}));
const mockSave = jest.fn();
jest.mock('../../../../services/memorySocial.ts', () => ({
  ...jest.requireActual('../../../../services/memorySocial.ts'),
  saveMemory: (...a: unknown[]) => mockSave(...a),
}));
const mockGet = jest.fn();
jest.mock('../highlightActionsApi.ts', () => ({
  ...jest.requireActual('../highlightActionsApi.ts'),
  getHighlightActions: (...a: unknown[]) => mockGet(...a),
}));

import { HighlightActionChips } from '../HighlightActionChips.tsx';

const HL = 'aaaaaaaa-0000-4000-8000-00000000000a';
const MEM = '10000000-0000-4000-8000-000000000001';
const PLACE = { id: 'place-now', name: 'Din Tai Fung', category: 'food', address: null, city: 'Taipei', countryCode: 'TW', lat: 25, lng: 121, status: 'active' };
const d = (action: string, available: boolean, reason: string | null = null) => ({ action, available, reason, message: null, caution: null });
const offeredMenu = {
  ok: true,
  menu: {
    highlightId: HL, sourceMemoryId: MEM, place: PLACE,
    actions: [d('DO_THIS', true), d('SAVE', true), d('ADD_TO_TRIP', true), d('VIEW_PLACE', true), d('ASK', true), d('MEET', false, 'CONSUMER_UNAVAILABLE')],
  },
};
const onClose = jest.fn();

beforeEach(() => { for (const m of [mockCloseThenNavigate, mockSave, mockGet, onClose]) m.mockReset(); });

const press = async (id: string) => { await act(async () => { fireEvent.press(screen.getByTestId(id)); }); };

it('shows the offered verbs — ASK stays the viewer\'s reply button and MEET is not shown', async () => {
  mockGet.mockResolvedValueOnce(offeredMenu);
  await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
  for (const a of ['DO_THIS', 'ADD_TO_TRIP', 'VIEW_PLACE', 'SAVE']) expect(await screen.findByTestId(`highlight-action-${a}`)).toBeTruthy();
  expect(screen.queryByTestId('highlight-action-ASK')).toBeNull();
  expect(screen.queryByTestId('highlight-action-MEET')).toBeNull();
});

it('a Highlight with nothing to act on shows nothing — that is the answer, not a failure', async () => {
  mockGet.mockResolvedValueOnce({
    ok: true,
    menu: { highlightId: HL, sourceMemoryId: null, place: null, actions: ['DO_THIS', 'SAVE', 'ADD_TO_TRIP', 'VIEW_PLACE'].map((a) => d(a, false, 'NO_SOURCE_MEMORY')).concat([d('ASK', true)]) },
  });
  await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
  await act(async () => {});
  expect(screen.queryByTestId('highlight-actions')).toBeNull();
  expect(screen.queryByTestId('highlight-actions-error')).toBeNull();
});

it('a failed read is said, with Try again', async () => {
  mockGet.mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: 'x' });
  await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
  expect(await screen.findByTestId('highlight-actions-error')).toBeTruthy();
  mockGet.mockResolvedValueOnce(offeredMenu);
  await press('highlight-actions-retry');
  expect(await screen.findByTestId('highlight-action-DO_THIS')).toBeTruthy();
});

it('FINDING 4: a menu whose venue verbs could not be CHECKED is said with Try again — never drawn as nothing', async () => {
  for (const reason of ['SOURCE_UNREADABLE', 'SOURCE_STORE_UNAVAILABLE', 'PLACE_UNREADABLE', 'PRIVACY_UNREADABLE']) {
    mockGet.mockResolvedValueOnce({
      ok: true,
      menu: { highlightId: HL, sourceMemoryId: null, place: null, actions: ['DO_THIS', 'SAVE', 'ADD_TO_TRIP', 'VIEW_PLACE'].map((a) => d(a, false, reason)).concat([d('ASK', true)]) },
    });
    const r = await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
    expect(await screen.findByTestId('highlight-actions-error')).toBeTruthy();
    mockGet.mockResolvedValueOnce(offeredMenu);
    await press('highlight-actions-retry');
    expect(await screen.findByTestId('highlight-action-DO_THIS')).toBeTruthy();
    await r.unmount();
  }
});

it('FINDING 4: an offered verb next to a could-not-check one shows both the chip and the Try again line', async () => {
  mockGet.mockResolvedValueOnce({
    ok: true,
    menu: { highlightId: HL, sourceMemoryId: MEM, place: null, actions: [d('SAVE', true), d('DO_THIS', false, 'PRIVACY_UNREADABLE'), d('ADD_TO_TRIP', false, 'PRIVACY_UNREADABLE'), d('VIEW_PLACE', false, 'PRIVACY_UNREADABLE')] },
  });
  await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
  expect(await screen.findByTestId('highlight-action-SAVE')).toBeTruthy();
  expect(screen.getByTestId('highlight-actions-unchecked')).toBeTruthy();
});

it('a refusal that is a NO (no shared source) still shows nothing', async () => {
  mockGet.mockResolvedValueOnce({
    ok: true,
    menu: { highlightId: HL, sourceMemoryId: null, place: null, actions: ['DO_THIS', 'SAVE', 'ADD_TO_TRIP', 'VIEW_PLACE'].map((a) => d(a, false, 'NO_SHARED_SOURCE')).concat([d('ASK', true)]) },
  });
  await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
  await act(async () => {});
  expect(screen.queryByTestId('highlight-actions')).toBeNull();
  expect(screen.queryByTestId('highlight-actions-error')).toBeNull();
});

it('Do this and Add to trip close the viewer and open the SOURCE Memory with the action to start', async () => {
  mockGet.mockResolvedValueOnce(offeredMenu);
  await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
  await screen.findByTestId('highlight-action-DO_THIS');
  await press('highlight-action-DO_THIS');
  expect(mockCloseThenNavigate).toHaveBeenLastCalledWith(onClose, { pathname: '/memory/[id]', params: { id: MEM, action: 'DO_AGAIN' } });
  await press('highlight-action-ADD_TO_TRIP');
  expect(mockCloseThenNavigate).toHaveBeenLastCalledWith(onClose, { pathname: '/memory/[id]', params: { id: MEM, action: 'ADD_TO_TRIP' } });
});

it('View place opens the current catalog place', async () => {
  mockGet.mockResolvedValueOnce(offeredMenu);
  await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
  await screen.findByTestId('highlight-action-VIEW_PLACE');
  await press('highlight-action-VIEW_PLACE');
  expect(mockCloseThenNavigate).toHaveBeenCalledWith(onClose, '/place/place-now');
});

it('Save saves the source Memory, and a refused save is said', async () => {
  mockGet.mockResolvedValueOnce(offeredMenu);
  mockSave.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'x' });
  await render(<HighlightActionChips highlightId={HL} onClose={onClose} />);
  await screen.findByTestId('highlight-action-SAVE');
  await press('highlight-action-SAVE');
  expect(mockSave).toHaveBeenCalledWith(MEM);
  expect(await screen.findByTestId('highlight-save-failed')).toBeTruthy();
  mockSave.mockResolvedValueOnce({ ok: true, savedByMe: true });
  await press('highlight-action-SAVE');
  expect(await screen.findByText('Saved')).toBeTruthy();
});
