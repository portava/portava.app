/**
 * `display_name` is a MANUAL field: no entity suggestions, no assistance.
 *
 * OWNER DECISION, 2026-09-21. The two registries disagreed about this field and
 * the disagreement was not a tuning difference: the SERVER declared it
 * `mode: 'search'` with `allowedSuggestionTypes: ['entity']` over
 * `entityTypes: ['user']`, while the CLIENT declared it `no_assistance` with an
 * empty list. The two sides disagreed about whether the field is assisted AT
 * ALL. The owner ruled it manual, and this pins that ruling on the authority
 * side — the one the gateway actually enforces.
 *
 * WHY THE SERVER'S OLD SHAPE WAS THE WRONG ONE TO KEEP, stated because a later
 * reader will wonder why the more capable side lost. `display_name` is the
 * field on which a person edits THEIR OWN name. Serving it `entity` rows over
 * `entityTypes: ['user']` means typing your own name searches OTHER PEOPLE and
 * offers them back — a people-search mounted on a profile-edit field. Nothing
 * in §23 asks for that, and the client had never surfaced it, so the capability
 * existed on the wire and nowhere else.
 *
 * WHAT `no_assistance` BUYS over merely emptying the type list: the gateway
 * short-circuits on the MODE (`gateway.ts:244`) and returns before any read is
 * issued. An empty type list would still walk the request path and rely on
 * every downstream arm checking its own type gate — one missed check and the
 * field is assisted again.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePolicy } from '../lib/inputAssistance/policyRegistry.js';

describe('§23 — display_name is manual', () => {
  test('the server policy declares no assistance and no suggestion types', () => {
    const p = resolvePolicy('display_name');
    assert.ok(p, 'display_name must still be a KNOWN context — manual is not unregistered');
    assert.equal(p!.mode, 'no_assistance', 'the gateway short-circuits on mode, so mode is what makes it manual');
    assert.deepEqual(p!.allowedSuggestionTypes, [], 'no suggestion types at all');
  });

  test('it offers no ENTITY suggestions, which is the specific thing ruled out', () => {
    const p = resolvePolicy('display_name')!;
    assert.equal(
      p.allowedSuggestionTypes.includes('entity'),
      false,
      'typing your own name must not search other people',
    );
    assert.deepEqual(
      p.entityTypes,
      [],
      'no entity class may be resolved for this field — `user` here meant people-search on a profile-edit field',
    );
  });

  test('the privacy class is unchanged — this narrows behaviour, it does not reclassify the field', () => {
    const p = resolvePolicy('display_name')!;
    assert.equal(p.privacyClass, 'viewer_scoped');
  });

  test('NOT VACUOUS: a comparable search context still carries entity assistance', () => {
    // If this ever goes green alongside the cases above by the registry losing
    // its search contexts wholesale, the assertions above stop meaning anything.
    const u = resolvePolicy('username')!;
    assert.equal(u.mode, 'search');
    assert.ok(u.allowedSuggestionTypes.includes('entity'));
  });
});
