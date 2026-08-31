/**
 * intentModel tests — spec §13.
 *
 * The tests are weighted toward the two properties whose failure is SILENT:
 *   1. an expired intent must be unable to reach ranking, and
 *   2. `intentToRankingContext` must return a detached, fresh object that
 *      cannot be folded into or mutated through stored preferences.
 *
 * Time is always injected, never ambient, so nothing here is clock-flaky.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_INTENT_KINDS,
  MAP_INTENT_LABELS,
  MAP_INTENT_HINTS,
  INTENT_TTL_MINUTES,
  DEFAULT_INTENT_TTL_MINUTES,
  MAX_INTENT_TTL_MINUTES,
  MIN_INTENT_TTL_MINUTES,
  EVENING_BOUND_INTENTS,
  EVENING_END_HOUR,
  INTENT_SCALE_MIN,
  INTENT_SCALE_MAX,
  INTENT_SCALE_DEFAULT,
  activeIntent,
  clampScale,
  clearIntent,
  createIntent,
  describeIntent,
  energyLabel,
  formatRemaining,
  intentToRankingContext,
  isExpired,
  isMapIntentKind,
  isValidScale,
  noveltyLabel,
  parseIntent,
  remainingMs,
  resolveExpiry,
  ttlMinutesFor,
  withScales,
  type MapIntentKind,
  type TemporaryIntent,
} from '../intentModel.ts';

const MINUTE = 60_000;

/** A fixed mid-afternoon instant, so evening-bound logic is not accidentally hit. */
const NOON = new Date('2026-08-31T12:00:00.000Z');

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

describe('intent catalogue', () => {
  test('declares exactly the nine §13 intents', () => {
    assert.deepEqual([...MAP_INTENT_KINDS], [
      'bored',
      'eat',
      'party',
      'explore',
      'meet_people',
      'date_night',
      'chill',
      'local',
      'surprise_me',
    ]);
  });

  test('every kind has a label, a hint and a TTL', () => {
    for (const kind of MAP_INTENT_KINDS) {
      assert.equal(typeof MAP_INTENT_LABELS[kind], 'string');
      assert.ok(MAP_INTENT_LABELS[kind].length > 0, `${kind} label`);
      assert.ok(MAP_INTENT_HINTS[kind].length > 0, `${kind} hint`);
      assert.ok(Number.isFinite(INTENT_TTL_MINUTES[kind]), `${kind} ttl`);
    }
  });

  test('isMapIntentKind rejects anything not in the catalogue', () => {
    assert.equal(isMapIntentKind('party'), true);
    assert.equal(isMapIntentKind('PARTY'), false);
    assert.equal(isMapIntentKind('brunch'), false);
    assert.equal(isMapIntentKind(null), false);
    assert.equal(isMapIntentKind(undefined), false);
    assert.equal(isMapIntentKind(3), false);
  });

  test('createIntent refuses an unknown kind rather than inventing one', () => {
    assert.throws(
      () => createIntent('brunch' as MapIntentKind, {}, NOON),
      /unknown intent kind/,
    );
  });
});

// ── Energy / novelty scales ───────────────────────────────────────────────────

