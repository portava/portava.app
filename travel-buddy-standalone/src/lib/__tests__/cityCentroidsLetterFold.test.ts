/**
 * cityCentroidsLetterFold — census-discovery §76 (lane P34): the client's
 * centroid lookup folds letters as the server's search key does.
 *
 * WHAT THE LOOKUP IS FOR. `getCityCentroid` places a Passport memory on the
 * Memories map (`components/passport/memoryViews.buildMemoryMap`), and a
 * memory's city is the free text the traveller typed in the memory modal
 * (`components/MemoriesTab.tsx`, the "City" TextInput). So this fold matches
 * USER TEXT against place names, and the outcome is visible: a pin, or the
 * memory lands in "unplotted".
 *
 * WHAT WAS WRONG. The lookup decomposed (NFD) and stripped marks, then folded
 * six stroke letters (Ł ł Ø ø Đ đ). Every other Latin letter drawn with a
 * stroke, bar, hook or tail has no decomposition and survived the fold whole,
 * so a Turkish keyboard's "ıstanbul" never reached Istanbul. The server's
 * search key has folded all 257 of them since census-discovery §73
 * (`artifacts/api-server/src/lib/latinLetterFold.ts`).
 *
 *   C1  letters outside the old six fold on real city names          (seen RED before §76)
 *   C2  every single-letter entry of the table folds, on a real key   (seen RED before §76)
 *   C3  the Memories map plots a memory typed with such a letter      (seen RED before §76)
 *   C4  controls: the six letters and accents that already folded still do
 *
 * The client table is a copy of the server's, and api-server's
 * `clientLetterFoldParity.test.ts` fails the moment the two differ.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_CENTROIDS, getCityCentroid } from '../cityCentroids.ts';
import { buildMemoryMap } from '../../components/passport/memoryViews.ts';
import type { PassportMemory } from '../../services/passportStamps.ts';

describe('§76 — getCityCentroid folds every stroke/hook/bar letter the server folds', () => {
  it('C1. letters outside the old six reach the city they spell', () => {
    const cases: Array<[typed: string, key: string]> = [
      ['ıstanbul', 'Istanbul'],   // ı: a Turkish keyboard's lowercase I
      ['Reykjavık', 'Reykjavík'], // ı in place of í
      ['Ħanoi', 'Hanoi'],         // Ħ H WITH STROKE
      ['Ƀangkok', 'Bangkok'],     // Ƀ B WITH STROKE
      ['Tbiliſi', 'Tbilisi'],     // ſ LONG S
    ];
    for (const [typed, key] of cases) {
      assert.ok(CITY_CENTROIDS[key], `fixture: ${key} is a centroid key`);
      assert.deepEqual(getCityCentroid(typed), CITY_CENTROIDS[key], `${typed} → ${key}`);
    }
  });

  it('C2. every table letter that folds to one ASCII letter reaches a real key spelled with that letter', async () => {
    const { LATIN_LETTER_FOLD } = await import('../latinLetterFold.ts');
    const plainKeys = Object.keys(CITY_CENTROIDS).filter((k) => /^[A-Za-z ]+$/.test(k));
    const misses: string[] = [];
    for (const [letter, base] of Object.entries(LATIN_LETTER_FOLD)) {
      if (!/^[a-z]$/.test(base)) continue;
      const key = plainKeys.find((k) => k.toLowerCase().includes(base) && getCityCentroid(k.toLowerCase()) !== undefined);
      if (!key) { misses.push(`${letter}: no plain key spelled with ${base}`); continue; } // 245 of 245 have one today
      const i = key.toLowerCase().indexOf(base);
      const typed = key.slice(0, i) + letter + key.slice(i + 1);
      if (getCityCentroid(typed) !== getCityCentroid(key.toLowerCase())) misses.push(`${letter} in ${typed}`);
    }
    assert.deepEqual(misses, [], `${misses.length} letters the server folds did not fold here`);
  });

  it('C3. the Memories map plots a memory whose typed city carries such a letter', () => {
    const memory = {
      id: 'm1', status: 'active', title: 'Ferry', description: null, country: 'Türkiye', city: 'ıstanbul',
      neighborhood: null, category: null, visibility: 'public', verificationLevel: 'none',
      sourceType: null, photoUrl: null, mediaType: null, planId: null, tripId: null,
      suggestionReason: null, earnedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
    } as PassportMemory;
    const out = buildMemoryMap([memory], []);
    assert.equal(out.unplotted.length, 0, 'the memory is not left unplotted');
    assert.equal(out.pins.length, 1);
    assert.deepEqual([out.pins[0].lat, out.pins[0].lng], CITY_CENTROIDS['Istanbul']);
  });

  it('C4. controls: the six stroke letters and the accents still fold as before', () => {
    assert.deepEqual(getCityCentroid('Łódź'), CITY_CENTROIDS['Łódź']);
    assert.deepEqual(getCityCentroid('lodz'), CITY_CENTROIDS['Łódź']);
    assert.deepEqual(getCityCentroid('Đa Nang'), CITY_CENTROIDS['Da Nang']);
    assert.deepEqual(getCityCentroid('bogota'), CITY_CENTROIDS['Bogotá']);
    assert.deepEqual(getCityCentroid('KÖLN'), CITY_CENTROIDS['Köln']);
    assert.equal(getCityCentroid('Atlantis'), undefined, 'an unknown name still resolves to nothing');
  });
});
