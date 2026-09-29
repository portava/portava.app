/**
 * MD424 decision (testing-mode WP-17, flow MED-F06; recorded in census-media
 * §46): media Like and "Stamp It" are RETIRED from the client; Stamp and
 * Comments are the wired reactions.
 *
 *   - Heart/Like is on the spec's anti-pattern list ("Heart/Like as primary
 *     hierarchy", Media spec §46.2), and POST/DELETE /media/:id/like is the
 *     server's own compat wrapper over content_stamps "until mobile clients are
 *     migrated". This client migrated: StampButton / useStamp write Stamp
 *     through /stamps. `likeMedia` / `unlikeMedia` had no caller.
 *   - "Stamp It" (POST /media/:id/react → media_stamp_reactions) is a second,
 *     separately counted stamp gesture beside Stamp — two stamps and two counts
 *     for one act, against §14's single "Stamp" and MD408's minimal vanity
 *     metrics. `reactToMediaStampIt` had no caller.
 *   - Comments stay wired through MediaCommentSheet → the post comment
 *     endpoints (a media item's id is its post id), which carry threading,
 *     edit, report and block handling; GET /media/:id/comments is a thinner
 *     duplicate and is not wired.
 *
 * Run: npx jest src/services/__tests__/mediaReactionsRetired
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { join } from 'path';
import * as media from '../mediaInteractions.ts';

const ROOT = join(__dirname, '../../..');

function sourcesMatching(pattern: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__') continue;
      const full = path.resolve(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && pattern.test(readFileSync(full, 'utf8'))) out.push(full.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'app'));
  return out;
}

describe('MD424 — media Like and Stamp It retired; Stamp and Comments wired', () => {
  it('the client has no like / unlike / Stamp It functions', () => {
    const m = media as Record<string, unknown>;
    expect(m.likeMedia).toBeUndefined();
    expect(m.unlikeMedia).toBeUndefined();
    expect(m.reactToMediaStampIt).toBeUndefined();
  });

  it('no client source calls the media like or react routes', () => {
    expect(sourcesMatching(/\/api\/media\/\$\{[^}]+\}\/(like|react)\b/)).toEqual([]);
  });

  it('control: the media viewer still offers Stamp (through /stamps) and Comments (through the comment sheet)', () => {
    const viewer = readFileSync(join(ROOT, 'app/media-viewer/[id].tsx'), 'utf8');
    expect(viewer).toMatch(/<StampButton[\s\S]*?entityType="media"/);
    expect(viewer).toMatch(/<MediaCommentSheet/);
    expect(viewer).toMatch(/accessibilityLabel="Comment"/);
  });
});