describe('energy and novelty scale', () => {
  test('clamps below the floor and above the ceiling', () => {
    assert.equal(clampScale(-4), INTENT_SCALE_MIN);
    assert.equal(clampScale(-0.0001), INTENT_SCALE_MIN);
    assert.equal(clampScale(1.0001), INTENT_SCALE_MAX);
    assert.equal(clampScale(9999), INTENT_SCALE_MAX);
  });

  test('passes in-range values through untouched, endpoints included', () => {
    assert.equal(clampScale(0), 0);
    assert.equal(clampScale(1), 1);
    assert.equal(clampScale(0.5), 0.5);
    assert.equal(clampScale(0.137), 0.137);
  });

  test('rejects non-finite input instead of healing it to a default', () => {
    assert.throws(() => clampScale(Number.NaN), RangeError);
    assert.throws(() => clampScale(Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => clampScale(Number.NEGATIVE_INFINITY), RangeError);
    // A NaN silently becoming 0.5 is the exact bug this guards.
    assert.throws(() => clampScale(undefined as unknown as number), RangeError);
    assert.throws(() => clampScale('0.5' as unknown as number), RangeError);
  });

  test('createIntent clamps out-of-range slider values', () => {
    const i = createIntent('eat', { energy: 12, novelty: -3 }, NOON);
    assert.equal(i.energy, INTENT_SCALE_MAX);
    assert.equal(i.novelty, INTENT_SCALE_MIN);
  });

  test('createIntent propagates non-finite slider values as a throw', () => {
    assert.throws(() => createIntent('eat', { energy: Number.NaN }, NOON), RangeError);
    assert.throws(() => createIntent('eat', { novelty: Number.NaN }, NOON), RangeError);
  });

  test('untouched sliders default to the neutral midpoint, not to zero', () => {
    const i = createIntent('chill', {}, NOON);
    assert.equal(i.energy, INTENT_SCALE_DEFAULT);
    assert.equal(i.novelty, INTENT_SCALE_DEFAULT);
  });

  test('isValidScale is a non-throwing boundary check', () => {
    assert.equal(isValidScale(0), true);
    assert.equal(isValidScale(1), true);
    assert.equal(isValidScale(1.5), false);
    assert.equal(isValidScale(Number.NaN), false);
    assert.equal(isValidScale('0.5'), false);
  });

  test('withScales refines the sliders without restarting the TTL', () => {
    const i = createIntent('party', { energy: 0.3 }, NOON);
    const nudged = withScales(i, { energy: 0.9 });
    assert.equal(nudged.energy, 0.9);
    assert.equal(nudged.novelty, i.novelty);
    // The clock must NOT move — fidgeting with a slider cannot extend an intent.
    assert.equal(nudged.setAt, i.setAt);
    assert.equal(nudged.expiresAt, i.expiresAt);
    // and the original is untouched.
    assert.equal(i.energy, 0.3);
  });

  test('withScales clamps and rejects non-finite too', () => {
    const i = createIntent('local', {}, NOON);
    assert.equal(withScales(i, { novelty: 5 }).novelty, INTENT_SCALE_MAX);
    assert.throws(() => withScales(i, { energy: Number.NaN }), RangeError);
  });
});

// ── TTL policy ────────────────────────────────────────────────────────────────

describe('TTL policy', () => {
  test('the baseline TTL is applied to kinds without a reason to differ', () => {
    assert.equal(ttlMinutesFor('chill'), DEFAULT_INTENT_TTL_MINUTES);
    const i = createIntent('chill', {}, NOON);
    assert.equal(
      Date.parse(i.expiresAt) - Date.parse(i.setAt),
      DEFAULT_INTENT_TTL_MINUTES * MINUTE,
    );
  });

  test('per-intent overrides are actually honoured by createIntent', () => {
    const cases: Array<[MapIntentKind, number]> = [
      ['bored', 60],
      ['eat', 90],
      ['explore', 180],
      ['meet_people', 180],
      ['local', 240],
      ['surprise_me', 30],
    ];
    for (const [kind, minutes] of cases) {
      const i = createIntent(kind, {}, NOON);
      assert.equal(
        Date.parse(i.expiresAt) - Date.parse(i.setAt),
        minutes * MINUTE,
        `${kind} should expire after ${minutes}m`,
      );
    }
  });

  test('surprise_me is the shortest-lived intent of the nine', () => {
    const others = MAP_INTENT_KINDS.filter((k) => k !== 'surprise_me').map(ttlMinutesFor);
    assert.ok(
      others.every((m) => m > ttlMinutesFor('surprise_me')),
      'a persistent "surprise me" would read as a permanent novelty preference',
    );
  });

  test('no TTL in the policy table exceeds the absolute ceiling', () => {
    for (const kind of MAP_INTENT_KINDS) {
      assert.ok(
        INTENT_TTL_MINUTES[kind] <= MAX_INTENT_TTL_MINUTES,
        `${kind} exceeds MAX_INTENT_TTL_MINUTES`,
      );
      assert.ok(INTENT_TTL_MINUTES[kind] >= MIN_INTENT_TTL_MINUTES, `${kind} below floor`);
    }
  });

  test('an explicit ttlMinutes override is clamped to the ceiling', () => {
    // A week-long "temporary" intent is a preference rewrite wearing a TTL.
    const i = createIntent('explore', { ttlMinutes: 60 * 24 * 7 }, NOON);
    assert.equal(
      Date.parse(i.expiresAt) - Date.parse(i.setAt),
      MAX_INTENT_TTL_MINUTES * MINUTE,
    );
  });

  test('an explicit ttlMinutes override is clamped to the floor', () => {
    const i = createIntent('explore', { ttlMinutes: 0 }, NOON);
    assert.equal(
      Date.parse(i.expiresAt) - Date.parse(i.setAt),
      MIN_INTENT_TTL_MINUTES * MINUTE,
    );
    const neg = createIntent('explore', { ttlMinutes: -500 }, NOON);
    assert.equal(
      Date.parse(neg.expiresAt) - Date.parse(neg.setAt),
      MIN_INTENT_TTL_MINUTES * MINUTE,
    );
  });

  test('a non-finite ttlMinutes override throws rather than producing an eternal intent', () => {
    assert.throws(() => createIntent('explore', { ttlMinutes: Number.NaN }, NOON), RangeError);
    assert.throws(
      () => createIntent('explore', { ttlMinutes: Number.POSITIVE_INFINITY }, NOON),
      RangeError,
    );
  });

  test('every created intent carries a finite expiry strictly after setAt', () => {
    for (const kind of MAP_INTENT_KINDS) {
      const i = createIntent(kind, {}, NOON);
      const set = Date.parse(i.setAt);
      const exp = Date.parse(i.expiresAt);
      assert.ok(Number.isFinite(exp), `${kind} expiresAt must parse`);
      assert.ok(exp > set, `${kind} must expire after it is set`);
    }
  });
});

// ── Evening bound ─────────────────────────────────────────────────────────────

describe('evening-bounded intents', () => {
  // Local-time constructor on both sides, so these assertions hold in any TZ.
  const tenPmLocal = new Date(2026, 7, 31, 22, 0, 0, 0);

  const halfElevenLocal = new Date(2026, 7, 31, 23, 30, 0, 0);

  test('party set at 23:30 local is capped at the next local 04:00, not +5h', () => {
    assert.ok(EVENING_BOUND_INTENTS.includes('party'));
    const i = createIntent('party', {}, halfElevenLocal);
    const exp = new Date(Date.parse(i.expiresAt));
    // The raw TTL would run to 04:30; the evening bound cuts it at 04:00.
    assert.equal(exp.getHours(), EVENING_END_HOUR);
    assert.equal(exp.getMinutes(), 0);
    assert.equal(exp.getDate(), 1); // rolled into September 1st
    const elapsedMinutes = (exp.getTime() - halfElevenLocal.getTime()) / MINUTE;
    assert.equal(elapsedMinutes, 4.5 * 60);
    assert.ok(
      elapsedMinutes < INTENT_TTL_MINUTES.party,
      'the bound must actually shorten the intent in this case',
    );
  });

  test('date_night set at 01:00 local is capped at the same-night 04:00', () => {
    assert.ok(EVENING_BOUND_INTENTS.includes('date_night'));
    const oneAmLocal = new Date(2026, 8, 1, 1, 0, 0, 0);
    const i = createIntent('date_night', {}, oneAmLocal);
    const exp = new Date(Date.parse(i.expiresAt));
    // 01:00 + 240m would be 05:00 — past daybreak, so 04:00 wins.
    assert.equal(exp.getHours(), EVENING_END_HOUR);
    assert.equal(exp.getDate(), 1); // still the same calendar day
    assert.equal((exp.getTime() - oneAmLocal.getTime()) / MINUTE, 3 * 60);
  });

  test('an evening intent takes the EARLIER of its TTL and the bound', () => {
    // 22:00 + 240m = 02:00, which is before 04:00 — here the TTL is the binding
    // constraint, and the bound must not extend the intent to 04:00.
    const i = createIntent('date_night', {}, tenPmLocal);
    const elapsedMinutes = (Date.parse(i.expiresAt) - tenPmLocal.getTime()) / MINUTE;
    assert.equal(elapsedMinutes, INTENT_TTL_MINUTES.date_night);
    assert.equal(new Date(Date.parse(i.expiresAt)).getHours(), 2);
  });

  test('an evening intent set just before the bound still gets the minimum lifetime', () => {
    // 03:58 local — the naive bound would leave a 2-minute intent.
    const justBefore = new Date(2026, 7, 31, 3, 58, 0, 0);
    const i = createIntent('party', {}, justBefore);
    const elapsedMinutes = (Date.parse(i.expiresAt) - justBefore.getTime()) / MINUTE;
    assert.equal(elapsedMinutes, MIN_INTENT_TTL_MINUTES);
  });

  test('non-evening intents are unaffected by the evening bound', () => {
    const i = createIntent('local', {}, tenPmLocal);
    const elapsedMinutes = (Date.parse(i.expiresAt) - tenPmLocal.getTime()) / MINUTE;
    assert.equal(elapsedMinutes, INTENT_TTL_MINUTES.local);
  });

  test('resolveExpiry is exposed and agrees with createIntent', () => {
    const exp = resolveExpiry('party', tenPmLocal);
    const i = createIntent('party', {}, tenPmLocal);
    assert.equal(exp.toISOString(), i.expiresAt);
  });
});

// ── Expiry semantics ──────────────────────────────────────────────────────────

describe('expiry', () => {
  const intent = createIntent('eat', {}, NOON); // 90 minutes
  const expiry = Date.parse(intent.expiresAt);

  test('is not expired one millisecond before expiresAt', () => {
    assert.equal(isExpired(intent, new Date(expiry - 1)), false);
  });

  test('IS expired exactly at expiresAt — the boundary fails closed', () => {
    assert.equal(isExpired(intent, new Date(expiry)), true);
  });

  test('is expired one millisecond after expiresAt', () => {
    assert.equal(isExpired(intent, new Date(expiry + 1)), true);
  });

  test('a null/undefined intent reads as expired', () => {
    assert.equal(isExpired(null, NOON), true);
    assert.equal(isExpired(undefined, NOON), true);
  });

  test('an unparseable expiresAt reads as expired rather than as eternal', () => {
    const corrupt = { ...intent, expiresAt: 'not-a-date' };
    assert.equal(isExpired(corrupt, NOON), true);
    assert.equal(activeIntent(corrupt, NOON), null);
    assert.equal(remainingMs(corrupt, NOON), 0);
  });

  test('activeIntent returns the intent while live', () => {
    assert.equal(activeIntent(intent, at(NOON, 10 * MINUTE)), intent);
    assert.equal(activeIntent(intent, new Date(expiry - 1)), intent);
  });

  test('activeIntent returns null at and past expiry — the stale-leak guard', () => {
    assert.equal(activeIntent(intent, new Date(expiry)), null);
    assert.equal(activeIntent(intent, new Date(expiry + 1)), null);
    assert.equal(activeIntent(intent, at(NOON, 24 * 60 * MINUTE)), null);
  });

  test('activeIntent passes null/undefined straight through', () => {
    assert.equal(activeIntent(null, NOON), null);
    assert.equal(activeIntent(undefined, NOON), null);
  });

  test('clearIntent is the explicit-clear path and yields no intent', () => {
    assert.equal(clearIntent(), null);
    assert.equal(activeIntent(clearIntent(), NOON), null);
  });

  test('remainingMs counts down and floors at zero', () => {
    assert.equal(remainingMs(intent, NOON), 90 * MINUTE);
    assert.equal(remainingMs(intent, at(NOON, 30 * MINUTE)), 60 * MINUTE);
    assert.equal(remainingMs(intent, new Date(expiry)), 0);
    assert.equal(remainingMs(intent, new Date(expiry + 10 * MINUTE)), 0);
    assert.equal(remainingMs(null, NOON), 0);
  });
});

describe('formatRemaining', () => {
  test('renders hours and minutes for the sheet affordance', () => {
    assert.equal(formatRemaining(2 * 60 * MINUTE), '2h');
    assert.equal(formatRemaining(118 * MINUTE), '1h 58m');
    assert.equal(formatRemaining(45 * MINUTE), '45m');
    assert.equal(formatRemaining(30_000), 'under a minute');
  });

  test('renders a spent TTL as expired, never as a negative countdown', () => {
    assert.equal(formatRemaining(0), 'expired');
    assert.equal(formatRemaining(-5000), 'expired');
    assert.equal(formatRemaining(Number.NaN), 'expired');
  });
});

// ── §14 "why this option" line ────────────────────────────────────────────────

describe('describeIntent', () => {
  test('produces the §14 line for a live intent', () => {
    const i = createIntent('party', { energy: 0.95, novelty: 0.9 }, NOON);
    const line = describeIntent(i, at(NOON, 5 * MINUTE));
    assert.equal(line, 'Matches current Party intent · Very high energy · Very adventurous');
  });

  test('returns null for an expired intent — a "why" must not cite a dead reason', () => {
    const i = createIntent('eat', {}, NOON);
    assert.equal(describeIntent(i, at(NOON, 91 * MINUTE)), null);
  });

  test('returns null when there is no intent at all', () => {
    assert.equal(describeIntent(null, NOON), null);
    assert.equal(describeIntent(undefined, NOON), null);
  });

  test('scale band labels cover the whole range', () => {
    assert.equal(energyLabel(0), 'Very low energy');
    assert.equal(energyLabel(0.3), 'Low energy');
    assert.equal(energyLabel(0.5), 'Balanced energy');
    assert.equal(energyLabel(0.75), 'High energy');
    assert.equal(energyLabel(1), 'Very high energy');
    assert.equal(noveltyLabel(0), 'Very familiar');
    assert.equal(noveltyLabel(0.3), 'Familiar');
    assert.equal(noveltyLabel(0.5), 'Balanced novelty');
    assert.equal(noveltyLabel(0.75), 'Adventurous');
    assert.equal(noveltyLabel(1), 'Very adventurous');
  });
});

// ── The ranking context — §13's central constraint ────────────────────────────

describe('intentToRankingContext', () => {
  test('projects a live intent field-for-field', () => {
    const i = createIntent('party', { energy: 0.8, novelty: 0.2 }, NOON);
    const ctx = intentToRankingContext(i, at(NOON, 30 * MINUTE));
    assert.equal(ctx.source, 'temporary_intent');
    assert.equal(ctx.kind, 'party');
    assert.equal(ctx.energy, 0.8);
    assert.equal(ctx.novelty, 0.2);
    assert.equal(ctx.setAt, i.setAt);
    assert.equal(ctx.expiresAt, i.expiresAt);
    assert.equal(ctx.ephemeral, true);
    assert.equal(ctx.ttlRemainingMs, remainingMs(i, at(NOON, 30 * MINUTE)));
  });

  test('an EXPIRED intent projects to the empty context — no stale kind reaches ranking', () => {
    const i = createIntent('surprise_me', {}, NOON); // 30 minutes
    const afterExpiry = at(NOON, 31 * MINUTE);
    const ctx = intentToRankingContext(i, afterExpiry);
    assert.equal(ctx.kind, null);
    assert.equal(ctx.energy, null);
    assert.equal(ctx.novelty, null);
    assert.equal(ctx.setAt, null);
    assert.equal(ctx.expiresAt, null);
    assert.equal(ctx.ttlRemainingMs, 0);
    // Still shaped like a context, so the ranker takes one code path either way.
    assert.equal(ctx.source, 'temporary_intent');
    assert.equal(ctx.ephemeral, true);
  });

  test('the expiry boundary is honoured on this path too', () => {
    const i = createIntent('eat', {}, NOON);
    const expiry = new Date(Date.parse(i.expiresAt));
    assert.equal(intentToRankingContext(i, new Date(expiry.getTime() - 1)).kind, 'eat');
    assert.equal(intentToRankingContext(i, expiry).kind, null);
  });

  test('no intent projects to the empty context', () => {
    const ctx = intentToRankingContext(null, NOON);
    assert.equal(ctx.kind, null);
    assert.equal(ctx.ttlRemainingMs, 0);
    assert.equal(ctx.ephemeral, true);
  });

  test('returns a FRESH object that shares no reference with its input', () => {
    const i = createIntent('local', { energy: 0.4, novelty: 0.7 }, NOON);
    const ctx = intentToRankingContext(i, NOON);

    // Not the input, and not aliasing any object the input holds.
    assert.notEqual(ctx as unknown, i as unknown);
    const inputValues = new Set<unknown>(Object.values(i as Record<string, unknown>));
    for (const [key, value] of Object.entries(ctx as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object') {
        assert.fail(`ranking context field "${key}" is an object — it must be serializable`);
      }
      if (value !== null && typeof value === 'object' && inputValues.has(value)) {
        assert.fail(`ranking context field "${key}" aliases the stored intent`);
      }
    }

    // Two calls hand back two distinct objects, so no caller can share state.
    const ctx2 = intentToRankingContext(i, NOON);
    assert.notEqual(ctx as unknown, ctx2 as unknown);
    assert.deepEqual(ctx, ctx2);
  });

  test('mutating the returned context cannot reach back into the stored intent', () => {
    const i = createIntent('date_night', { energy: 0.6, novelty: 0.6 }, NOON);
    const snapshot = { ...i };
    const ctx = intentToRankingContext(i, NOON);

    (ctx as { kind: MapIntentKind | null }).kind = 'party';
    (ctx as { energy: number | null }).energy = 0;
    (ctx as { expiresAt: string | null }).expiresAt = '2099-01-01T00:00:00.000Z';

    assert.deepEqual(i, snapshot, 'the stored intent must be untouched');
  });

  test('the context is JSON round-trippable — it crosses a process boundary', () => {
    const i = createIntent('meet_people', { energy: 0.25, novelty: 0.85 }, NOON);
    const ctx = intentToRankingContext(i, NOON);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx);
  });

  test('the context carries no preference-shaped fields to merge into', () => {
    const ctx = intentToRankingContext(createIntent('chill', {}, NOON), NOON);
    const keys = Object.keys(ctx).sort();
    assert.deepEqual(keys, [
      'energy',
      'ephemeral',
      'expiresAt',
      'kind',
      'novelty',
      'setAt',
      'source',
      'ttlRemainingMs',
    ]);
  });
});

