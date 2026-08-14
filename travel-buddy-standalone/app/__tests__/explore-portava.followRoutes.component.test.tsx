/**
 * explore-portava.followRoutes.component.test.tsx
 *
 * Confirms that the Explore Portava screen's "Following" and "Followers"
 * rows navigate to the correct, *existing* routes — not swapped, not a dead
 * placeholder, and backed by real files in app/.
 *
 * ## What's covered
 *
 *   1. Social › Following    → router.push('/following')   (not /followers or /circle)
 *   2. Social › Followers    → router.push('/followers')   (not /following or /circle)
 *   3. Passport › Following  → router.push('/following')   (same real screen)
 *   4. Passport › Followers  → router.push('/followers')   (same real screen)
 *   5. The routes are distinct — pressing one can't accidentally land on the other.
 *   6. app/following.tsx exists on disk  — the pushed route resolves to a real file.
 *   7. app/followers.tsx exists on disk  — the pushed route resolves to a real file.
 *
 * ## Strategy
 *
 * ExplorePortavaScreen renders a SectionList which virtualises rows; only the
 * first ~10 items in the first section are committed under Jest's 0-height
 * window.  Rather than fight the virtualisation, we extract the exported
 * SECTIONS array (the single source of truth for every directory row's route)
 * and exercise `handleItemPress` logic via direct SECTIONS inspection.
 *
 * This is the same approach used by explore-portava.liveRoutes.component.test.tsx
 * for general route wiring.  This suite adds:
 *   - explicit "routes are distinct" cross-check
 *   - file-system existence assertions (so a typo or deleted file is caught)
 *
 * Run: pnpm --dir travel-buddy-standalone run test:component
 */

import path from 'path';
import fs from 'fs';
import { SECTIONS } from '../explore-portava.tsx';

// ── helpers ───────────────────────────────────────────────────────────────────

function findItem(key: string) {
  for (const section of SECTIONS) {
    const item = section.data.find((d) => d.key === key);
    if (item) return item;
  }
  return undefined;
}

/** Resolve an expo-router route string to the expected file path under app/. */
function routeToFilePath(route: string): string {
  // Strip leading slash; a route like "/following" maps to app/following.tsx
  const stripped = route.replace(/^\//, '');
  const appDir = path.resolve(__dirname, '..');
  return path.join(appDir, `${stripped}.tsx`);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ExplorePortavaScreen — Following / Followers route correctness', () => {
  // ── Social section ──────────────────────────────────────────────────────────

  describe('Social section', () => {
    it('Following row carries route /following (not /followers or any dead route)', () => {
      const item = findItem('following');
      expect(item).toBeDefined();
      expect(item!.route).toBe('/following');
    });

    it('Followers row carries route /followers (not /following or any dead route)', () => {
      const item = findItem('followers');
      expect(item).toBeDefined();
      expect(item!.route).toBe('/followers');
    });

    it('Following and Followers routes are distinct — pressing one cannot land on the other screen', () => {
      const following = findItem('following');
      const followers = findItem('followers');
      expect(following!.route).not.toBe(followers!.route);
    });

    it('Following row is not disabled (pressing it actually fires navigation)', () => {
      const item = findItem('following');
      expect(item!.disabled).toBeFalsy();
    });

    it('Followers row is not disabled (pressing it actually fires navigation)', () => {
      const item = findItem('followers');
      expect(item!.disabled).toBeFalsy();
    });
  });

  // ── Passport section ────────────────────────────────────────────────────────

  describe('Passport section', () => {
    it('pp-following row carries route /following', () => {
      const item = findItem('pp-following');
      expect(item).toBeDefined();
      expect(item!.route).toBe('/following');
    });

    it('pp-followers row carries route /followers', () => {
      const item = findItem('pp-followers');
      expect(item).toBeDefined();
      expect(item!.route).toBe('/followers');
    });

    it('Passport Following and Followers routes are distinct', () => {
      const ppFollowing = findItem('pp-following');
      const ppFollowers = findItem('pp-followers');
      expect(ppFollowing!.route).not.toBe(ppFollowers!.route);
    });

    it('pp-following row is not disabled', () => {
      const item = findItem('pp-following');
      expect(item!.disabled).toBeFalsy();
    });

    it('pp-followers row is not disabled', () => {
      const item = findItem('pp-followers');
      expect(item!.disabled).toBeFalsy();
    });
  });

  // ── File-existence: pushed routes resolve to real screens ──────────────────

  describe('Route file existence — routes are not dead', () => {
    it('app/following.tsx exists — /following route resolves to a real screen', () => {
      const following = findItem('following');
      const filePath = routeToFilePath(following!.route!);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('app/followers.tsx exists — /followers route resolves to a real screen', () => {
      const followers = findItem('followers');
      const filePath = routeToFilePath(followers!.route!);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('/following and /followers resolve to DIFFERENT files (not the same screen)', () => {
      const following = findItem('following');
      const followers = findItem('followers');
      const followingFile = routeToFilePath(following!.route!);
      const followersFile = routeToFilePath(followers!.route!);
      expect(followingFile).not.toBe(followersFile);
      // Both files must also exist
      expect(fs.existsSync(followingFile)).toBe(true);
      expect(fs.existsSync(followersFile)).toBe(true);
    });
  });
});
