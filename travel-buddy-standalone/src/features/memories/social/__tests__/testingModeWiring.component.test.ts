/**
 * Testing mode WP-06 / WP-07 — the mounts in screens too heavy to render here.
 *
 * The profile, trip and place screens each mount a large provider graph, and
 * their own suites pin other behaviour. What this suite pins is only that the
 * new sections are MOUNTED where the flows need them, with the input that
 * makes them correct — a section that is built and never mounted is the
 * failure this lane exists to fix.
 *
 *   HM-F14  the profile Memories tab renders ProfileMemoryAlbums for the
 *           profile being viewed (not the viewer);
 *   HM-F15  the Trip Memory section links to /trip/:id/recap;
 *   HM-F19  the place screen renders PlaceRecapsSection for the canonical
 *           place, behind place_recaps_enabled.
 *
 * Run with: pnpm test:component
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

it('HM-F14: the profile Memories tab mounts ProfileMemoryAlbums for the viewed profile', () => {
  const src = read('app/passport/[username].tsx');
  const tab = src.slice(src.indexOf("{tab === 'memories'"), src.indexOf("{tab === 'plans'"));
  expect(tab).toContain('<ProfileMemoryAlbums userId={profile.id} />');
  expect(src).toMatch(/import \{ ProfileMemoryAlbums \} from '..\/..\/src\/features\/memories\/social\/ProfileMemoryAlbums\.tsx';/);
});

it('HM-F15: the Trip Memory section links to the trip recap', () => {
  // RESTATED 2026-10-03 (lane highlights, census §AB): the section moved
  // verbatim out of the trip screen into its own module. The trip screen must
  // still MOUNT it, and the module must still carry the link.
  const screen = read('app/trip/[id].tsx');
  expect(screen).toMatch(/import \{ TripMemorySection \} from '..\/..\/src\/features\/memories\/TripMemorySection\.tsx';/);
  expect(screen).toContain('<TripMemorySection');
  const src = read('src/features/memories/TripMemorySection.tsx');
  const section = src.slice(src.indexOf('export function TripMemorySection'));
  expect(src.indexOf('export function TripMemorySection')).toBeGreaterThanOrEqual(0);
  // Rendered whenever the trip has a Memory — the recap's own route decides who may read it.
  expect(section).toContain('{memory ? <Pressable testID="trip-open-recap"');
  expect(section).toContain('router.push(`/trip/${tripId}/recap` as any)');
});

it('HM-F19: the place screen mounts your recaps of the canonical place, behind place_recaps_enabled', () => {
  const src = read('app/place/[id].tsx');
  expect(src).toContain("<PlaceRecapsSection placeId={canonicalPlace.id} enabled={isLivePlacesEnabled('place_recaps_enabled')} />");
});

it('PLAT-F33: the Create hub routes Story to /stories', () => {
  const src = read('src/components/create/CreateHubSheet.tsx');
  const story = src.slice(src.indexOf("id: 'story'"), src.indexOf("id: 'memory'"));
  expect(story).toContain("route: '/stories'");
});
