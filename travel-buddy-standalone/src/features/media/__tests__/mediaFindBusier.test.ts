/**
 * features/media — §15 "Find … Busier" on the client (census-media §36, MD101).
 *
 * The server offers `find_busier` only while `media_find_busier_enabled` is on
 * (migration 3351, seeded OFF). The client renders what the server offers, so
 * what is pinned here is that the rail KNOWS the id: it resolves to the same
 * Compass ask as Find Quieter / Cheaper, carries an icon, and counts as the
 * §45 Media → Compass transition — and that it is never asked an empty question.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveMediaActionExecution, MEDIA_ACTION_IDS } from '../services/mediaActions.ts';
import { mediaActionToNorthStar } from '../telemetry/mediaTelemetry.ts';
import type { MediaAction, MediaEntityRef } from '../types/mediaActions.ts';

const M = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const REFS: MediaEntityRef[] = [
  { kind: 'media', id: M, label: null },
  { kind: 'place', id: P, label: 'An Thuong' },
];

function busier(params: Record<string, unknown>): MediaAction {
  return { id: 'find_busier', label: 'Find somewhere busier', outcome: 'compass', target: { method: 'POST', endpoint: '/api/compass/ask', params } } as MediaAction;
}

test('find_busier is an id the rail knows', () => {
  assert.ok((MEDIA_ACTION_IDS as readonly string[]).includes('find_busier'));
});

test('find_busier → the Compass ask with the server-written prompt, exactly as Find Quieter', () => {
  assert.deepEqual(
    resolveMediaActionExecution(busier({ mediaId: M, prompt: 'Find a busier version of this.', comparator: 'busier' }), REFS),
    { kind: 'compass', mediaId: M, prompt: 'Find a busier version of this.' },
  );
  assert.equal(resolveMediaActionExecution(busier({ mediaId: M }), REFS).kind, 'unsupported', 'no prompt → no row');
});

test('find_busier is the §45 Media → Compass transition', () => {
  assert.equal(mediaActionToNorthStar('find_busier'), 'media_compass');
});

test('the rail has an icon for it (source)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, '..', 'components', 'MediaActionPanels.tsx'), 'utf8');
  assert.match(src, /find_busier: Volume2,/);
});
