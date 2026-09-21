/**
 * M263 — the §35 `why_shown_opened` emitter must USE the panel-derived payload.
 *
 * `whyShownOpened.ts` and `whyShownOpened.test.ts` already prove that
 * `whyShownOpenedPayload` agrees with the panel `WhyShownSheet` renders, and
 * that the shipped expression does not. Neither of them proves the emitter
 * CALLS it. census-map §42.3 records exactly that gap:
 *
 *   "It is not wired, and the row stays W. The emitter is in
 *    `app/map/index.tsx`, outside the Map lane's paths."
 *
 * A correct helper nobody calls is a correct helper nobody calls. The defect
 * — every synthesised §9 panel reporting `lineCount: 0`, on the objects whose
 * explanation Portava built for itself — is live for as long as the call site
 * restates the rule instead of importing it.
 *
 * ## Why this reads source text rather than rendering the screen
 *
 * The emit is an inline arrow in a JSX prop on a 3000-line screen component,
 * reachable only by mounting the whole map. The property being pinned is not
 * "the sheet works", it is "this one payload is computed in one place", and
 * that is a fact about the call site. A structural assertion states it
 * directly; a render test would state it by accident, through six layers that
 * can each break for unrelated reasons.
 *
 * ## Anti-vacuity
 *
 * Both halves are asserted, because either alone is satisfiable without the
 * fix: the emitter must CALL the helper, and it must no longer CONTAIN the
 * naive expression. Adding the call while leaving the old fields in place
 * produces a payload whose `lineCount` is whichever key wins — which is the
 * shape a hurried merge produces. The file is also proved to contain the
 * emitter at all, so a renamed or moved screen fails loudly instead of
 * passing on an empty search.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dir, '../../../../..');
const MAP_SCREEN = resolve(APP_ROOT, 'app/map/index.tsx');

const src = readFileSync(MAP_SCREEN, 'utf8');

describe('M263 — why_shown_opened is wired to the panel-derived payload', () => {
  test('the map screen really is the emitter (anti-vacuity)', () => {
    assert.match(
      src,
      /emitMapEvent\(\s*'why_shown_opened'/,
      'app/map/index.tsx no longer emits why_shown_opened — this guard is pointed at the wrong file',
    );
  });

  test('it imports the helper', () => {
    assert.match(
      src,
      /import\s*\{[^}]*\bwhyShownOpenedPayload\b[^}]*\}\s*from\s*['"][^'"]*whyShownOpened(\.ts)?['"]/,
      'the payload rule must be imported, not restated',
    );
  });

  test('the emit calls whyShownOpenedPayload', () => {
    const emit = src.match(/emitMapEvent\(\s*'why_shown_opened',([\s\S]*?)\);/);
    assert.ok(emit, 'could not read the why_shown_opened emit');
    assert.match(
      emit![1],
      /whyShownOpenedPayload\s*\(/,
      'the emit must hand the panel-derived payload straight through',
    );
  });

  test('the naive expression is gone from the emit', () => {
    // `obj.provenance?.lines.length ?? 0` reports ZERO for every synthesised
    // panel, and the synthesised panel is the common case.
    const emit = src.match(/emitMapEvent\(\s*'why_shown_opened',([\s\S]*?)\);/);
    assert.ok(emit);
    assert.doesNotMatch(
      emit![1],
      /provenance\?\.lines\.length/,
      'the emit still computes lineCount from the raw object',
    );
    assert.doesNotMatch(
      emit![1],
      /sourceRefs/,
      'the emit still sends the object’s sourceRefs, which the panel never showed',
    );
  });
});
