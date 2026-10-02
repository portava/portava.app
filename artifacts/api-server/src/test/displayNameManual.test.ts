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
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePolicy, KNOWN_CONTEXTS } from '../lib/inputAssistance/policyRegistry.js';

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

// ── ADDED 2026-09-21 by G340 ─────────────────────────────────────────────────
//
// The client used to assert some of these against its own local table. That
// table is gone (G340: the client resolves from `GET /input-assistance/
// policies`), so a client-side assertion about what a context PERMITS can only
// check a fixture the client seeded itself. The values are this side's to
// state, so the assertions moved here, where the real registry is.
//
// `DestinationBar.cityPicker.test.ts` keeps the other half — that the row reads
// these from the authority and reacts when they change.
describe('G340 — the values the client can no longer assert for itself', () => {
  it('G85: city_picker really does permit what the Destination row needs', () => {
    const p = resolvePolicy('city_picker');
    assert.ok(p, 'city_picker must exist in the authority');
    assert.equal(p!.allowPersonalization, true, 'the recents row requires personalization');
    assert.equal(p!.zeroStateAssistance, true, 'the zero-character state must be served');
    assert.equal(
      p!.privacyClass,
      'public',
      'a public list is the only kind the client may retain in its process-global cache',
    );
  });

  it('display_name stays manual once the endpoint is the only thing the client reads', () => {
    // The whole point of G340 is that the client stopped keeping its own copy.
    // So this is now the ONLY place the ruling lives, and it is what every
    // client will be handed.
    const p = resolvePolicy('display_name');
    assert.ok(p);
    assert.equal(p!.mode, 'no_assistance');
    assert.deepEqual(p!.allowedSuggestionTypes, []);
    assert.deepEqual(p!.entityTypes, [], 'a profile-edit field must not search other people');
    assert.equal(p!.zeroStateAssistance, false, 'and it offers nothing at zero characters either');
  });

  it('every context the endpoint serves carries a zeroStateAssistance boolean', () => {
    // It moved here from the client in G340. A context that silently lacked it
    // would be served `undefined`, which the client narrows to `false` — safe,
    // but it would silently disable a zero-state the authority meant to grant.
    const missing = KNOWN_CONTEXTS.filter(
      (c) => typeof resolvePolicy(c)?.zeroStateAssistance !== 'boolean',
    );
    assert.deepEqual(missing, [], `contexts missing zeroStateAssistance: ${missing.join(', ')}`);

    // Non-vacuity: it is not uniformly false.
    const on = KNOWN_CONTEXTS.filter((c) => resolvePolicy(c)?.zeroStateAssistance === true);
    assert.ok(on.length >= 10, `expected many zero-state contexts, got ${on.length}`);
  });
});
