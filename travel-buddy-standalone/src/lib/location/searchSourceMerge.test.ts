/**
 * City autocomplete source selection.
 *
 * The bug: GlobalPlacePicker merged Google's autocomplete with /places/search
 * on every keystroke. /places/search fans out to Nominatim, a geocoder rather
 * than an autocomplete, which answers partial city names erratically —
 * measured on production, `Bangkok` returned 1, `Bangko` returned 7 and
 * `bangk` returned 0. So rows appeared, vanished at the next keystroke and
 * came back at the one after, which a user reads as "it does not autocomplete".
 *
 * The rule under test: in city mode Google is the source and the fallback runs
 * ONLY on empty, never merged. A fallback on empty cannot remove rows that
 * were already on screen; a merge can.
 *
 * Run: node --import tsx/esm --test src/lib/location/searchSourceMerge.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectSearchRows } from './searchSourceMerge.ts';

const g = (id: string, displayName: string) => ({ id, displayName });

const GOOGLE = [g('google-1', 'Bangkok, Thailand'), g('google-2', 'Bangkinang, Indonesia')];
const NOMINATIM = [g('nom-1', 'ATM Bangk BRI, Kampar'), g('nom-2', 'Bangkok, Thailand')];

describe('city mode — Google is the source', () => {
  it('shows ONLY Google rows when Google has results', () => {
    const sel = selectSearchRows({ googlePlaces: GOOGLE, searchResults: NOMINATIM, cityMode: true });
    assert.equal(sel.source, 'google');
    assert.deepEqual(sel.rows.map((r) => r.id), ['google-1', 'google-2']);
    assert.equal(sel.showGoogleAttribution, true);
  });

  it('does NOT backfill — the merge is what produced the blink', () => {
    const sel = selectSearchRows({ googlePlaces: GOOGLE, searchResults: NOMINATIM, cityMode: true });
    assert.equal(
      sel.rows.some((r) => r.id.startsWith('nom-')),
      false,
      'a Nominatim row alongside Google is exactly what disappears at the next keystroke',
    );
  });

  it('falls back to /places/search ONLY when Google returns nothing', () => {
    const sel = selectSearchRows({ googlePlaces: [], searchResults: NOMINATIM, cityMode: true });
    assert.equal(sel.source, 'fallback');
    assert.deepEqual(sel.rows.map((r) => r.id), ['nom-1', 'nom-2']);
    assert.equal(sel.showGoogleAttribution, false, 'no Google rows, no Google attribution');
  });

  it('both empty yields no rows and no attribution', () => {
    const sel = selectSearchRows({ googlePlaces: [], searchResults: [], cityMode: true });
    assert.deepEqual(sel.rows, []);
    assert.equal(sel.showGoogleAttribution, false);
  });

  it('the fallback cannot SUBTRACT rows that Google already supplied', () => {
    // The property that makes a fallback-on-empty safe where a merge is not:
    // whenever Google has rows, the output contains all of them, whatever the
    // fallback returned or failed to return this keystroke.
    for (const searchResults of [[], NOMINATIM, [g('x', 'Somewhere else')]]) {
      const sel = selectSearchRows({ googlePlaces: GOOGLE, searchResults, cityMode: true });
      assert.deepEqual(
        sel.rows.map((r) => r.id),
        ['google-1', 'google-2'],
        'Google rows must be stable regardless of what the other provider did',
      );
    }
  });
});

describe('non-city mode — the additive merge is unchanged', () => {
  it('shows Google first, then backfills with the other provider', () => {
    const sel = selectSearchRows({
      googlePlaces: [g('google-1', 'Blue Bottle Coffee')],
      searchResults: [g('nom-1', 'Blue Bottle Coffee'), g('nom-2', 'Hotel Okura')],
      cityMode: false,
    });
    assert.equal(sel.source, 'merged');
    assert.deepEqual(sel.rows.map((r) => r.id), ['google-1', 'nom-2']);
  });

  it('de-duplicates by display name, case-insensitively', () => {
    const sel = selectSearchRows({
      googlePlaces: [g('google-1', 'Hotel Okura')],
      searchResults: [g('nom-1', 'HOTEL OKURA')],
      cityMode: false,
    });
    assert.equal(sel.rows.length, 1, 'the same place from two providers is offered once');
    assert.equal(sel.rows[0]!.id, 'google-1', 'Google wins the duplicate');
  });

  it('still falls back when Google is empty', () => {
    const sel = selectSearchRows({
      googlePlaces: [],
      searchResults: [g('nom-1', 'Hotel Okura')],
      cityMode: false,
    });
    assert.equal(sel.source, 'fallback');
    assert.deepEqual(sel.rows.map((r) => r.id), ['nom-1']);
  });
});

describe('the picker uses the selector rather than merging inline', () => {
  it('GlobalPlacePicker calls selectSearchRows and does not rebuild the merge', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(import.meta.dirname, '../../components/selectors/GlobalPlacePicker.tsx'),
      'utf8',
    );
    assert.match(src, /selectSearchRows\(\{ googlePlaces, searchResults, cityMode \}\)/);
    assert.doesNotMatch(
      src,
      /googleDescriptions/,
      'the inline merge must be gone, not merely bypassed — a second copy would drift',
    );
  });
});
