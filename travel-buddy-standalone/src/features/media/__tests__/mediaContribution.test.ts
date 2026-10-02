/**
 * features/media — the §4 Media Contribution model (census-media §19: MD28 · MD316).
 *
 * The contribution goes through the existing upload + post write, so what this
 * suite pins is the BINDING and the CHOICES:
 *   • the post is tagged with the canonical place's own public venue fields —
 *     never with the contributor's position — and the contributor's device fix
 *     travels only as the private verification pair;
 *   • every sheet choice lands on a real post-write field (audience, precision
 *     → locationPrivacyMode incl. §34 "after I leave", category);
 *   • a perspective is not a Passport postcard (§29);
 *   • a failed save retries the SAVE, never the upload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_CONTRIBUTION_DRAFT,
  contributionReducer,
  contributionBlocker,
  toCreatePostInput,
  retryStartsAt,
  doneCopy,
  PRECISION_TO_PRIVACY_MODE,
  CONTRIBUTION_CATEGORIES,
  contributionPrecisions,
  contributionVantages,
  PERSPECTIVE_VANTAGE_FLAG,
  type ContributionPlace,
} from '../state/mediaContribution.ts';

const PLACE: ContributionPlace = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Vertigo Rooftop',
  city: 'Bangkok',
  countryCode: 'TH',
  coordinates: { lat: 13.7236, lng: 100.5437 },
};

const PICKED = { uri: 'file:///x.jpg', mimeType: 'image/jpeg', type: 'image' };

test('nothing is sendable without a place and a picked asset', () => {
  assert.equal(contributionBlocker(INITIAL_CONTRIBUTION_DRAFT, null), 'This place could not be loaded.');
  assert.equal(contributionBlocker(INITIAL_CONTRIBUTION_DRAFT, PLACE), 'Add a photo or clip from here.');
  const d = contributionReducer(INITIAL_CONTRIBUTION_DRAFT, { type: 'pick_media', media: PICKED });
  assert.equal(contributionBlocker(d, PLACE), null);
});

test('the post is bound to the VENUE — its own public name and coordinates — never the contributor\'s position', () => {
  let d = contributionReducer(INITIAL_CONTRIBUTION_DRAFT, { type: 'pick_media', media: PICKED });
  d = contributionReducer(d, { type: 'set_category', category: 'nightlife' });
  d = contributionReducer(d, { type: 'set_note', note: '  filling up fast  ' });
  const device = { lat: 13.72361, lng: 100.54371 };
  const input = toCreatePostInput(d, PLACE, { url: 'https://cdn/x.jpg', mediaType: 'image' }, device);
  assert.equal(input.locationName, 'Vertigo Rooftop');
  assert.equal(input.locationLat, PLACE.coordinates.lat);
  assert.equal(input.locationLng, PLACE.coordinates.lng);
  // The device fix is ONLY the private verification pair.
  assert.equal(input.userGpsLat, device.lat);
  assert.equal(input.locationSource, 'gps');
  assert.equal(input.category, 'nightlife');
  assert.equal(input.content, 'filling up fast');
  assert.deepEqual(input.mediaUrls, ['https://cdn/x.jpg']);
  assert.equal(input.addToPassport, false, 'a perspective is world context, not a Passport postcard (§29)');
  // Without a device fix the contribution is honestly unverified — nothing is invented.
  const noGps = toCreatePostInput(d, PLACE, { url: 'u', mediaType: 'image' }, null);
  assert.equal(noGps.userGpsLat, null);
  assert.equal(noGps.locationSource, 'manual');
});

test('every precision choice maps onto the post write\'s locationPrivacyMode — including §34 "after I leave"', () => {
  assert.deepEqual(PRECISION_TO_PRIVACY_MODE, {
    venue: 'none',
    city_only: 'city_only',
    after_i_leave: 'delayed_until_exit',
    hidden: 'hidden',
    neighborhood: 'neighborhood_only',
  });
  let d = contributionReducer(INITIAL_CONTRIBUTION_DRAFT, { type: 'pick_media', media: PICKED });
  d = contributionReducer(d, { type: 'set_precision', precision: 'after_i_leave' });
  d = contributionReducer(d, { type: 'set_audience', audience: 'private' });
  const input = toCreatePostInput(d, PLACE, { url: 'u', mediaType: 'image' }, null);
  assert.equal(input.locationPrivacyMode, 'delayed_until_exit');
  assert.equal(input.visibility, 'private');
});

test('the categories offered are exactly buckets the server groups perspectives by — no vantage is offered', () => {
  const keys = CONTRIBUTION_CATEGORIES.map((c) => c.key);
  for (const vantage of ['entrance', 'queue', 'stage', 'bar', 'vip', 'main_room', 'rooftop']) {
    assert.equal(keys.includes(vantage), false, `${vantage} has no column to live in (census F7) and must not be offered`);
  }
  // Tapping the selected category again clears it (back to "general").
  const d = contributionReducer(contributionReducer(INITIAL_CONTRIBUTION_DRAFT, { type: 'set_category', category: 'food' }), { type: 'set_category', category: 'food' });
  assert.equal(d.category, null);
});

test('a failed SAVE retries the save with the uploaded URL — the file is never uploaded twice', () => {
  assert.equal(retryStartsAt({ kind: 'failed', step: 'save', message: 'x', uploadedUrl: 'https://cdn/x.jpg', mediaType: 'image' }), 'save');
  assert.equal(retryStartsAt({ kind: 'failed', step: 'upload', message: 'x', uploadedUrl: null, mediaType: null }), 'upload');
  assert.equal(retryStartsAt({ kind: 'editing' }), 'upload');
});

test('a held-back post is reported as held back, never as already live', () => {
  assert.match(doneCopy(true, 'after_i_leave'), /once you have left/);
  assert.match(doneCopy(true, 'venue'), /appears shortly/);
  assert.match(doneCopy(false, 'venue'), /part of this place now/);
});

test('§34 "Neighbourhood only" is offered only while the server accepts it (census-media §36)', () => {
  assert.deepEqual(contributionPrecisions({ neighborhoodOffered: false }), ['venue', 'city_only', 'after_i_leave', 'hidden'],
    'flag off: the four choices the sheet always offered, in the same order');
  assert.deepEqual(contributionPrecisions({ neighborhoodOffered: true }), ['venue', 'neighborhood', 'city_only', 'after_i_leave', 'hidden']);
  let d = contributionReducer(INITIAL_CONTRIBUTION_DRAFT, { type: 'pick_media', media: PICKED });
  d = contributionReducer(d, { type: 'set_precision', precision: 'neighborhood' });
  assert.equal(toCreatePostInput(d, PLACE, { url: 'u', mediaType: 'image' }, null).locationPrivacyMode, 'neighborhood_only');
});

test('§12 vantages are offered only with the flag and a §12 category (census-media §36)', () => {
  assert.equal(PERSPECTIVE_VANTAGE_FLAG, 'media_perspective_vantage_enabled');
  assert.deepEqual(contributionVantages('nightlife', { offered: false }), [], 'flag off: none');
  assert.deepEqual(contributionVantages('culture', { offered: true }), [], 'culture has no §12 list');
  assert.deepEqual(contributionVantages(null, { offered: true }), []);
  assert.deepEqual(contributionVantages('nightlife', { offered: true }).map((v) => v.label),
    ['Entrance', 'Queue', 'Street', 'Main Room', 'Stage', 'Bar', 'VIP', 'Outside']);
});

test('the chosen vantage is sent; changing to a category whose list lacks it drops it', () => {
  let d = contributionReducer(INITIAL_CONTRIBUTION_DRAFT, { type: 'pick_media', media: PICKED });
  d = contributionReducer(d, { type: 'set_category', category: 'nightlife' });
  d = contributionReducer(d, { type: 'set_vantage', vantage: 'entrance' });
  assert.equal(toCreatePostInput(d, PLACE, { url: 'u', mediaType: 'image' }, null).perspectiveVantage, 'entrance');
  // Restaurant also has an Entrance — it survives the switch.
  d = contributionReducer(d, { type: 'set_category', category: 'food' });
  assert.equal(d.vantage, 'entrance');
  // Beach does not — it is dropped rather than sent with the wrong list.
  d = contributionReducer(d, { type: 'set_category', category: 'beach' });
  assert.equal(d.vantage, null);
  assert.equal('perspectiveVantage' in toCreatePostInput(d, PLACE, { url: 'u', mediaType: 'image' }, null), false,
    'no vantage ⇒ the field is absent, as before');
  // Tapping the chosen vantage again clears it.
  d = contributionReducer(d, { type: 'set_vantage', vantage: 'sunset' });
  d = contributionReducer(d, { type: 'set_vantage', vantage: 'sunset' });
  assert.equal(d.vantage, null);
});
