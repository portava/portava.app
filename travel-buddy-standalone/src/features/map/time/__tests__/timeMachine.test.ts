/**
 * timeMachine — Map spec §15 tests.
 *
 * The three things worth testing here, in order of how expensive they are to
 * get wrong:
 *
 *  1. §37 "Do not make predictions look like observations." — `toTemporalObject`
 *     and `assertTemporalIntegrity` must make the mislabelling unreachable.
 *  2. The calendar rules. "Last Friday" and "Tonight" are the two controls that
 *     cannot be implemented by adding milliseconds, so they are tested across
 *     week boundaries, month/year boundaries, a Sunday/Monday edge, and a DST
 *     transition.
 *  3. The timeline support floor. A band is an aggregate claim; one object must
 *     never make one.
 *
 * Every test pins an explicit IANA zone, so results do not depend on the
 * machine's timezone.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx/esm --test src/features/map/time/__tests__/timeMachine.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOW_OFFSET,
  PRIMARY_OFFSETS,
  SECONDARY_OFFSETS,
  NAMED_OFFSETS,
  MIN_BAND_SUPPORT,
  BAND_SUPPORT_MIN_CONFIDENCE,
  BAND_DURATION_MINUTES,
  TONIGHT_ANCHOR_HOUR,
  TONIGHT_START_HOUR,
  TONIGHT_END_HOUR,
  TREND_BAND_LEAD_MINUTES,
  RELATIVE_WINDOW_HALF_WIDTH_MINUTES,
  resolveOffset,
  temporalModeOf,
  toTemporalObject,
  toTemporalObjects,
  assertTemporalIntegrity,
  TemporalIntegrityError,
  isForecastObject,
  isObservedObject,
  cityTimeline,
  qualifiesAsBandSupport,
  offsetLabel,
  offsetKey,
  offsetsEqual,
  forecastBadgeLabel,
  formatClock,
  zonedFields,
  daysBackToWeekday,
  addCalendarDays,
  temporalStatusLine,
  type TimeOffset,
} from '../timeMachine.ts';
import {
  isForecastKind,
  mayRenderAsLive,
  point,
  type MapObject,
  type ActivityLevel,
  type ConfidenceState,
  type TrendState,
} from '../../../../types/mapObjects.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TZ = 'Asia/Ho_Chi_Minh'; // UTC+7, no DST — the Da Nang launch city.
const NY = 'America/New_York'; // has DST — used for the transition test.

/**
 * Build an instant from wall-clock fields in `tz`, so the tests read as local
 * time. Deliberately hand-rolled rather than calling the module's own
 * `fromZonedFields` — a fixture that shares the implementation under test would
 * agree with it even when both are wrong.
 */
function at(tz: string, y: number, mo: number, d: number, h: number, mi = 0): Date {
  const guessUTC = Date.UTC(y, mo - 1, d, h, mi, 0);
  const g1 = zonedFields(new Date(guessUTC), tz);
  const asUTC1 = Date.UTC(g1.year, g1.month - 1, g1.day, g1.hour, g1.minute, g1.second);
  let inst = guessUTC - (asUTC1 - guessUTC);
  const g2 = zonedFields(new Date(inst), tz);
  const asUTC2 = Date.UTC(g2.year, g2.month - 1, g2.day, g2.hour, g2.minute, g2.second);
  inst = inst - (asUTC2 - guessUTC);
  return new Date(inst);
}

