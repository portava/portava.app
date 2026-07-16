/**
 * Regression guard: the approximate (~500 m) meetup-area card on the
 * traveller-facing buddy profile must render when BOTH meetupBaseLat and
 * meetupBaseLng are set, and stay hidden when either is missing.
 *
 * Run:
 *   node --import tsx/esm --test src/components/location/__tests__/meetupAreaCard.render.test.ts
 *
 * The buddy profile screen (app/(rent-a-buddy)/buddy/[id].tsx) cannot be
 * mounted here (no RN renderer), so this test guards the contract at two
 * levels, following the repo's node:test convention:
 *
 * 1. Behavioural: the render predicate — card shown only when both coords
 *    are non-null — exercised across the null/undefined/zero matrix.
 * 2. Source-level: the screen source must actually gate <MeetupAreaPreview>
 *    on that predicate, and both MeetupAreaPreview variants (native map and
 *    web fallback) must keep their privacy-note copy. A refactor that drops
 *    the card, the guard, or the privacy framing fails these assertions.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../../..');
const dtoPath = path.resolve(appRoot, 'src', 'services', 'rentABuddy.ts');

const screenPath = path.join(appRoot, 'app', '(rent-a-buddy)', 'buddy', '[id].tsx');
const nativePreviewPath = path.join(here, '..', 'MeetupAreaPreview.tsx');
const webPreviewPath = path.join(here, '..', 'MeetupAreaPreview.web.tsx');

const screenSrc = readFileSync(screenPath, 'utf8');
const nativeSrc = readFileSync(nativePreviewPath, 'utf8');
const webSrc = readFileSync(webPreviewPath, 'utf8');

// ── 1. The render predicate ───────────────────────────────────────────────────
//
// Mirrors the guard in the screen: both coordinates must be non-null
// (0 is a valid coordinate — the equator / prime meridian must render).

function shouldShowMeetupAreaCard(
  meetupBaseLat: number | null | undefined,
  meetupBaseLng: number | null | undefined,
): boolean {
  return meetupBaseLat != null && meetupBaseLng != null;
}

describe('meetup-area card render predicate', () => {
  test('shown when both coordinates are set', () => {
    assert.equal(shouldShowMeetupAreaCard(38.7223, -9.1393), true);
  });

  test('zero is a valid coordinate (equator / prime meridian)', () => {
    assert.equal(shouldShowMeetupAreaCard(0, 0), true);
    assert.equal(shouldShowMeetupAreaCard(0, -9.1393), true);
    assert.equal(shouldShowMeetupAreaCard(38.7223, 0), true);
  });

  test('hidden when lat is missing', () => {
    assert.equal(shouldShowMeetupAreaCard(null, -9.1393), false);
    assert.equal(shouldShowMeetupAreaCard(undefined, -9.1393), false);
  });

  test('hidden when lng is missing', () => {
    assert.equal(shouldShowMeetupAreaCard(38.7223, null), false);
    assert.equal(shouldShowMeetupAreaCard(38.7223, undefined), false);
  });

  test('hidden when both are missing', () => {
    assert.equal(shouldShowMeetupAreaCard(null, null), false);
    assert.equal(shouldShowMeetupAreaCard(undefined, undefined), false);
  });
});

// ── 2. The screen actually uses that predicate around the card ───────────────

describe('buddy profile screen gates MeetupAreaPreview on both coordinates', () => {
  test('screen imports MeetupAreaPreview', () => {
    assert.match(
      screenSrc,
      /import\s*\{\s*MeetupAreaPreview\s*\}\s*from\s*['"].*components\/location\/MeetupAreaPreview['"]/,
      'buddy/[id].tsx no longer imports MeetupAreaPreview — the meetup-area card was dropped',
    );
  });

  test('the card render is guarded by a non-null check on BOTH coordinates', () => {
    // The guard and the render must appear together: `lat != null && lng != null`
    // (in either order) immediately gating the JSX that mounts the preview.
    const guarded =
      /meetupBaseLat\s*!=\s*null\s*&&\s*[\w.]*meetupBaseLng\s*!=\s*null[\s\S]{0,300}?<MeetupAreaPreview\b/.test(
        screenSrc,
      ) ||
      /meetupBaseLng\s*!=\s*null\s*&&\s*[\w.]*meetupBaseLat\s*!=\s*null[\s\S]{0,300}?<MeetupAreaPreview\b/.test(
        screenSrc,
      );
    assert.ok(
      guarded,
      'MeetupAreaPreview must be rendered behind `meetupBaseLat != null && meetupBaseLng != null` — ' +
        'an unguarded render (or a dropped guard) would show/crash the card for buddies without a pin',
    );
  });

  test('the preview receives both coordinates as props', () => {
    assert.match(
      screenSrc,
      /<MeetupAreaPreview\s[^>]*lat=\{[\w.]*meetupBaseLat\}[^>]*lng=\{[\w.]*meetupBaseLng\}/,
      'MeetupAreaPreview must be fed buddy.meetupBaseLat / buddy.meetupBaseLng',
    );
  });

  test('MeetupAreaPreview is mounted exactly once on the profile screen', () => {
    const mounts = screenSrc.match(/<MeetupAreaPreview\b/g) ?? [];
    assert.equal(mounts.length, 1, 'expected exactly one MeetupAreaPreview mount');
  });
});

// ── 3. Privacy note copy survives in both platform variants ──────────────────

describe('privacy note is present alongside the map / web fallback', () => {
  test('native map variant keeps the approximate-area note', () => {
    assert.match(
      nativeSrc,
      /Approximate area only[\s\S]*exact meetup point is agreed after booking/,
      'MeetupAreaPreview.tsx lost its privacy note (“Approximate area only …”)',
    );
  });

  test('native map variant never renders an exact point (fuzzy circle only)', () => {
    assert.match(
      nativeSrc,
      /AREA_RADIUS_M\s*=\s*500/,
      'the ~500 m fuzzy-area radius constant is gone from MeetupAreaPreview.tsx',
    );
  });

  test('web fallback keeps the privacy framing', () => {
    assert.match(
      webSrc,
      /rough meetup area \(never an exact point\)/,
      'MeetupAreaPreview.web.tsx lost its privacy framing copy',
    );
    assert.match(
      webSrc,
      /Approximate meetup area pinned/,
      'MeetupAreaPreview.web.tsx lost its title copy',
    );
  });

  test('buddy DTO still carries meetupBaseLat/meetupBaseLng', () => {
    const dtoSrc = readFileSync(dtoPath, 'utf8');
    assert.match(
      dtoSrc,
      /meetupBaseLat\??:\s*number(\s*\|\s*null)?/,
      'meetupBaseLat dropped from the buddy DTO — the profile card would silently disappear',
    );
    assert.match(
      dtoSrc,
      /meetupBaseLng\??:\s*number(\s*\|\s*null)?/,
      'meetupBaseLng dropped from the buddy DTO — the profile card would silently disappear',
    );
  });

  test('both variants expose the same props contract (lat/lng)', () => {
    for (const [label, src] of [
      ['native', nativeSrc],
      ['web', webSrc],
    ] as const) {
      assert.match(
        src,
        /export\s+interface\s+MeetupAreaPreviewProps\s*\{[\s\S]*?lat:\s*number;[\s\S]*?lng:\s*number;[\s\S]*?\}/,
        `${label} MeetupAreaPreview props contract changed — screen import would break silently`,
      );
    }
  });
});
