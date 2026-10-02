/**
 * §14/§35 (G85) — the Discovery destination picker IS the city picker.
 *
 * The row said city-picker recents were dead because `city_picker` was a
 * registered CONTEXT that no screen in the app ever mounted: §50's field
 * inventory recorded `geo.city` as UNMOUNTED, and `registerGeographicFields()`
 * was called from no non-test file. Both halves are fixed, and these assertions
 * are what would go red if either regressed.
 *
 * This is a STRUCTURAL test on purpose. `DestinationBar` renders a modal that
 * pulls in the whole `GlobalPlacePicker` tree — maps, GPS, network — and a
 * component test of it would prove the picker mounts, not that the declaration
 * is right. What decides G85 is which context the surface declares and whether
 * the platform is registered when it does, and both are readable without a
 * renderer. The behavioural halves (recording on accept, replaying at zero
 * characters) are already proven where they live: `selectionWriterCoverage`
 * enforces the recorder call on every accept handler, and
 * `localZeroState.test.ts` proves the retain/replay contract for a `public`
 * field, which `city_picker` is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GEO_FIELD_IDS } from '../../../platform/input-assistance/geographic/geoFields.ts';
import { getContextDescriptor } from '../../../platform/input-assistance/contexts/inputContexts.ts';
import {
  sharedPolicyStore,
  _seedPolicyForTests,
} from '../../../platform/input-assistance/services/policyStore.ts';

const ROOT = join(import.meta.dirname, '../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('G85: the Discovery destination picker declares the city_picker context', () => {
  const src = read('src/components/discovery/DestinationBar.tsx');

  // MUTATION-PROOF: drop either prop and this goes RED. Without them
  // GlobalPlacePicker falls back to the `__geo_no_assist__` fieldId and the
  // platform is off for this surface entirely — which is the state G85 named.
  assert.ok(
    /assistContext=("|')city_picker\1/.test(src),
    'DestinationBar must declare assistContext="city_picker"',
  );
  assert.ok(
    /assistFieldId=\{GEO_FIELD_IDS\.cityPicker\}/.test(src),
    'DestinationBar must pass the canonical geo.city fieldId, not a hand-typed string',
  );
  assert.equal(GEO_FIELD_IDS.cityPicker, 'geo.city');
});

test('G85: the geographic field registry is installed at app boot', () => {
  const layout = read('app/_layout.tsx');

  // The registry is what makes `geo.city` resolve its REGISTERED policy rather
  // than a default rebuilt from the context descriptor. MUTATION-PROOF: remove
  // the mount or the call and this goes RED.
  assert.ok(
    /registerGeographicFields\(\)/.test(layout),
    'app/_layout.tsx must call registerGeographicFields()',
  );
  assert.ok(
    /<GeographicFieldsSetup \/>/.test(layout),
    'the setup component must actually be mounted in the tree, not merely declared',
  );
});

test('G85: the row reads its three preconditions from the AUTHORITY, and they can fail', () => {
  // ── REWRITTEN 2026-09-21 (G340) ──────────────────────────────────────────
  //
  // This used to read `getContextDescriptor('city_picker')` and assert
  // `allowPersonalization === true` etc. against the client's local table.
  // That table is gone, and the assertion could not survive the move: the
  // client no longer HAS an opinion about what `city_picker` permits, so a
  // client-side test asserting those values would only be checking a fixture
  // it seeded itself.
  //
  // The check was worth keeping, so it was SPLIT rather than deleted:
  //   • the server now asserts the real values — `city_picker` genuinely
  //     carries them in the authority — in
  //     `artifacts/api-server/src/test/displayNameManual.test.ts`;
  //   • this side asserts what is actually the client's job, which is that the
  //     row reads those three from the authority and REACTS when they change.
  //
  // The second half is what a fixture-only assertion would have missed, and it
  // is the failure G85's original comment was worried about: "a surface that
  // looks wired and records nothing".
  _seedPolicyForTests(['city_picker'], {
    city_picker: { allowPersonalization: true, zeroStateAssistance: true, privacyClass: 'public' },
  });
  const permitted = getContextDescriptor('city_picker');
  assert.equal(permitted.allowPersonalization, true, 'recents require personalization');
  assert.equal(permitted.zeroStateAssistance, true, 'the zero-character state must be served');
  assert.equal(permitted.privacyClass, 'public', 'a public list is the only kind the local buffer may retain');
  assert.equal(permitted.authoritative, true);

  // NON-VACUITY: an authority that withdraws them is reflected, not ignored.
  // Without this, the block above would pass against any seed at all.
  _seedPolicyForTests(['city_picker'], {
    city_picker: { allowPersonalization: false, zeroStateAssistance: false, privacyClass: 'viewer_scoped' },
  });
  const withdrawn = getContextDescriptor('city_picker');
  assert.equal(withdrawn.allowPersonalization, false);
  assert.equal(withdrawn.zeroStateAssistance, false);
  assert.equal(withdrawn.privacyClass, 'viewer_scoped');

  // And with NO authority at all, the row gets none of the three.
  sharedPolicyStore.clear();
  sharedPolicyStore.setActiveAccount(null);
  const cold = getContextDescriptor('city_picker');
  assert.equal(cold.allowPersonalization, false, 'a cold start must not grant personalization');
  assert.equal(cold.zeroStateAssistance, false);
  assert.notEqual(cold.privacyClass, 'public', 'a cold start must not make the field cacheable');
});
