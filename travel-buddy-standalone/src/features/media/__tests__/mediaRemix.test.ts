/**
 * features/media — §23.1 "Remix" on the client (census-media MD175, lead ruling D-26h).
 *
 * D-26h: Remix is a Compass variation, "a night like this, elsewhere". The
 * server offers `remix` beside Follow This Night and Save Route, only for a real
 * chain and only with Compass on. The client renders what the server offers, so
 * what is pinned here is that the rail KNOWS the id and dispatches it as the
 * same propose-only Compass ask as Find Quieter: the media id and the
 * server-written prompt, and NOTHING else — in particular no place list of the
 * client's own, because the server attaches the chain through the viewer gate.
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
const PROMPT = 'Remix this night: suggest a night like this one, somewhere else.';
const REFS: MediaEntityRef[] = [
  { kind: 'media', id: M, label: null },
  { kind: 'place', id: P, label: 'An Thuong' },
];

function remix(params: Record<string, unknown>): MediaAction {
  return { id: 'remix', label: 'Remix this night', outcome: 'compass', target: { method: 'POST', endpoint: '/api/compass/ask', params } } as MediaAction;
}

test('remix is an id the rail knows', () => {
  assert.ok((MEDIA_ACTION_IDS as readonly string[]).includes('remix'));
});

test('remix → the Compass ask with the server-written prompt and the media id, nothing more', () => {
  assert.deepEqual(
    resolveMediaActionExecution(remix({ mediaId: M, prompt: PROMPT, placeIds: [P] }), REFS),
    { kind: 'compass', mediaId: M, prompt: PROMPT },
    'a place list in the params is not forwarded: the server owns the chain',
  );
  assert.equal(resolveMediaActionExecution(remix({ mediaId: M }), REFS).kind, 'unsupported', 'no prompt → no row');
});

test('remix is the §45 Media → Compass transition', () => {
  assert.equal(mediaActionToNorthStar('remix'), 'media_compass');
});

test('the rail has an icon for it (source)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, '..', 'components', 'MediaActionPanels.tsx'), 'utf8');
  assert.match(src, /remix: Shuffle,/);
});