// ── Boundary parsing ──────────────────────────────────────────────────────────

describe('parseIntent', () => {
  test('round-trips a well-formed record', () => {
    const i = createIntent('explore', { energy: 0.3, novelty: 0.7 }, NOON);
    const parsed = parseIntent(JSON.parse(JSON.stringify(i)));
    assert.deepEqual(parsed, i);
  });

  test('rejects malformed records rather than throwing at a cache boundary', () => {
    const good: TemporaryIntent = createIntent('explore', {}, NOON);
    assert.equal(parseIntent(null), null);
    assert.equal(parseIntent('party'), null);
    assert.equal(parseIntent({}), null);
    assert.equal(parseIntent({ ...good, kind: 'brunch' }), null);
    assert.equal(parseIntent({ ...good, energy: 4 }), null);
    assert.equal(parseIntent({ ...good, energy: Number.NaN }), null);
    assert.equal(parseIntent({ ...good, novelty: '0.5' }), null);
    assert.equal(parseIntent({ ...good, setAt: 'nope' }), null);
    assert.equal(parseIntent({ ...good, expiresAt: undefined }), null);
  });

  test('does not silently resurrect an expired record — expiry is still checked downstream', () => {
    const i = createIntent('surprise_me', {}, NOON);
    const parsed = parseIntent(JSON.parse(JSON.stringify(i)));
    assert.notEqual(parsed, null);
    // parseIntent is about SHAPE; activeIntent is about LIFE.
    assert.equal(activeIntent(parsed, at(NOON, 31 * MINUTE)), null);
  });

  test('drops unknown extra fields instead of carrying them into the store', () => {
    const i = createIntent('bored', {}, NOON);
    const parsed = parseIntent({ ...i, sticky: true, userPreferences: { nightlife: 1 } });
    assert.deepEqual(parsed, i);
    assert.equal((parsed as unknown as Record<string, unknown>).sticky, undefined);
    assert.equal(
      (parsed as unknown as Record<string, unknown>).userPreferences,
      undefined,
      'a preference blob must never ride along inside a temporary intent',
    );
  });
});
