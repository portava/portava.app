/**
 * GET /compass/feed is RETIRED from the client (testing-mode WP-12, flow
 * COMP-F03; decision recorded in census-compass §29).
 *
 * `fetchCompassFeed` had no caller: the Compass tab renders Compass Home
 * (GET /compass/home — the server-built current-context projection CPV2-05
 * asks for) and the per-section feed (GET /compass/feed/section/:section via
 * useCompassFeed). A whole-feed call would be a second recommendation surface
 * beside Home, not a missing screen. So the dead client function is removed,
 * and nothing in the client may call the whole feed.
 *
 * (compass.tzOffsetSurfaces.test.ts pins the other surfaces, but it is on
 * run-node-tests' KNOWN_BROKEN list, so it is not evidence; this runs under jest.)
 *
 * Run: npx jest src/services/__tests__/compassFeedRetired
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as compass from '../compass.ts';

function sourcesCalling(pattern: RegExp): string[] {
  const root = join(__dirname, '../../..');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && pattern.test(readFileSync(full, 'utf8'))) out.push(full.slice(root.length + 1));
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'app'));
  return out;
}

describe('the whole Compass feed is retired from the client', () => {
  it('there is no fetchCompassFeed', () => {
    expect((compass as Record<string, unknown>).fetchCompassFeed).toBeUndefined();
  });

  it('no client source calls GET /api/compass/feed (the section route is a different path)', () => {
    expect(sourcesCalling(/\/api\/compass\/feed\?/)).toEqual([]);
  });

  it('control: the per-section feed the Compass tab uses is still there', () => {
    expect(typeof compass.fetchCompassSection).toBe('function');
    expect(sourcesCalling(/\/api\/compass\/feed\/section\//)).toEqual(['src/services/compass.ts']);
  });
});
