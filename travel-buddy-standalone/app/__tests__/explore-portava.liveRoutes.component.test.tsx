/**
 * ExplorePortavaScreen — live-route regression tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * Six rows that were previously disabled now have real routes:
 *   - Travelers      → /discover
 *   - Neighborhoods  → /map?entry=unknown  (§35 origin: the vocabulary has no
 *                        'explore' member, so the origin is stated as unknown)
 *   - Hidden Gems    → /gems
 *   - Blocked Accounts → /blocked-users
 *   - Muted Accounts   → /muted-users
 *   - Report a Problem → /profile/edit/reports
 *
 * For each row this suite asserts:
 *   1. The row is not marked `disabled`.
 *   2. The row carries the correct `route` string.
 *
 * ## Why data-structure rather than render test
 *
 * SectionList virtualises: with 9 Social rows filling `initialNumToRender=10`,
 * subsequent sections (Discover, Account, …) are never painted under Jest's
 * 0-height window.  Rendering the screen would require a full SectionList
 * replacement mock which, in turn, must spread `jest.requireActual('react-native')`
 * — pulling in native modules that crash in the test environment.
 *
 * The SECTIONS array is the single source of truth for all directory routing,
 * so asserting its shape directly is both more reliable and tests exactly the
 * code path that controls user-visible behaviour.
 */

import { SECTIONS } from '../explore-portava.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function findItem(key: string) {
  for (const section of SECTIONS) {
    const item = section.data.find((d) => d.key === key);
    if (item) return item;
  }
  return undefined;
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('ExplorePortavaScreen SECTIONS — live route wiring', () => {
  const LIVE_ROUTES: Array<{ key: string; label: string; expectedRoute: string }> = [
    { key: 'travelers',    label: 'Travelers',        expectedRoute: '/discover' },
    { key: 'neighborhoods',label: 'Neighborhoods',    expectedRoute: '/map?entry=unknown' },
    { key: 'hidden-gems',  label: 'Hidden Gems',      expectedRoute: '/gems' },
    { key: 'acc-blocked',  label: 'Blocked Accounts', expectedRoute: '/blocked-users' },
    { key: 'acc-muted',    label: 'Muted Accounts',   expectedRoute: '/muted-users' },
    { key: 'acc-report',   label: 'Report a Problem', expectedRoute: '/profile/edit/reports' },
    // Following/Followers must route to the correct, distinct screens — not
    // swapped, and not a dead route — so tapping either never dead-ends.
    { key: 'following',    label: 'Following',        expectedRoute: '/following' },
    { key: 'followers',    label: 'Followers',        expectedRoute: '/followers' },
  ];

  it('Following and Followers rows are not swapped', () => {
    const following = findItem('following');
    const followers = findItem('followers');
    expect(following?.route).toBe('/following');
    expect(followers?.route).toBe('/followers');
    expect(following?.route).not.toBe(followers?.route);
  });

  for (const { key, label, expectedRoute } of LIVE_ROUTES) {
    describe(`${label} row (key="${key}")`, () => {
      it('is not disabled', () => {
        const item = findItem(key);
        expect(item).toBeDefined();
        expect(item!.disabled).toBeFalsy();
      });

      it(`routes to ${expectedRoute}`, () => {
        const item = findItem(key);
        expect(item).toBeDefined();
        expect(item!.route).toBe(expectedRoute);
      });
    });
  }
});
