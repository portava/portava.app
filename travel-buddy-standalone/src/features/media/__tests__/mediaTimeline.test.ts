/**
 * features/media — §17 Time Architecture mapper + degrade + presentation tests.
 *
 * Verifies the client timeline consumer against the REAL merged backend band
 * shape (artifacts/api-server/src/lib/media/mediaTimeBands.ts):
 *   • mapTimeline coerces the four bands (earlier / now / typical / likelyNext)
 *     and their items from the actual serialized shape;
 *   • the truth boundary holds on the CLIENT too — a prediction / pattern (or any
 *     non-observation, or anything outside the Now band) is NEVER kept live;
 *   • a forecast without a finite confidence is dropped, and a surviving forecast
 *     carries its confidence + a confidence chip label (§17);
 *   • the transport degrades: 404 / non-JSON / empty → an empty result (never a
 *     throw), and mapTimeline is safe on garbage.
 *
 * Pure node:test suite — imports only the service + pure state helpers (no
 * react-native), so it runs under `pnpm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapTimeline,
  isTimelineEmpty,
  fetchTimeline,
  _setTestFreshToken,
  _clearTestFreshToken,
} from '../services/mediaProjection.ts';
import {
  RENDER_CLASS_OBSERVATION,
  renderClassColor,
  confidenceChipLabel,
  confidenceBandLabel,
  nowIsLive,
  nowStateLabel,
} from '../state/timeBands.ts';

// A realistic GET /media/timeline payload in the real serialized band shape.
function fullPayload() {
  return {
    generatedAt: '2026-08-31T12:00:00.000Z',
    forecastAvailable: false,
    totalPerspectives: 2,
    rails: [{ key: 'now', label: 'Now', count: 0, media: [] }],
    bands: {
      earlier: {
        key: 'earlier',
        label: 'Earlier',
        renderClass: 'observed',
        live: false,
        forecast: false,
        count: 1,
        items: [
          {
            itemKind: 'media',
            renderClass: 'observed',
            intelSourceClass: null,
            observedAt: '2026-08-30T10:00:00.000Z',
            label: 'An Thuong',
            claimType: null,
            value: null,
            media: {
              id: 'm1',
              mediaType: 'image',
              capturedAt: '2026-08-30T10:00:00.000Z',
              observationClass: 'observed',
              freshness: 'recent',
            },
            confidence: null,
            confidenceBand: null,
            live: false,
          },
        ],
      },
      now: {
        key: 'now',
        label: 'Now',
        renderClass: 'observed',
        live: true,
        forecast: false,
        count: 1,
        items: [
          {
            itemKind: 'liveClaim',
            renderClass: 'observed',
            intelSourceClass: 'verified_firsthand',
            observedAt: '2026-08-31T11:58:00.000Z',
            label: 'Busy',
            claimType: 'busyness',
            value: { level: 'busy' },
            media: null,
            confidence: 0.82,
            confidenceBand: 'live',
            live: true,
          },
        ],
      },
      typical: {
        key: 'typical',
        label: 'Typically',
        renderClass: 'typical',
        live: false,
        forecast: false,
        count: 1,
        items: [
          {
            itemKind: 'pattern',
            renderClass: 'typical',
            intelSourceClass: 'historical_pattern',
            observedAt: '2026-08-20T00:00:00.000Z',
            label: 'Typical pattern · busyness',
            claimType: 'busyness',
            value: { level: 'moderate' },
            media: null,
            confidence: null,
            confidenceBand: null,
            live: false,
          },
        ],
      },
      likelyNext: {
        key: 'likelyNext',
        label: 'Likely next',
        renderClass: 'predicted',
        live: false,
        forecast: true,
        count: 1,
        items: [
          {
            itemKind: 'prediction',
            renderClass: 'predicted',
            intelSourceClass: 'portava_prediction',
            observedAt: '2026-08-31T11:00:00.000Z',
            label: 'Portava prediction · busyness',
            claimType: 'busyness',
            value: { confidence: 0.66 },
            media: null,
            confidence: 0.66,
            confidenceBand: 'likely_current',
            live: false,
          },
        ],
      },
    },
  };
}

// ── Mapper: real band shape ───────────────────────────────────────────────────

test('mapTimeline maps the four bands from the real §17 shape', () => {
  const t = mapTimeline(fullPayload());
  assert.equal(t.generatedAt, '2026-08-31T12:00:00.000Z');

  // Earlier: observed media, never live.
  assert.equal(t.bands.earlier.key, 'earlier');
  assert.equal(t.bands.earlier.renderClass, 'observed');
  assert.equal(t.bands.earlier.live, false);
  assert.equal(t.bands.earlier.count, 1);
  assert.equal(t.bands.earlier.items[0].media?.id, 'm1');

  // Now: the ONLY band that may be live, and here it is.
  assert.equal(t.bands.now.live, true);
  assert.equal(t.bands.now.items[0].live, true);
  assert.equal(t.bands.now.items[0].label, 'Busy');
  assert.equal(t.bands.now.items[0].confidence, 0.82);

  // Typical: a historical pattern, indigo render class, never live.
  assert.equal(t.bands.typical.renderClass, 'typical');
  assert.equal(t.bands.typical.live, false);
  assert.equal(t.bands.typical.items[0].live, false);

  // Likely next: a forecast carrying its confidence band.
  assert.equal(t.bands.likelyNext.forecast, true);
  assert.equal(t.bands.likelyNext.items[0].confidence, 0.66);
  assert.equal(t.bands.likelyNext.items[0].confidenceBand, 'likely_current');
});

// ── Truth boundary: never render predicted / typical as live ──────────────────

test('never renders a prediction or pattern as live, even if the payload says so', () => {
  const p = fullPayload();
  // A hostile / mutated payload marks non-observations live.
  p.bands.typical.live = true;
  (p.bands.typical.items[0] as { live: boolean }).live = true;
  p.bands.likelyNext.live = true;
  (p.bands.likelyNext.items[0] as { live: boolean }).live = true;

  const t = mapTimeline(p);
  assert.equal(t.bands.typical.live, false);
  assert.equal(t.bands.typical.items[0].live, false);
  assert.equal(t.bands.likelyNext.live, false);
  assert.equal(t.bands.likelyNext.items[0].live, false);
});

test('an observed item marked live OUTSIDE the Now band is scrubbed to not-live', () => {
  const p = fullPayload();
  // Earlier is observed — but a live flag on it is still a truth-boundary breach.
  (p.bands.earlier.items[0] as { live: boolean }).live = true;
  p.bands.earlier.live = true;

  const t = mapTimeline(p);
  assert.equal(t.bands.earlier.items[0].live, false);
  assert.equal(t.bands.earlier.live, false);
});

test('a Now item that is not an observed render class cannot be live', () => {
  const p = fullPayload();
  // Corrupt the Now item to a predicted class while keeping live:true.
  (p.bands.now.items[0] as { renderClass: string }).renderClass = 'predicted';
  const t = mapTimeline(p);
  // predicted-in-now with confidence stays as an item, but never live.
  assert.equal(t.bands.now.items[0].live, false);
  assert.equal(t.bands.now.live, false);
});

// ── Forecast must carry confidence ────────────────────────────────────────────

test('a forecast without a finite confidence is dropped (§17)', () => {
  const p = fullPayload();
  (p.bands.likelyNext.items[0] as { confidence: number | null }).confidence = null;
  const t = mapTimeline(p);
  assert.equal(t.bands.likelyNext.items.length, 0);
  assert.equal(t.bands.likelyNext.count, 0);
});

test('a forecast with out-of-range confidence is dropped', () => {
  for (const bad of [1.4, -0.2, Number.NaN, 'high']) {
    const p = fullPayload();
    (p.bands.likelyNext.items[0] as { confidence: unknown }).confidence = bad;
    const t = mapTimeline(p);
    assert.equal(t.bands.likelyNext.items.length, 0);
  }
});

test('a surviving forecast keeps its confidence and renders a confidence chip', () => {
  const t = mapTimeline(fullPayload());
  const f = t.bands.likelyNext.items[0];
  assert.equal(f.confidence, 0.66);
  assert.equal(confidenceChipLabel(f.confidence, f.confidenceBand), 'Likely · 66%');
});

// ── Presentation helpers (pure) ───────────────────────────────────────────────

test('render classes map to three distinct observation hues (§46)', () => {
  assert.equal(RENDER_CLASS_OBSERVATION.observed, 'observed');
  assert.equal(RENDER_CLASS_OBSERVATION.typical, 'inferred');
  assert.equal(RENDER_CLASS_OBSERVATION.predicted, 'predicted');
  const hues = new Set([
    renderClassColor('observed'),
    renderClassColor('typical'),
    renderClassColor('predicted'),
  ]);
  assert.equal(hues.size, 3);
});

test('confidenceBandLabel never says "live" for a forecast band (§46.2)', () => {
  assert.equal(confidenceBandLabel('live'), 'High confidence');
  assert.equal(confidenceBandLabel('likely_current'), 'Likely');
  assert.equal(confidenceBandLabel(null), 'Likely');
});

test('nowStateLabel is live only for a genuinely-live Now band', () => {
  const t = mapTimeline(fullPayload());
  assert.equal(nowIsLive(t.bands.now), true);
  assert.equal(nowStateLabel(t.bands.now), 'Busy');

  // No live claim → neutral, never fabricated (§46.2).
  const p = fullPayload();
  p.bands.now.live = false;
  (p.bands.now.items[0] as { live: boolean }).live = false;
  const t2 = mapTimeline(p);
  assert.equal(nowIsLive(t2.bands.now), false);
  assert.equal(nowStateLabel(t2.bands.now), 'No current read');
});

// ── Degrade path ──────────────────────────────────────────────────────────────

test('mapTimeline is safe on garbage → four well-formed empty bands', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    const t = mapTimeline(bad);
    assert.equal(t.bands.earlier.items.length, 0);
    assert.equal(t.bands.now.items.length, 0);
    assert.equal(t.bands.typical.items.length, 0);
    assert.equal(t.bands.likelyNext.items.length, 0);
    assert.equal(t.bands.now.live, false);
    assert.equal(isTimelineEmpty(t), true);
  }
});

test('isTimelineEmpty is false when any band has an item', () => {
  assert.equal(isTimelineEmpty(mapTimeline(fullPayload())), false);
});

function stubFetch(impl: () => Promise<Response>) {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
  return () => {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  };
}

test('fetchTimeline: 404 degrades to empty (not error), never throws', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('not found', { status: 404 }));
  try {
    const r = await fetchTimeline({ placeId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'empty');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchTimeline: 200 with non-JSON body degrades to empty', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('<html>oops</html>', { status: 200 }));
  try {
    const r = await fetchTimeline();
    assert.equal(r.ok === false && r.errorKind, 'empty');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchTimeline: network throw is classified, never rethrown', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => {
    throw new Error('network request failed');
  });
  try {
    const r = await fetchTimeline();
    assert.equal(r.ok === false && r.errorKind, 'network');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchTimeline: success maps the bands and keeps the truth boundary', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(
    async () =>
      new Response(JSON.stringify(fullPayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  try {
    const r = await fetchTimeline({ placeId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.bands.now.items[0].live, true);
    assert.equal(r.ok && r.data.bands.likelyNext.items[0].confidence, 0.66);
  } finally {
    restore();
    _clearTestFreshToken();
  }
});
