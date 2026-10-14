/**
 * memoryCanonical / MemoryTypePicker — the app's half of census-highlights-
 * memories H40 (§4 MemoryType) and H71 (§9 occurrence-time place text).
 *
 * Pins:
 *   - GET /api/memory-types: `enabled` only from a well-formed 200; a 503 or a
 *     malformed body is NOT "enabled: false" but a failed check (ok: false);
 *     an unknown type name is dropped, never offered;
 *   - the picker renders NOTHING unless the server said enabled (and nothing on
 *     a failed check), so the composer cannot offer a choice the server refuses;
 *   - a chosen chip can be cleared; "not chosen" on create names the default;
 *   - the place line leads with the occurrence-time name when served and is the
 *     old city/country line otherwise.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../../../../services/apiToken.ts', () => ({
  freshToken: () => Promise.resolve('tok'),
}));

import {
  fetchMemoryTypes, memoryPlaceLine, occurrenceNameOfPick, MEMORY_TYPES, MEMORY_TYPE_LABELS,
} from '../memoryCanonical.ts';
import { MemoryTypePicker } from '../MemoryTypePicker.tsx';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
function respond(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}
beforeEach(() => { calls = []; process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('fetchMemoryTypes', () => {
  it('reads enabled, the types and the default from GET /api/memory-types, authenticated', async () => {
    respond(200, { enabled: true, types: [...MEMORY_TYPES], defaultType: 'MOMENT' });
    const r = await fetchMemoryTypes();
    expect(r).toEqual({ ok: true, enabled: true, types: [...MEMORY_TYPES], defaultType: 'MOMENT' });
    expect(calls[0]!.url).toBe('https://api.test/api/memory-types');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('a 503 is a failed check, not "disabled"', async () => {
    respond(503, { error: 'degraded_unavailable', message: 'Memory types could not be checked right now.' });
    expect(await fetchMemoryTypes()).toEqual({ ok: false, message: 'Memory types could not be checked right now.' });
  });
  it('a malformed 200 is a failed check; an unknown type name is dropped', async () => {
    respond(200, { enabled: 'yes', types: [] });
    expect((await fetchMemoryTypes()).ok).toBe(false);
    respond(200, { enabled: true, types: ['PLACE', 'VACATION'], defaultType: 'NOPE' });
    expect(await fetchMemoryTypes()).toEqual({ ok: true, enabled: true, types: ['PLACE'], defaultType: null });
  });
});

describe('memoryPlaceLine / occurrenceNameOfPick', () => {
  it('leads with the occurrence-time name when served; the old line otherwise', () => {
    expect(memoryPlaceLine({ placeDisplayNameAtOccurrence: 'Cafe A', locationCity: 'Hanoi', locationCountry: 'Vietnam' })).toBe('Cafe A · Hanoi, Vietnam');
    expect(memoryPlaceLine({ locationCity: 'Hanoi', locationCountry: 'Vietnam' })).toBe('Hanoi, Vietnam');
    expect(memoryPlaceLine({ placeDisplayNameAtOccurrence: null, locationCity: 'Hanoi', locationCountry: null })).toBe('Hanoi');
    expect(memoryPlaceLine({ placeDisplayNameAtOccurrence: 'Hanoi', locationCity: 'Hanoi', locationCountry: null })).toBe('Hanoi');
    expect(memoryPlaceLine({ placeDisplayNameAtOccurrence: 'Cafe A' })).toBe('Cafe A');
  });
  it("the pick's own name, else its display name; never an empty string", () => {
    expect(occurrenceNameOfPick({ name: ' Pho 10 ', displayName: 'Pho 10, Hanoi' })).toBe('Pho 10');
    expect(occurrenceNameOfPick({ name: '', displayName: 'Hanoi, Vietnam' })).toBe('Hanoi, Vietnam');
    expect(occurrenceNameOfPick({ name: '  ', displayName: '' })).toBeNull();
    expect(occurrenceNameOfPick(null)).toBeNull();
  });
});

describe('MemoryTypePicker', () => {
  it('renders nothing while the server has types off', async () => {
    respond(200, { enabled: false, types: [...MEMORY_TYPES], defaultType: 'MOMENT' });
    await render(<MemoryTypePicker value={null} onChange={() => {}} mode="create" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('memory-type-picker')).toBeNull();
  });
  it('renders nothing when the check fails', async () => {
    respond(503, { error: 'degraded_unavailable' });
    await render(<MemoryTypePicker value={null} onChange={() => {}} mode="create" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('memory-type-picker')).toBeNull();
  });
  it('offers every type when enabled; a press chooses, a second press clears; "not chosen" names the default', async () => {
    respond(200, { enabled: true, types: [...MEMORY_TYPES], defaultType: 'MOMENT' });
    const onChange = jest.fn();
    const utils = await render(<MemoryTypePicker value={null} onChange={onChange} mode="create" />);
    expect(await screen.findByTestId('memory-type-picker')).toBeTruthy();
    for (const t of MEMORY_TYPES) expect(screen.getByLabelText(MEMORY_TYPE_LABELS[t])).toBeTruthy();
    expect(screen.getByTestId('memory-type-hint').props.children).toBe('Not chosen: it will be saved as Moment.');
    await fireEvent.press(screen.getByTestId('memory-type-REUNION'));
    expect(onChange).toHaveBeenLastCalledWith('REUNION');
    await utils.rerender(<MemoryTypePicker value="REUNION" onChange={onChange} mode="create" />);
    expect(screen.queryByTestId('memory-type-hint')).toBeNull();
    await fireEvent.press(screen.getByTestId('memory-type-REUNION'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
