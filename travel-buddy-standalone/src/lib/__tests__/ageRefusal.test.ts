/**
 * ageRefusal — the client names the age refusals the server produces
 * (census-trust §31, TV-5b).
 *
 * The server's age gates (lib/gateAge.ts) refuse meetup RSVPs and circle-invite
 * acceptance with 403 `{ error: "age_not_eligible", reason, message }`, where
 * `reason` is one of `not_verified_adult` (a provider result says not 18+),
 * `below_min_age`, `above_max_age` or `dob_missing`. Before §31:
 *
 *   - app/notifications.tsx tested `res.reason === 'age_not_eligible'` — but
 *     `age_not_eligible` is the ERROR code, never the reason — so every age
 *     refusal of a circle invite fell through to an Alert titled "Error";
 *   - not one client file named `not_verified_adult`, the verified-minor
 *     refusal §19.5 says a client surface must render.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/ageRefusal.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ageRefusalPresentation, AGE_REFUSAL_REASONS } from '../ageRefusal.ts';

// From src/lib/__tests__/ back to the repository root (the string-path form:
// this tsconfig's DOM lib makes `new URL()` a type node:fs does not accept).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

describe('ageRefusalPresentation — every age reason the server sends is named', () => {
  it('covers exactly the refusing reasons lib/ageEligibility.ts and lib/gateAge.ts produce', () => {
    const server = read('artifacts/api-server/src/lib/ageEligibility.ts');
    const produced = new Set([...server.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    // the two non-refusals are not age refusals
    produced.delete('no_limit');
    produced.delete('within_range');
    produced.add('not_verified_adult'); // composed at the seam, see routes/meetups.ts and routes/requests.ts
    assert.deepEqual([...AGE_REFUSAL_REASONS].sort(), [...produced].sort());
  });

  it('a VERIFIED MINOR is told the identity check did not confirm 18+, with no retry and no DOB nudge', () => {
    const p = ageRefusalPresentation('not_verified_adult', undefined, 'meetup');
    assert.ok(p, 'not_verified_adult must be recognised');
    assert.match(p.body, /didn't confirm that you're 18 or over/i);
    assert.equal(p.action, undefined, 'no screen clears an identity-check result');
    assert.ok(!/date of birth|try again/i.test(p.body), p.body);
    assert.notEqual(p.title, 'Error');
  });

  it('below / above the limit is an AGE LIMIT, and the server sentence is kept when present', () => {
    const p = ageRefusalPresentation('below_min_age', 'This meetup requires users to be at least 21 years old.', 'meetup');
    assert.ok(p);
    assert.equal(p.title, 'Age limit');
    assert.equal(p.body, 'This meetup requires users to be at least 21 years old.');
    const q = ageRefusalPresentation('above_max_age', undefined, 'circle');
    assert.ok(q);
    assert.match(q.body, /age limit/i);
  });

  it('a server "message" that is a code or an HTTP placeholder is never shown — the fallback sentence is', () => {
    // services/meetups.ts fills `message` with `API <status>` when the body has
    // none; a code-shaped string is not a sentence either.
    for (const raw of ['API 403', 'age_not_eligible', '', '   ']) {
      const p = ageRefusalPresentation('below_min_age', raw, 'meetup');
      assert.ok(p);
      assert.equal(p.body, "You're outside this meetup's age limit, so you can't join it.", JSON.stringify(raw));
    }
  });

  it('a missing date of birth carries the profile route the existing alerts already offered', () => {
    const p = ageRefusalPresentation('dob_missing', undefined, 'circle');
    assert.ok(p);
    assert.match(p.body, /date of birth/i);
    assert.equal(p.action?.route, '/profile/edit');
  });

  it('a reason that is not an age refusal returns null, so the caller keeps its own handling', () => {
    for (const r of [undefined, null, '', 'age_not_eligible', 'forbidden', 'db_error']) {
      assert.equal(ageRefusalPresentation(r as string | undefined, 'x', 'meetup'), null, String(r));
    }
  });
});

describe('the surfaces call it — a source scan, because a deleted call is what regresses', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const file of ['travel-buddy-standalone/app/meetup/[id].tsx', 'travel-buddy-standalone/app/notifications.tsx']) {
    it(`${file} presents age refusals through ageRefusalPresentation`, () => {
      const src = strip(read(file));
      assert.match(src, /ageRefusalPresentation\(/, `${file} no longer names the server's age refusals`);
    });
  }
  it("app/notifications.tsx no longer compares `reason` with the ERROR code 'age_not_eligible'", () => {
    const src = strip(read('travel-buddy-standalone/app/notifications.tsx'));
    assert.ok(!/reason\s*===\s*'age_not_eligible'/.test(src), 'that comparison can never be true — the reason is never the error code');
  });
});
