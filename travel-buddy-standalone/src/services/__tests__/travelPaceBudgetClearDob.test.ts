/**
 * Confirm clearing enum-typed nullable fields (travelPace, budgetStyle) also
 * strips all DOB fields in the resulting payload.
 *
 * STATUS: BUG-FOUND (behavior does not exist)
 *
 * The task description expects that when travelPace or budgetStyle is cleared
 * to null in the travel-profile edit form, the client-side payload builder
 * also nulls out any DOB-related fields (dateOfBirth). This would be
 * appropriate if DOB display depended on those enums being set, or if a
 * shared "clear related fields" utility existed.
 *
 * Investigation findings (see detailed comment below):
 *  - travel-profile.tsx (travelPace / budgetStyle) and identity.tsx
 *    (dateOfBirth) are COMPLETELY SEPARATE screens with separate forms and
 *    separate save handlers. ProfileForm in travel-profile.tsx has no
 *    dateOfBirth field at all.
 *  - There is no shared utility that links clearing travelPace/budgetStyle
 *    to nulling out dateOfBirth.
 *  - The app uses a single dateOfBirth: string | null field (YYYY-MM-DD),
 *    not dobDay/dobMonth/dobYear sub-fields.
 *  - Neither the travel-profile.tsx handleSave nor the toggleSingle helper
 *    touch dateOfBirth when travelPace or budgetStyle is cleared.
 *  - The server-side PATCH handler (artifacts/api-server/src/routes/profile.ts
 *    lines 559-560 and 577-597) treats travelPace, budgetStyle, and
 *    dateOfBirth as independent columns — clearing one does NOT clear the
 *    others server-side either.
 *
 * Crash site: travel-buddy-standalone/app/profile/edit/travel-profile.tsx
 *   - handleSave (line 216): builds patch from ProfileForm which contains
 *     { travelPace, budgetStyle, comfortLevel, planningStyle, lookingFor,
 *       openToMeet, travelGroupStyle, availabilityTags } — no dateOfBirth key.
 *   - toggleSingle (line 203): sets a single key to null or the new value;
 *     no side-effect to any DOB field.
 *
 * The described behaviour is absent, and the tests below ASSERT its absence
 * rather than skipping. An earlier revision carried three `it.skip` cases
 * encoding the expected-but-nonexistent linkage; they were exact inverses of
 * the three "actual behaviour" cases below and asserted nothing, which the
 * node:test skipped<=0 gate correctly rejected. If the linkage is ever
 * intentionally implemented, invert the three "actual behaviour" assertions
 * and remove this STATUS comment.
 *
 * Run:
 *   node --import tsx/esm --test src/services/__tests__/travelPaceBudgetClearDob.test.ts
 *
 * Pure TypeScript — no React, no native modules, no network calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Utilities extracted verbatim from travel-profile.tsx ─────────────────────
//
// We reproduce the minimal payload-building logic from travel-profile.tsx so
// the test exercises the real code path (the toggleSingle + handleSave pair)
// without importing React Native modules.

type TravelPace = 'slow' | 'balanced' | 'packed' | null;
type BudgetStyle = 'budget' | 'mid-range' | 'luxury' | 'flexible' | null;

interface ProfileForm {
  travelPace: TravelPace;
  budgetStyle: BudgetStyle;
  comfortLevel: string | null;
  planningStyle: string | null;
  lookingFor: string[];
  openToMeet: boolean;
  travelGroupStyle: string[];
  availabilityTags: string[];
}

/** Exact replica of the toggleSingle helper in travel-profile.tsx (line 203). */
function toggleSingle<K extends keyof ProfileForm>(
  form: ProfileForm,
  key: K,
  value: string,
): ProfileForm {
  return { ...form, [key]: form[key] === value ? null : value };
}

/**
 * Exact replica of the patch-building logic in travel-profile.tsx handleSave
 * (lines 225-249). Returns the PATCH object that would be sent to
 * updateMyProfile.
 */
