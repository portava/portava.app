/**
 * census-media §29 — the pure halves of MD300 and MD288 on the screens:
 *   • `clusterCoverImage`: which of a cluster's server-chosen cover references
 *     is drawn (a video only by its poster; no cover ⇒ none);
 *   • the filter store's "near": its center (a place context wins over the
 *     viewer's point), what is sent (a radius the server's own bounds accept),
 *     and the words the chip and the refusal use. The city criterion is
 *     unchanged by it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clusterCoverImage } from '../state/mediaMapCover.ts';
import type { MediaMapCluster } from '../state/mediaMapStore.ts';
import {
  INITIAL_MEDIA_FILTERS,
  MEDIA_SEARCH_NEAR_RADIUS_M,
  mediaFilterReducer,
  nearChipLabel,
  nearRadiusLabel,
  nearRefusalCopy,
  searchNearCenter,
  toSearchNear,
  toSearchQueryString,
} from '../state/mediaFilterStore.ts';
import {
  MEDIA_SEARCH_NEAR_RADIUS_MAX_M,
  MEDIA_SEARCH_NEAR_RADIUS_MIN_M,
  mediaSearchNearParams,
} from '../services/mediaProjection.ts';

const PLACE = '11111111-1111-4111-8111-111111111111';
const ME = { lat: 16.0544, lng: 108.2022 };

function cluster(cover: unknown): MediaMapCluster {
  return { placeId: PLACE, label: 'An Thuong', perspectiveCount: 2, freshness: 'fresh', cover } as MediaMapCluster;
}

describe('MD300 — clusterCoverImage: the cover the map draws', () => {
  it('an image cover is drawn by its thumbnail, else its own file', () => {
    assert.equal(clusterCoverImage(cluster({ id: 'c1', mediaType: 'image', url: 'post-media/a.jpg', thumbnailUrl: 'post-media/a.thumb.jpg' })), 'post-media/a.thumb.jpg');
    assert.equal(clusterCoverImage(cluster({ id: 'c1', mediaType: 'image', url: 'post-media/a.jpg', thumbnailUrl: null })), 'post-media/a.jpg');
  });

  it('a video is drawn ONLY by its poster: its url is the video file', () => {
    assert.equal(clusterCoverImage(cluster({ id: 'v1', mediaType: 'video', url: 'post-media/v.mp4', thumbnailUrl: 'post-media/v.mp4.poster.jpg' })), 'post-media/v.mp4.poster.jpg');
    assert.equal(clusterCoverImage(cluster({ id: 'v1', mediaType: 'video', url: 'post-media/v.mp4', thumbnailUrl: null })), null);
  });

  it('no cover, a cover with no id, or no image at all ⇒ nothing drawn (the cluster renders as before)', () => {
    assert.equal(clusterCoverImage(cluster(null)), null);
    assert.equal(clusterCoverImage({ placeId: PLACE, label: 'x', perspectiveCount: 1, freshness: null }), null);
    assert.equal(clusterCoverImage(cluster({ mediaType: 'image', url: 'post-media/a.jpg' })), null);
    assert.equal(clusterCoverImage(cluster({ id: 'c1', mediaType: 'image', url: '  ', thumbnailUrl: '' })), null);
    assert.equal(clusterCoverImage(cluster([{ id: 'c1', mediaType: 'image', url: 'post-media/a.jpg' }])), null, 'an array is not a mapped cover');
  });
});

describe('MD288 — the filter store\'s "near"', () => {
  it('the center: a canonical place context wins over the viewer\'s point; a non-canonical one is not a center', () => {
    assert.deepEqual(searchNearCenter({ place: { id: PLACE, label: 'An Thuong' }, viewerPoint: ME }), { kind: 'place', placeId: PLACE, label: 'An Thuong' });
    assert.deepEqual(searchNearCenter({ place: { id: 'an-thuong', label: 'An Thuong' }, viewerPoint: ME }), { kind: 'viewer', ...ME });
    assert.deepEqual(searchNearCenter({ viewerPoint: ME }), { kind: 'viewer', ...ME });
    assert.equal(searchNearCenter({ viewerPoint: { lat: Number.NaN, lng: 1 } }), null);
    assert.equal(searchNearCenter({ viewerPoint: { lat: 95, lng: 1 } }), null);
    assert.equal(searchNearCenter({}), null, 'nothing to be near: no center is invented');
  });

  it('"near" is off until toggled, and a reset clears it', () => {
    assert.equal(INITIAL_MEDIA_FILTERS.near, false);
    const on = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'toggle_near' });
    assert.equal(on.near, true);
    assert.equal(mediaFilterReducer(on, { type: 'toggle_near' }).near, false);
    assert.equal(mediaFilterReducer(on, { type: 'reset' }).near, false);
  });

  it('what is sent: nothing while off or with no center; else the center and a radius the server accepts', () => {
    const on = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'toggle_near' });
    const viewer = searchNearCenter({ viewerPoint: ME });
    const place = searchNearCenter({ place: { id: PLACE, label: null } });
    assert.equal(toSearchNear(INITIAL_MEDIA_FILTERS, viewer), null);
    assert.equal(toSearchNear(on, null), null);
    assert.deepEqual(toSearchNear(on, viewer), { lat: ME.lat, lng: ME.lng, radiusM: 1500 });
    assert.deepEqual(toSearchNear(on, place), { placeId: PLACE, radiusM: 1500 });
    assert.ok(MEDIA_SEARCH_NEAR_RADIUS_M >= MEDIA_SEARCH_NEAR_RADIUS_MIN_M && MEDIA_SEARCH_NEAR_RADIUS_M <= MEDIA_SEARCH_NEAR_RADIUS_MAX_M);
    assert.equal(mediaSearchNearParams(toSearchNear(on, viewer)!)?.toString(), `nearLat=${ME.lat}&nearLng=${ME.lng}&radiusM=1500`);
    assert.equal(mediaSearchNearParams(toSearchNear(on, place)!)?.toString(), `nearPlaceId=${PLACE}&radiusM=1500`);
  });

  it('"near" is not a word in the query string, and the city stays the coarse city criterion', () => {
    let f = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'set_city', city: 'Da Nang' });
    f = mediaFilterReducer(f, { type: 'toggle_near' });
    assert.equal(toSearchQueryString(f), 'city=Da+Nang');
    assert.equal(toSearchQueryString(mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'toggle_near' })), null, 'the radius is sent by fetchMediaSearch, not smuggled into q');
  });

  it('the words: the chip says what and how near; the refusal says the center could not be placed', () => {
    assert.equal(nearRadiusLabel(1500), '1.5 km');
    assert.equal(nearRadiusLabel(2000), '2 km');
    assert.equal(nearRadiusLabel(800), '800 m');
    assert.equal(nearChipLabel({ kind: 'viewer', ...ME }), 'Near me · 1.5 km');
    assert.equal(nearChipLabel({ kind: 'place', placeId: PLACE, label: 'An Thuong' }), 'Near An Thuong · 1.5 km');
    assert.equal(nearChipLabel({ kind: 'place', placeId: PLACE, label: null }), 'Near this place · 1.5 km');
    const refused = nearRefusalCopy({ kind: 'place', placeId: PLACE, label: 'An Thuong' });
    assert.equal(refused.title, "We can't place that center");
    assert.match(refused.message, /no position for An Thuong/);
    assert.doesNotMatch(refused.message, /nothing matched/i);
    assert.match(nearRefusalCopy({ kind: 'viewer', ...ME }).message, /could not place where you are/);
  });
});