function wall(d: Date, tz: string): string {
  const f = zonedFields(d, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${f.year}-${p(f.month)}-${p(f.day)} ${p(f.hour)}:${p(f.minute)}`;
}

function makeObject(over: Partial<MapObject> & { id: string }): MapObject {
  return {
    kind: 'activity_zone',
    geometry: point(16.06, 108.22),
    title: 'An Thuong',
    privacyClass: 'aggregate_only',
    renderingPriority: 50,
    ...over,
  };
}

function zoneWith(
  id: string,
  trend: TrendState,
  activity: ActivityLevel,
  confidence: ConfidenceState,
): MapObject {
  return makeObject({ id, trend, activity, confidence });
}

// ── The controls ──────────────────────────────────────────────────────────────

describe('§15 controls — the offset union', () => {
  it('exposes the primary row exactly as the spec lists it', () => {
    assert.deepEqual(PRIMARY_OFFSETS.map(offsetLabel), ['NOW', '+30m', '+60m', '+120m']);
  });

  it('exposes the later controls exactly as the spec lists them', () => {
    assert.deepEqual(SECONDARY_OFFSETS.map(offsetLabel), [
      'Yesterday',
      'Tonight',
      'Tomorrow',
      'Last Friday',
    ]);
    assert.deepEqual([...NAMED_OFFSETS], ['yesterday', 'tonight', 'tomorrow', 'last_friday']);
  });

  it('keys and compares offsets structurally, not by label', () => {
    assert.equal(offsetKey({ kind: 'relative', minutes: 60 }), 'rel:60');
    assert.equal(offsetKey({ kind: 'named', name: 'tonight' }), 'named:tonight');
    assert.ok(offsetsEqual({ kind: 'relative', minutes: 60 }, { kind: 'relative', minutes: 60 }));
    assert.ok(!offsetsEqual({ kind: 'relative', minutes: 60 }, { kind: 'relative', minutes: 30 }));
    // 'now' and '+0m' are different CONTROLS even though they resolve alike.
    assert.ok(!offsetsEqual(NOW_OFFSET, { kind: 'relative', minutes: 0 }));
  });

  it('labels past and long relative offsets', () => {
    assert.equal(offsetLabel({ kind: 'relative', minutes: -90 }), '−90m');
    assert.equal(offsetLabel({ kind: 'relative', minutes: 180 }), '+3h');
    assert.equal(offsetLabel({ kind: 'relative', minutes: 0 }), 'NOW');
  });
});

// ── resolveOffset: NOW and relative ───────────────────────────────────────────

describe('resolveOffset — NOW and the +Nm row', () => {
  const now = at(TZ, 2026, 8, 31, 14, 0);

  it('NOW resolves to now and classifies as now', () => {
    const r = resolveOffset(NOW_OFFSET, now, TZ);
    assert.equal(r.at.getTime(), now.getTime());
    assert.equal(r.mode, 'now');
  });

  it('+30m / +60m / +120m resolve forward and classify as forecast', () => {
    for (const m of [30, 60, 120]) {
      const r = resolveOffset({ kind: 'relative', minutes: m }, now, TZ);
      assert.equal(r.at.getTime() - now.getTime(), m * 60_000, `+${m}m instant`);
      assert.equal(r.mode, 'forecast', `+${m}m mode`);
    }
  });

  it('states the width of the window a relative forecast covers', () => {
    const r = resolveOffset({ kind: 'relative', minutes: 60 }, now, TZ);
    const half = RELATIVE_WINDOW_HALF_WIDTH_MINUTES * 60_000;
    assert.equal(r.at.getTime() - r.windowStartsAt.getTime(), half);
    assert.equal(r.windowEndsAt.getTime() - r.at.getTime(), half);
  });

  it('a negative relative offset is historical, not a forecast', () => {
    assert.equal(temporalModeOf({ kind: 'relative', minutes: -60 }, now, TZ), 'historical');
  });

  it('a tiny drift around now still reads as now (tolerance)', () => {
    // Without NOW_TOLERANCE_MS this flips to historical the moment the clock ticks.
    const r = resolveOffset({ kind: 'relative', minutes: 0 }, now, TZ);
    assert.equal(r.mode, 'now');
  });
});

// ── resolveOffset: Yesterday / Tomorrow ───────────────────────────────────────

describe('resolveOffset — Yesterday and Tomorrow (same wall clock, ±1 calendar day)', () => {
  const yesterday: TimeOffset = { kind: 'named', name: 'yesterday' };
  const tomorrow: TimeOffset = { kind: 'named', name: 'tomorrow' };

  it('Yesterday crosses a month boundary backwards', () => {
    const now = at(TZ, 2026, 9, 1, 14, 30); // Tue 1 Sep
    const r = resolveOffset(yesterday, now, TZ);
    assert.equal(wall(r.at, TZ), '2026-08-31 14:30');
    assert.equal(r.mode, 'historical');
  });

  it('Tomorrow crosses a month boundary forwards', () => {
    const now = at(TZ, 2026, 8, 31, 9, 5); // Mon 31 Aug
    const r = resolveOffset(tomorrow, now, TZ);
    assert.equal(wall(r.at, TZ), '2026-09-01 09:05');
    assert.equal(r.mode, 'forecast');
  });

  it('Tomorrow crosses a non-leap February end', () => {
    const now = at(TZ, 2026, 2, 28, 20, 0);
    const r = resolveOffset(tomorrow, now, TZ);
    assert.equal(wall(r.at, TZ), '2026-03-01 20:00'); // 2026 is not a leap year
  });

  it('Yesterday crosses a year boundary backwards', () => {
    const now = at(TZ, 2026, 1, 1, 0, 30);
    const r = resolveOffset(yesterday, now, TZ);
    assert.equal(wall(r.at, TZ), '2025-12-31 00:30');
  });

  it('windows the whole local calendar day, not ±24h from the instant', () => {
    const now = at(TZ, 2026, 9, 1, 14, 30);
    const r = resolveOffset(yesterday, now, TZ);
    assert.equal(wall(r.windowStartsAt, TZ), '2026-08-31 00:00');
    assert.equal(wall(r.windowEndsAt, TZ), '2026-09-01 00:00');
  });

  it('preserves the WALL CLOCK across a DST transition, not the elapsed hours', () => {
    // US DST begins Sun 8 Mar 2026 at 02:00 local.
    const now = at(NY, 2026, 3, 8, 10, 0); // EDT
    const r = resolveOffset(yesterday, now, NY);
    assert.equal(wall(r.at, NY), '2026-03-07 10:00'); // EST — same wall clock
    // Only 23 real hours elapsed: spring-forward makes that calendar day short.
    // Subtracting 24h would have landed on 09:00 and mis-dated the whole view,
    // so this number IS the proof the arithmetic was calendrical.
    assert.equal(now.getTime() - r.at.getTime(), 23 * 3_600_000);
  });

  it('holds in the other direction too (fall back — a 25-hour day)', () => {
    // US DST ends Sun 1 Nov 2026 at 02:00 local.
    const now = at(NY, 2026, 11, 1, 10, 0); // EST
    const r = resolveOffset(yesterday, now, NY);
    assert.equal(wall(r.at, NY), '2026-10-31 10:00'); // EDT — same wall clock
    assert.equal(now.getTime() - r.at.getTime(), 25 * 3_600_000);
  });
});

// ── resolveOffset: Last Friday ────────────────────────────────────────────────

describe('resolveOffset — Last Friday (most recent Friday STRICTLY before today)', () => {
  const lastFriday: TimeOffset = { kind: 'named', name: 'last_friday' };

  it('steps back the right number of days from every weekday', () => {
    // Sun 30 Aug 2026 → Fri 28 Aug (2 back);  Mon 31 Aug → Fri 28 Aug (3 back).
    assert.equal(daysBackToWeekday(0, 5), 2, 'Sunday');
    assert.equal(daysBackToWeekday(1, 5), 3, 'Monday');
    assert.equal(daysBackToWeekday(6, 5), 1, 'Saturday');
    assert.equal(daysBackToWeekday(5, 5), 7, 'Friday → the PREVIOUS Friday');
  });

  it('the Sunday/Monday edge lands on the same Friday', () => {
    const sun = resolveOffset(lastFriday, at(TZ, 2026, 8, 30, 19, 0), TZ); // Sun 30 Aug
    const mon = resolveOffset(lastFriday, at(TZ, 2026, 8, 31, 19, 0), TZ); // Mon 31 Aug
    assert.equal(wall(sun.at, TZ), '2026-08-28 19:00');
    assert.equal(wall(mon.at, TZ), '2026-08-28 19:00');
  });

  it('asked ON a Friday it means the previous Friday, never today', () => {
    const now = at(TZ, 2026, 9, 4, 21, 0); // Fri 4 Sep
    const r = resolveOffset(lastFriday, now, TZ);
    assert.equal(wall(r.at, TZ), '2026-08-28 21:00');
    assert.equal(r.mode, 'historical');
  });

  it('crosses a month boundary', () => {
    const now = at(TZ, 2026, 9, 2, 12, 0); // Wed 2 Sep
    assert.equal(wall(resolveOffset(lastFriday, now, TZ).at, TZ), '2026-08-28 12:00');
  });

  it('crosses a year boundary', () => {
    const now = at(TZ, 2026, 1, 1, 12, 0); // Thu 1 Jan 2026
    assert.equal(wall(resolveOffset(lastFriday, now, TZ).at, TZ), '2025-12-26 12:00');
  });

  it('windows the whole Friday', () => {
    const r = resolveOffset(lastFriday, at(TZ, 2026, 8, 31, 19, 0), TZ);
    assert.equal(wall(r.windowStartsAt, TZ), '2026-08-28 00:00');
    assert.equal(wall(r.windowEndsAt, TZ), '2026-08-29 00:00');
  });

  it('addCalendarDays keeps the wall clock and recomputes the weekday', () => {
    const f = zonedFields(at(TZ, 2026, 8, 31, 23, 45), TZ);
    assert.equal(f.weekday, 1); // Monday
    const next = addCalendarDays(f, 1);
    assert.deepEqual(
      [next.year, next.month, next.day, next.hour, next.minute, next.weekday],
      [2026, 9, 1, 23, 45, 2],
    );
  });
});

// ── resolveOffset: Tonight ────────────────────────────────────────────────────

describe('resolveOffset — Tonight (the evening band, not a fixed instant)', () => {
  const tonight: TimeOffset = { kind: 'named', name: 'tonight' };

  it('asked in the afternoon it is a FORECAST of the evening ahead', () => {
    const now = at(TZ, 2026, 8, 31, 15, 0);
    const r = resolveOffset(tonight, now, TZ);
    assert.equal(wall(r.at, TZ), `2026-08-31 ${String(TONIGHT_ANCHOR_HOUR).padStart(2, '0')}:00`);
    assert.equal(r.mode, 'forecast');
    assert.equal(wall(r.windowStartsAt, TZ), `2026-08-31 ${String(TONIGHT_START_HOUR).padStart(2, '0')}:00`);
    assert.equal(wall(r.windowEndsAt, TZ), `2026-09-01 ${String(TONIGHT_END_HOUR).padStart(2, '0')}:00`);
  });

  it('asked inside the band it is NOW — you are in tonight', () => {
    const now = at(TZ, 2026, 8, 31, 22, 30);
    const r = resolveOffset(tonight, now, TZ);
    assert.equal(r.mode, 'now');
    assert.equal(r.at.getTime(), now.getTime());
  });

  it('asked in the small hours it refers to the band that opened YESTERDAY evening', () => {
    const now = at(TZ, 2026, 9, 1, 1, 0); // 01:00 — still last night
    const r = resolveOffset(tonight, now, TZ);
    assert.equal(wall(r.windowStartsAt, TZ), '2026-08-31 18:00');
    assert.equal(wall(r.windowEndsAt, TZ), '2026-09-01 02:00');
    assert.equal(r.mode, 'now');
  });

  it('once the band has closed it means the evening ahead again', () => {
    const now = at(TZ, 2026, 9, 1, 3, 0); // 03:00 — band closed at 02:00
    const r = resolveOffset(tonight, now, TZ);
    assert.equal(wall(r.windowStartsAt, TZ), '2026-09-01 18:00');
    assert.equal(wall(r.at, TZ), '2026-09-01 21:00');
    assert.equal(r.mode, 'forecast');
  });

  it('crosses a month boundary at the far end of the band', () => {
    const now = at(TZ, 2026, 8, 31, 16, 0);
    const r = resolveOffset(tonight, now, TZ);
    assert.equal(wall(r.windowEndsAt, TZ), '2026-09-01 02:00');
  });
});

// ── TemporalMode ──────────────────────────────────────────────────────────────

describe('temporalModeOf — the single source of truth for the §15 distinction', () => {
  const now = at(TZ, 2026, 8, 31, 14, 0); // Mon afternoon

  it('classifies every control', () => {
    const cases: Array<[TimeOffset, string]> = [
      [NOW_OFFSET, 'now'],
      [{ kind: 'relative', minutes: 30 }, 'forecast'],
      [{ kind: 'relative', minutes: 120 }, 'forecast'],
      [{ kind: 'relative', minutes: -30 }, 'historical'],
      [{ kind: 'named', name: 'yesterday' }, 'historical'],
      [{ kind: 'named', name: 'last_friday' }, 'historical'],
      [{ kind: 'named', name: 'tomorrow' }, 'forecast'],
      [{ kind: 'named', name: 'tonight' }, 'forecast'], // 14:00 → evening ahead
    ];
    for (const [offset, expected] of cases) {
      assert.equal(temporalModeOf(offset, now, TZ), expected, offsetLabel(offset));
    }
  });

  it('agrees with resolveOffset (one decision, not two)', () => {
    for (const o of [...PRIMARY_OFFSETS, ...SECONDARY_OFFSETS]) {
      assert.equal(temporalModeOf(o, now, TZ), resolveOffset(o, now, TZ).mode);
    }
  });
});

// ── toTemporalObject ──────────────────────────────────────────────────────────

describe('toTemporalObject — §37: a prediction must never look like an observation', () => {
  const now = at(TZ, 2026, 8, 31, 14, 0);

  const liveZone = makeObject({
    id: 'z1',
    kind: 'activity_zone',
    freshness: 'live',
    confidence: 'likely_current',
    activity: 'busy',
    trend: 'getting_busier',
    observedAt: now.toISOString(),
  });

  it('coerces kind to prediction so isForecastKind() is true downstream', () => {
    const t = toTemporalObject(liveZone, { kind: 'relative', minutes: 60 }, { now, tz: TZ });
    assert.equal(t.temporalMode, 'forecast');
    assert.equal(t.kind, 'prediction');
    assert.ok(isForecastKind(t.kind), 'zoneStyle must see a forecast kind (§6 dashed boundary)');
  });

  it('drops a live freshness — a prediction is never live', () => {
    const t = toTemporalObject(liveZone, { kind: 'relative', minutes: 60 }, { now, tz: TZ });
    assert.ok(isForecastObject(t));
    assert.equal(t.freshness, undefined);
    assert.equal(mayRenderAsLive(t.freshness), false);
  });

  it('drops a "recent" freshness too — mayRenderAsLive is the test, not a hardcoded list', () => {
    const recent = makeObject({ id: 'z2', freshness: 'recent', confidence: 'strong' });
    const t = toTemporalObject(recent, { kind: 'relative', minutes: 30 }, { now, tz: TZ });
    assert.equal(mayRenderAsLive((t as { freshness?: never }).freshness), false);
  });

  it('keeps a non-live freshness rather than blanking it', () => {
    const aging = makeObject({ id: 'z3', freshness: 'aging', confidence: 'provisional' });
    const t = toTemporalObject(aging, { kind: 'relative', minutes: 30 }, { now, tz: TZ });
    assert.ok(isForecastObject(t));
    assert.equal(t.freshness, 'aging');
  });

  it('drops observedAt — nothing observed a prediction', () => {
    const t = toTemporalObject(liveZone, { kind: 'named', name: 'tomorrow' }, { now, tz: TZ });
    assert.equal((t as Record<string, unknown>).observedAt, undefined);
    assert.ok(isForecastObject(t));
    assert.equal(t.predictedFor, resolveOffset({ kind: 'named', name: 'tomorrow' }, now, TZ).at.toISOString());
  });

  it('always carries forecast confidence, preferring the supplied one', () => {
    const explicit = toTemporalObject(liveZone, { kind: 'relative', minutes: 60 }, {
      now,
      tz: TZ,
      forecastConfidence: 'provisional',
    });
    assert.ok(isForecastObject(explicit));
    assert.equal(explicit.forecastConfidence, 'provisional');

    const inherited = toTemporalObject(liveZone, { kind: 'relative', minutes: 60 }, { now, tz: TZ });
    assert.ok(isForecastObject(inherited));
    assert.equal(inherited.forecastConfidence, 'likely_current');
  });

  it('fails CLOSED to unverified when nothing supplied a confidence', () => {
    const bare = makeObject({ id: 'z4' });
    const t = toTemporalObject(bare, { kind: 'relative', minutes: 120 }, { now, tz: TZ });
    assert.ok(isForecastObject(t));
    assert.equal(t.forecastConfidence, 'unverified');
  });

  it('a prediction stays a forecast even at NOW and at a historical offset', () => {
    const pred = makeObject({ id: 'p1', kind: 'prediction', confidence: 'provisional' });
    for (const o of [NOW_OFFSET, { kind: 'named', name: 'yesterday' } as TimeOffset]) {
      const t = toTemporalObject(pred, o, { now, tz: TZ });
      assert.equal(t.temporalMode, 'forecast', offsetLabel(o));
      assert.equal(t.kind, 'prediction');
    }
  });

  it('a historical view reads as historical, never as live', () => {
    const t = toTemporalObject(liveZone, { kind: 'named', name: 'last_friday' }, { now, tz: TZ });
    assert.equal(t.temporalMode, 'historical');
    assert.ok(isObservedObject(t));
    assert.equal((t as { freshness: string }).freshness, 'historical');
    assert.equal(mayRenderAsLive((t as { freshness: 'historical' }).freshness), false);
    assert.equal((t as Record<string, unknown>).forecastConfidence, undefined);
  });

  it('the present passes through untouched apart from the temporal stamp', () => {
    const t = toTemporalObject(liveZone, NOW_OFFSET, { now, tz: TZ });
    assert.equal(t.temporalMode, 'now');
    assert.equal(t.kind, 'activity_zone');
    assert.equal((t as { freshness?: string }).freshness, 'live');
    assert.equal(t.resolvedAt, now.toISOString());
    assert.equal(t.temporalOffsetKey, 'now');
  });

  it('preserves the projection\'s privacy class and §31 priority', () => {
    const t = toTemporalObject(liveZone, { kind: 'relative', minutes: 60 }, { now, tz: TZ });
    assert.equal(t.privacyClass, 'aggregate_only');
    assert.equal(t.renderingPriority, 50);
  });

  it('converts a whole projection without dropping anything', () => {
    const list = [liveZone, makeObject({ id: 'z9', confidence: 'strong' })];
    const out = toTemporalObjects(list, { kind: 'relative', minutes: 30 }, { now, tz: TZ });
    assert.equal(out.length, 2);
    assert.ok(out.every((o) => o.temporalMode === 'forecast'));
  });

  it('every conversion it produces survives the runtime assertion', () => {
    for (const o of [...PRIMARY_OFFSETS, ...SECONDARY_OFFSETS]) {
      const t = toTemporalObject(liveZone, o, { now, tz: TZ });
      assert.doesNotThrow(() => assertTemporalIntegrity(t), offsetLabel(o));
    }
  });
});

// ── assertTemporalIntegrity ───────────────────────────────────────────────────

describe('assertTemporalIntegrity — the wire boundary where types do not reach', () => {
  const base = {
    id: 'w1',
    kind: 'prediction',
    geometry: point(16.06, 108.22),
    title: 'An Thuong',
    privacyClass: 'aggregate_only',
    renderingPriority: 50,
    temporalMode: 'forecast',
    resolvedAt: '2026-08-31T15:00:00.000Z',
    predictedFor: '2026-08-31T15:00:00.000Z',
    forecastConfidence: 'provisional',
  };

  it('accepts a well-formed forecast', () => {
    assert.doesNotThrow(() => assertTemporalIntegrity({ ...base }));
  });

  it('REJECTS a forecast with no forecast confidence (§15)', () => {
    const { forecastConfidence: _drop, ...bad } = base;
    void _drop;
    assert.throws(() => assertTemporalIntegrity(bad), (e: unknown) => {
      assert.ok(e instanceof TemporalIntegrityError);
      assert.match(e.message, /forecast confidence/);
      assert.equal(e.objectId, 'w1');
      return true;
    });
  });

  it('REJECTS a forecast whose kind is not a forecast kind', () => {
    assert.throws(
      () => assertTemporalIntegrity({ ...base, kind: 'activity_zone' }),
      /kind 'prediction'/,
    );
  });

  it('REJECTS a forecast wearing a live freshness', () => {
    assert.throws(() => assertTemporalIntegrity({ ...base, freshness: 'live' }), /never live/);
    assert.throws(() => assertTemporalIntegrity({ ...base, freshness: 'recent' }), /never live/);
  });

  it('REJECTS a forecast carrying an observation timestamp', () => {
    assert.throws(
      () => assertTemporalIntegrity({ ...base, observedAt: '2026-08-31T14:00:00.000Z' }),
      /never observed/,
    );
  });

  it('REJECTS a prediction presented as an observation', () => {
    assert.throws(
      () => assertTemporalIntegrity({ ...base, temporalMode: 'now' }),
      /cannot be presented as an observation/,
    );
  });

  it('REJECTS an observation borrowing forecast confidence', () => {
    assert.throws(
      () =>
        assertTemporalIntegrity({
          ...base,
          kind: 'activity_zone',
          temporalMode: 'now',
          forecastConfidence: 'strong',
        }),
      /predicts nothing/,
    );
  });

  it('REJECTS a historical view that does not read as historical', () => {
    const { forecastConfidence: _c, predictedFor: _p, ...rest } = base;
    void _c;
    void _p;
    assert.throws(
      () => assertTemporalIntegrity({ ...rest, kind: 'activity_zone', temporalMode: 'historical', freshness: 'live' }),
      /read as historical/,
    );
  });

  it('REJECTS junk', () => {
    assert.throws(() => assertTemporalIntegrity(null), /must be an object/);
    assert.throws(() => assertTemporalIntegrity({ ...base, temporalMode: 'someday' }), /temporalMode must be/);
    assert.throws(() => assertTemporalIntegrity({ ...base, resolvedAt: 'not-a-date' }), /ISO instant/);
  });
});

// ── cityTimeline ──────────────────────────────────────────────────────────────

describe('cityTimeline — §15 expected peaks and cooling periods', () => {
  const now = at(TZ, 2026, 8, 31, 14, 0);

  it('REFUSES to emit a band from a single object', () => {
    const t = cityTimeline([zoneWith('a', 'getting_busier', 'busy', 'strong')], NOW_OFFSET, now, TZ);
    assert.equal(t.bands.length, 0);
    assert.equal(t.qualifyingObjects, 1);
    assert.equal(MIN_BAND_SUPPORT, 2);
  });

  it('REFUSES to count unconfirmed objects toward support at all', () => {
    const t = cityTimeline(
      [
        zoneWith('a', 'getting_busier', 'busy', 'unverified'),
        zoneWith('b', 'getting_busier', 'very_busy', 'unverified'),
        zoneWith('c', 'getting_busier', 'peak', 'unverified'),
      ],
      NOW_OFFSET,
      now,
      TZ,
    );
    assert.equal(t.bands.length, 0, 'three unconfirmed reports are still not a city claim');
    assert.equal(t.qualifyingObjects, 0);
    assert.equal(BAND_SUPPORT_MIN_CONFIDENCE, 'provisional');
  });

  it('emits a peak band once the support floor is met', () => {
    const t = cityTimeline(
      [
        zoneWith('a', 'getting_busier', 'busy', 'provisional'),
        zoneWith('b', 'getting_busier', 'very_busy', 'strong'),
      ],
      NOW_OFFSET,
      now,
      TZ,
    );
    assert.equal(t.bands.length, 1);
    const b = t.bands[0];
    assert.equal(b.kind, 'peak');
    assert.equal(b.support, 2);
    assert.equal(b.level, 'very_busy', 'a peak takes the highest reported level');
    assert.equal(b.confidence, 'provisional', 'band confidence fails closed to the weakest supporter');
    assert.equal(b.isForecast, true);
    assert.match(b.label, /^Peak expected · Very Busy$/);
    const lead = TREND_BAND_LEAD_MINUTES.getting_busier as number;
    assert.equal(Date.parse(b.startsAt) - now.getTime(), lead * 60_000);
    assert.equal(Date.parse(b.endsAt) - Date.parse(b.startsAt), BAND_DURATION_MINUTES * 60_000);
  });

  it('emits a cooling band and takes the LOWEST level (where it is heading)', () => {
    const t = cityTimeline(
      [
        zoneWith('a', 'cooling', 'moderate', 'strong'),
        zoneWith('b', 'cooling', 'quiet', 'likely_current'),
      ],
      NOW_OFFSET,
      now,
      TZ,
    );
    assert.equal(t.bands.length, 1);
    assert.equal(t.bands[0].kind, 'cooling');
    assert.equal(t.bands[0].level, 'quiet');
  });

  it('ignores stable zones — they imply neither a peak nor a cooling period', () => {
    const t = cityTimeline(
      [zoneWith('a', 'stable', 'busy', 'strong'), zoneWith('b', 'stable', 'busy', 'strong')],
      NOW_OFFSET,
      now,
      TZ,
    );
    assert.equal(t.bands.length, 0);
    assert.equal(t.qualifyingObjects, 0);
    assert.equal(qualifiesAsBandSupport({ confidence: 'strong', trend: 'stable' }), false);
  });

  it('groups by trend and orders bands by start time', () => {
    const t = cityTimeline(
      [
        zoneWith('a', 'rapidly_dispersing', 'quiet', 'strong'), // lead 20
        zoneWith('b', 'rapidly_dispersing', 'very_quiet', 'strong'),
        zoneWith('c', 'increasing_quickly', 'busy', 'strong'), // lead 30
        zoneWith('d', 'increasing_quickly', 'peak', 'strong'),
        zoneWith('e', 'getting_busier', 'busy', 'strong'), // lead 60
        zoneWith('f', 'getting_busier', 'busy', 'strong'),
      ],
      NOW_OFFSET,
      now,
      TZ,
    );
    assert.deepEqual(
      t.bands.map((b) => b.kind),
      ['cooling', 'peak', 'peak'],
    );
    const starts = t.bands.map((b) => Date.parse(b.startsAt));
    assert.deepEqual(starts, [...starts].sort((x, y) => x - y));
    assert.equal(t.qualifyingObjects, 6);
  });

  it('a band derived at a HISTORICAL offset is not a forecast', () => {
    const t = cityTimeline(
      [
        zoneWith('a', 'getting_busier', 'busy', 'strong'),
        zoneWith('b', 'getting_busier', 'peak', 'strong'),
      ],
      { kind: 'named', name: 'yesterday' },
      now,
      TZ,
    );
    assert.equal(t.mode, 'historical');
    assert.equal(t.bands.length, 1);
    assert.equal(t.bands[0].isForecast, false);
    assert.match(t.bands[0].label, /observed/);
    assert.equal(wall(new Date(t.horizonStartsAt), TZ), '2026-08-30 14:00');
  });

  it('always spans at least the default horizon, so an empty strip still lays out', () => {
    const t = cityTimeline([], NOW_OFFSET, now, TZ);
    assert.equal(t.bands.length, 0);
    assert.equal(Date.parse(t.horizonEndsAt) - Date.parse(t.horizonStartsAt), 180 * 60_000);
    assert.equal(t.offsetKey, 'now');
  });
});

// ── Presentation helpers ──────────────────────────────────────────────────────

describe('presentation helpers', () => {
  it('the forecast badge cannot be built without a confidence', () => {
    assert.equal(forecastBadgeLabel('likely_current'), 'Forecast · Reports indicate');
    assert.equal(forecastBadgeLabel('unverified'), 'Forecast · Unconfirmed');
  });

  it('formats a locale-independent 12-hour clock', () => {
    assert.equal(formatClock(at(TZ, 2026, 8, 31, 0, 5), TZ), '12:05 AM');
    assert.equal(formatClock(at(TZ, 2026, 8, 31, 12, 0), TZ), '12:00 PM');
    assert.equal(formatClock(at(TZ, 2026, 8, 31, 21, 30), TZ), '9:30 PM');
  });

  it('states the temporal mode in words, and names the confidence when forecasting', () => {
    const now = at(TZ, 2026, 8, 31, 14, 0);
    assert.match(temporalStatusLine(resolveOffset(NOW_OFFSET, now, TZ), undefined, TZ), /^Live/);
    assert.match(
      temporalStatusLine(resolveOffset({ kind: 'named', name: 'yesterday' }, now, TZ), undefined, TZ),
      /^Historical · observed 2:00 PM$/,
    );
    assert.match(
      temporalStatusLine(resolveOffset({ kind: 'relative', minutes: 60 }, now, TZ), 'strong', TZ),
      /^Forecast · Confirmed · 3:00 PM$/,
    );
  });
});
