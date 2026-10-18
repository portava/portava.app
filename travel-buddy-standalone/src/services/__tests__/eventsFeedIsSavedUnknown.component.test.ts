/**
 * census-trust (wave 5, 2026-10-18) — event reads: GET /api/events answers
 * `isSaved: null` when the viewer's saved state could not be read (a bookmark is
 * side data: the feed is kept, the flag is UNKNOWN). The client must never turn
 * that null into a filled or an empty bookmark claim.
 *
 * Measured on the client as it stands: NO screen renders the feed item's
 * `isSaved`. The events tab draws its bookmarks from the saved list (GET
 * /events/saved -> `savedIds`), and the list screen's EventDiscoveryCard is
 * given no `isSaved` and no toggle. So a null cannot reach a bookmark. This
 * file pins that, and pins the type that says null can arrive, so a later
 * screen that reads `item.isSaved` has to handle the unknown on purpose.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules' && e.name !== '__fixtures__') out.push(...walk(rel));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Client modules that hold event FEED items (they call the list services or name the list item type). */
const FEED_CONSUMERS = [...walk('app'), ...walk('src')].filter((rel) =>
  /\b(listEvents|listFollowingEvents|listCircleEvents|EventListItem)\b/.test(read(rel)),
);

describe('GET /events `isSaved: null` (unknown) never becomes a bookmark claim', () => {
  it('the feed item type admits null, and says what it means', () => {
    const src = read('src/services/events.ts');
    const decl = src.split('\n').find((l) => /^\s*isSaved\?:/.test(l)) ?? '';
    expect(decl).toMatch(/isSaved\?: boolean \| null;/);
    expect(decl).toMatch(/UNKNOWN/);
  });

  it('no client module reads `isSaved` off a feed item (so null cannot reach a bookmark)', () => {
    expect(FEED_CONSUMERS.length).toBeGreaterThanOrEqual(3); // vacuity: the tab, the list screen, the service
    const reads = FEED_CONSUMERS.flatMap((rel) =>
      read(rel).split('\n').map((l, i) => ({ rel, line: i + 1, text: l })).filter((x) => /\.isSaved\b/.test(x.text)),
    );
    expect(reads.map((r) => `${r.rel}:${r.line} ${r.text.trim()}`)).toEqual([]);
  });

  it('the events tab draws every bookmark from the saved list, and the list screen draws none', () => {
    const tab = read('app/(tabs)/events.tsx');
    const props = [...tab.matchAll(/isSaved=\{([^}]*\})?[^}]*\}/g)].map((m) => m[0]);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) expect(p).toMatch(/^isSaved=\{savedIds\.has\(/);
    expect(read('app/events/list.tsx')).not.toMatch(/isSaved=/);
  });
});
