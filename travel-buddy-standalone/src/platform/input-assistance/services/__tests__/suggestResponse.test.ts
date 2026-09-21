/**
 * §41/§57 — the suggest envelope's coercions.
 *
 * These assertions exist because the first attempt at them did NOT work. The
 * `serverMs` handling was inline in `inputAssistance.ts`, and the component
 * test that named it drove a jest MOCK of `requestSuggestions` — so changing
 * `: undefined` to `: 0` left the suite green. The coercion was pulled into a
 * pure module precisely so a mutation to it can be seen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSuggestBody,
  parseServerMs,
  parseSchemaVersion,
  isSchemaCompatible,
} from '../suggestResponse.ts';
import {
  SDK_CAPABILITIES,
  GLOBAL_SEARCH_CAPABILITIES,
  GLOBAL_SEARCH_ACTION_TYPES,
  capabilitySignature,
} from '../../contexts/clientCapabilities.ts';
import { DISPATCHABLE_ACTION_TYPES } from '../../search/smartActions.ts';

test('§57: a server that sends no timing yields NO value, never a fabricated zero', () => {
  // A 0 here is indistinguishable from an instantaneous serve and would drag
  // G372's P95 toward a number nothing measured. MUTATION: return 0 instead of
  // undefined and this goes red.
  assert.equal(parseSuggestBody({ requestId: 'r' }).serverMs, undefined);
  assert.equal(parseServerMs(undefined), undefined);
  assert.equal(parseServerMs(null), undefined);
  assert.equal(parseServerMs('42'), undefined, 'a string is not a measurement');
  assert.equal(parseServerMs(Number.NaN), undefined);
});

test('§57: a real measurement survives, rounded, and an impossible one does not', () => {
  assert.equal(parseServerMs(42), 42);
  assert.equal(parseServerMs(42.6), 43);
  assert.equal(parseServerMs(0), 0, 'a genuinely reported 0 is kept — it is a measurement');
  assert.equal(parseServerMs(-1), undefined, 'negative wall-clock is a clock, not a serve');
  assert.equal(parseServerMs(120_001), undefined, 'beyond the ceiling is a clock, not a serve');
});

test('§41: a missing or malformed envelope degrades to a well-formed empty one', () => {
  const p = parseSuggestBody(undefined);
  assert.equal(p.requestId, '');
  assert.equal(p.policyVersion, null);
  assert.deepEqual(p.suggestions, []);
  assert.equal(p.serverMs, undefined);
  assert.deepEqual(parseSuggestBody({ suggestions: 'not an array' }).suggestions, []);
});

test('§44: requestId is kept verbatim when present and empty when not', () => {
  // '' rather than a placeholder: the hook turns a falsy id into null so a
  // telemetry event says "no serve" instead of joining on an empty string.
  assert.equal(parseSuggestBody({ requestId: 'req-1' }).requestId, 'req-1');
  assert.equal(parseSuggestBody({ requestId: 7 }).requestId, '');
});

// ── §48 the response-schema version (census G341) ────────────────────────────
//
// G341 was BUILT-BUT-WRONG: "the response carries `policyVersion` only. There
// is no independent schema version, so a policy bump and a shape bump are
// indistinguishable to a client."
//
// What is asserted here is the CLIENT's half: the version is read off the
// envelope, and the decision it drives is right at both edges. The edges are
// the point — the obvious wrong implementations are "refuse anything that is
// not exactly mine" (which blacks out every older deployment) and "accept
// anything" (which is the defect).
//
// MUTATION LOG (each applied, watched go red, reverted):
//   - isSchemaCompatible: `return true` → "a NEWER shape is refused" goes red.
//   - isSchemaCompatible: drop the `serverVersion == null` branch → "a serve
//     that sends no schema version is today's serve" goes red.
//   - isSchemaCompatible: `<` instead of `<=` → "the matching shape is
//     accepted" goes red.
//   - parseSchemaVersion: default to 1 instead of null → "junk is not a
//     version" goes red.

test('§48: the schema version is read off the envelope, separately from the policy version', () => {
  const p = parseSuggestBody({ requestId: 'r', policyVersion: 'input-2026-08', schemaVersion: 1 });
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.policyVersion, 'input-2026-08');
  // The two must not be the same field read twice: a policy bump and a shape
  // bump are different events, which is the whole of G341.
  assert.notEqual(String(p.schemaVersion), p.policyVersion);
});

test('§48: a serve that sends no schema version is TODAY\'s serve, not an unknown one', () => {
  assert.equal(parseSuggestBody({ requestId: 'r' }).schemaVersion, null);
  assert.equal(isSchemaCompatible(null, 1), true);
});

test('§48: junk is not a version', () => {
  assert.equal(parseSchemaVersion('2'), null);
  assert.equal(parseSchemaVersion(0), null);
  assert.equal(parseSchemaVersion(-1), null);
  assert.equal(parseSchemaVersion(Number.NaN), null);
  assert.equal(parseSchemaVersion(2.7), 2);
});

test('§48: a NEWER shape is refused; the matching and older ones are accepted', () => {
  // The refusal is what makes the field fall back to its local zero-state
  // (§38) instead of rendering rows out of an envelope it cannot read.
  assert.equal(isSchemaCompatible(2, 1), false, 'a newer server shape must not be rendered');
  assert.equal(isSchemaCompatible(1, 1), true, 'the matching shape is accepted');
  assert.equal(isSchemaCompatible(1, 2), true, 'a newer client still reads an older serve');
  assert.equal(isSchemaCompatible(9, 1), false);
});

// ── §48 the capability declaration (census G343) ─────────────────────────────

test('§48: the global search bar declares LESS than the shared overlay', () => {
  // Not a tautology about two constants: the whole value of the handshake here
  // is that one surface really is narrower than the other. If these ever
  // become equal, the declaration has stopped describing anything.
  assert.ok(GLOBAL_SEARCH_ACTION_TYPES.length > 0);
  // `open_compass` was in this list and has been REMOVED, because §43/G305
  // gave it a dispatch target in the same wave (`app/search.tsx:497`, routing
  // through `prefillMessage`). Leaving it here would have been an assertion
  // that a shipped feature does not exist. `share_entity` and `drop_pin` still
  // genuinely have no target on that screen, so the test still proves the
  // search bar declares LESS than the overlay rather than becoming a tautology.
  for (const dead of ['share_entity', 'drop_pin'] as const) {
    assert.equal(
      GLOBAL_SEARCH_ACTION_TYPES.includes(dead),
      false,
      `${dead} has no dispatch target in the search bar and must not be claimed`,
    );
  }
  // And it claims exactly what the screen resolves, derived from the chip
  // lane's own set rather than restated beside it.
  for (const live of DISPATCHABLE_ACTION_TYPES) {
    assert.ok(GLOBAL_SEARCH_ACTION_TYPES.includes(live), `${live} is dispatchable and must be claimed`);
  }
});

test('§48: two surfaces with different declarations do not share a cache entry', () => {
  // The shared suggestion cache is keyed by (fieldId, text, coords) and knows
  // nothing about capabilities. Without this signature in the key, the narrower
  // surface would hand the wider one a list the server had already thinned.
  assert.notEqual(
    capabilitySignature(SDK_CAPABILITIES),
    capabilitySignature(GLOBAL_SEARCH_CAPABILITIES),
  );
  // An undeclared caller's signature is empty, so its cache key is byte-for-byte
  // what it was before the handshake existed.
  assert.equal(capabilitySignature(null), '');
  assert.equal(capabilitySignature(undefined), '');
  // Order-independent: a declaration is a SET, and a reordered list must not
  // split the cache in two.
  assert.equal(
    capabilitySignature({ schemaVersion: 1, actionTypes: ['submit_search', 'open_entity'] }),
    capabilitySignature({ schemaVersion: 1, actionTypes: ['open_entity', 'submit_search'] }),
  );
});