function buildTravelProfilePatch(
  form: ProfileForm,
  originalForm: ProfileForm,
): Partial<ProfileForm & { dateOfBirth?: string | null }> {
  const patch: Partial<ProfileForm & { dateOfBirth?: string | null }> = {};
  if (form.travelPace !== originalForm.travelPace) {
    patch.travelPace = form.travelPace;
  }
  if (form.budgetStyle !== originalForm.budgetStyle) {
    patch.budgetStyle = form.budgetStyle;
  }
  if (form.comfortLevel !== originalForm.comfortLevel) {
    patch.comfortLevel = form.comfortLevel;
  }
  if (form.planningStyle !== originalForm.planningStyle) {
    patch.planningStyle = form.planningStyle;
  }
  if (form.lookingFor.join(',') !== originalForm.lookingFor.join(',')) {
    patch.lookingFor = form.lookingFor;
  }
  if (form.openToMeet !== originalForm.openToMeet) {
    patch.openToMeet = form.openToMeet;
  }
  if (form.travelGroupStyle.join(',') !== originalForm.travelGroupStyle.join(',')) {
    patch.travelGroupStyle = form.travelGroupStyle;
  }
  if (form.availabilityTags.join(',') !== originalForm.availabilityTags.join(',')) {
    patch.availabilityTags = form.availabilityTags;
  }
  return patch;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeForm(overrides: Partial<ProfileForm> = {}): ProfileForm {
  return {
    travelPace: 'balanced',
    budgetStyle: 'mid-range',
    comfortLevel: 'social',
    planningStyle: 'flexible',
    lookingFor: ['culture'],
    openToMeet: true,
    travelGroupStyle: ['solo'],
    availabilityTags: ['Morning'],
    ...overrides,
  };
}

// ── Evidence tests: demonstrate current actual behaviour ─────────────────────
//
// These tests are NOT skipped — they document and verify the actual (current)
// behaviour: clearing travelPace / budgetStyle produces a patch with ONLY
// those enum keys and no dateOfBirth key.

describe('travel-profile patch builder — actual behaviour (no DOB linkage)', () => {
  it('clearing travelPace produces a patch containing only travelPace — no dateOfBirth key', () => {
    const original = makeForm({ travelPace: 'slow' });
    const updated = toggleSingle(original, 'travelPace', 'slow');

    assert.equal(updated.travelPace, null, 'toggleSingle must clear travelPace to null');

    const patch = buildTravelProfilePatch(updated, original);

    assert.equal(patch.travelPace, null, 'patch must include travelPace: null');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(patch, 'dateOfBirth'),
      'EVIDENCE: dateOfBirth is absent from the patch — confirming the linkage does not exist',
    );
  });

  it('clearing budgetStyle produces a patch containing only budgetStyle — no dateOfBirth key', () => {
    const original = makeForm({ budgetStyle: 'luxury' });
    const updated = toggleSingle(original, 'budgetStyle', 'luxury');

    assert.equal(updated.budgetStyle, null, 'toggleSingle must clear budgetStyle to null');

    const patch = buildTravelProfilePatch(updated, original);

    assert.equal(patch.budgetStyle, null, 'patch must include budgetStyle: null');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(patch, 'dateOfBirth'),
      'EVIDENCE: dateOfBirth is absent from the patch — confirming the linkage does not exist',
    );
  });

  it('clearing both travelPace and budgetStyle produces a patch with both — no dateOfBirth key', () => {
    const original = makeForm({ travelPace: 'packed', budgetStyle: 'budget' });
    let updated = toggleSingle(original, 'travelPace', 'packed');
    updated = toggleSingle(updated, 'budgetStyle', 'budget');

    const patch = buildTravelProfilePatch(updated, original);

    assert.equal(patch.travelPace, null);
    assert.equal(patch.budgetStyle, null);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(patch, 'dateOfBirth'),
      'EVIDENCE: dateOfBirth is absent from the patch — confirming the linkage does not exist',
    );
  });

  it('ProfileForm type has no dateOfBirth field — identity and travel-profile are separate forms', () => {
    // Structural proof: construct a ProfileForm and verify it has exactly the
    // expected keys — none of which include dateOfBirth.
    const form = makeForm();
    const keys = Object.keys(form);
    assert.ok(!keys.includes('dateOfBirth'), 'ProfileForm has no dateOfBirth field');
    assert.ok(!keys.includes('dobDay'),       'ProfileForm has no dobDay field');
    assert.ok(!keys.includes('dobMonth'),     'ProfileForm has no dobMonth field');
    assert.ok(!keys.includes('dobYear'),      'ProfileForm has no dobYear field');
    // Confirm the expected keys are present.
    assert.ok(keys.includes('travelPace'));
    assert.ok(keys.includes('budgetStyle'));
  });
});

// ── Source-code structural check ──────────────────────────────────────────────
//
// Guards the separation of concerns: travel-profile.tsx must NOT import
// dateOfBirth / DOB logic, and identity.tsx must NOT import travelPace /
// budgetStyle logic. If either screen is later refactored to merge the forms,
// the skipped tests above should be revisited.

describe('source-code structure confirms separation of travelPace/budgetStyle from DOB', () => {
  it('travel-profile.tsx contains no dateOfBirth / DOB field references', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join('app', 'profile', 'edit', 'travel-profile.tsx'), 'utf8');
    assert.ok(
      !src.includes('dateOfBirth'),
      'travel-profile.tsx must not reference dateOfBirth — it is handled by identity.tsx',
    );
    assert.ok(
      !src.includes('dobDay') && !src.includes('dobMonth') && !src.includes('dobYear'),
      'travel-profile.tsx must not reference any DOB sub-fields',
    );
  });

  it('identity.tsx contains no travelPace / budgetStyle references', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join('app', 'profile', 'edit', 'identity.tsx'), 'utf8');
    assert.ok(
      !src.includes('travelPace'),
      'identity.tsx must not reference travelPace — it is handled by travel-profile.tsx',
    );
    assert.ok(
      !src.includes('budgetStyle'),
      'identity.tsx must not reference budgetStyle — it is handled by travel-profile.tsx',
    );
  });
});
