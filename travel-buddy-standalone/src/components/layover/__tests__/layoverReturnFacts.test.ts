/**
 * layoverReturnFacts — §16 staleness, §2.1 certification, §15 posture.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * The failure mode this file is built against is a stale badge that never
 * fires. So the assertions are two-sided: every "stale" case is paired with a
 * "not stale" case a few minutes earlier, and the boundary instant itself is
 * pinned. A `stale` that were hard-wired to false would fail the first group;
 * one hard-wired to true would fail the second.
 *
 * The bundle fixture is transcribed from the server's own buildOfflineBundle
 * (artifacts/api-server/src/services/airport/LayoverDegradedService.ts) — every
 * field it emits, none it does not — so a client type that drifted from the
 * wire fails to compile against it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LayoverCertification, LayoverOfflineBundle } from '../../../services/layover.ts';
import {
  bundleFreshness,
  describeAbortEffects,
  describeCrewMeetingPoint,
  describeCrewNotification,
  describeDeadline,
  postureHeadline,
  statusCapabilityNote,
  summarizeCertification,
} from '../layoverReturnFacts.ts';

const CERTIFIED_AT = '2026-09-08T10:00:00.000Z';
const CERTIFIED_MS = Date.parse(CERTIFIED_AT);
/** OFFLINE_BUNDLE_TTL_MIN = 15 on the server. */
const STALE_AFTER = '2026-09-08T10:15:00.000Z';
const STALE_AFTER_MS = Date.parse(STALE_AFTER);

const CERT: LayoverCertification = {
  engineVersion: '2026.09.02-3',
  feasibilityVersion: '2026.09.05-1',
  inputHash: 'a1b2c3d4e5f60718',
  computedAt: CERTIFIED_AT,
  verdict: 'tight',
  confidence: 'LOW',
  bufferPercentile: 'p90',
};

const BUNDLE: LayoverOfflineBundle = {
  bundleVersion: '2026.09.08-1',
  sessionId: 'sess-1',
  certifiedAt: CERTIFIED_AT,
  staleAfter: STALE_AFTER,
  certification: CERT,
  returnDeadline: {
    hardReturnTime: '2026-09-08T13:40:00.000Z',
    hardReturnLocal: '21:40',
    returnState: 'NORMAL',
    bufferMinutes: 95,
    returnReminderAt: null,
  },
  airport: {
    iataCode: 'BKK',
    name: 'Suvarnabhumi',
    city: 'Bangkok',
    country: 'Thailand',
    timezone: 'Asia/Bangkok',
    lat: 13.68,
    lng: 100.74,
    terminalInfo: null,
  },
  mapGeometry: { available: false, value: null, reason: 'no_envelope_geometry' },
  route: { available: false, value: null, reason: 'no_routing_provider' },
  flightStatus: { available: false, value: null, reason: 'no_flight_feed' },
  crewMeetingPoint: { available: false, value: null, reason: 'no_crew_storage' },
  translationPhrases: { available: false, value: null, reason: 'no_phrase_catalogue' },
  stops: [],
};

// ── §16 freshness ─────────────────────────────────────────────────────────────

test('inside the TTL the bundle is fresh and reports its real age', () => {
  const f = bundleFreshness(BUNDLE, CERTIFIED_MS + 5 * 60_000);
  assert.equal(f.stale, false);
  assert.equal(f.known, true);
  assert.equal(f.ageMinutes, 5);
  assert.equal(f.freshForMinutes, 10);
});

test('past staleAfter the bundle IS stale — the badge fires', () => {
  const f = bundleFreshness(BUNDLE, CERTIFIED_MS + 23 * 60_000);
  assert.equal(f.stale, true);
  assert.equal(f.ageMinutes, 23);
  assert.equal(f.freshForMinutes, 0);
});

test('the boundary is inclusive: at exactly staleAfter it is stale', () => {
  assert.equal(bundleFreshness(BUNDLE, STALE_AFTER_MS).stale, true);
  assert.equal(bundleFreshness(BUNDLE, STALE_AFTER_MS - 1).stale, false);
});

test('a device clock behind the server clamps age at zero rather than going negative', () => {
  const f = bundleFreshness(BUNDLE, CERTIFIED_MS - 90 * 60_000);
  assert.equal(f.ageMinutes, 0);
  assert.equal(f.stale, false);
});

test('an unparseable bundle is never claimed fresh', () => {
  const broken = { ...BUNDLE, certifiedAt: 'not-a-date', staleAfter: 'nope' };
  const f = bundleFreshness(broken, CERTIFIED_MS);
  assert.equal(f.known, false);
  assert.equal(f.stale, true);
});

test('a missing bundle is unknown, not fresh', () => {
  assert.equal(bundleFreshness(null, CERTIFIED_MS).known, false);
  assert.equal(bundleFreshness(undefined, CERTIFIED_MS).stale, true);
});

// ── §16 what the screen is allowed to claim ──────────────────────────────────

test('a fresh bundle carries no staleness caption', () => {
  const d = describeDeadline(BUNDLE, '2026-09-08T13:40:00.000Z', CERTIFIED_MS + 60_000);
  assert.equal(d.standing, 'live');
  assert.equal(d.stalenessNotice, null);
  assert.equal(d.hardReturnLocal, '21:40');
});

test('a stale bundle keeps the deadline AND names its age', () => {
  const d = describeDeadline(BUNDLE, '2026-09-08T13:40:00.000Z', CERTIFIED_MS + 42 * 60_000);
  assert.equal(d.standing, 'stale');
  // The deadline itself is never dropped — §16 L150.
  assert.equal(d.hardReturnTime, '2026-09-08T13:40:00.000Z');
  assert.match(d.stalenessNotice ?? '', /42 min ago/);
});

test('with no bundle the deadline falls back to the live window and says age is unknown', () => {
  const d = describeDeadline(null, '2026-09-08T13:40:00.000Z', CERTIFIED_MS);
  assert.equal(d.standing, 'unknown');
  assert.equal(d.hardReturnTime, '2026-09-08T13:40:00.000Z');
  assert.notEqual(d.stalenessNotice, null);
});

// ── §2.1 certification ───────────────────────────────────────────────────────

test('the certification line states computedAt and versions, and claims nothing more', () => {
  const c = summarizeCertification(CERT);
  assert.ok(c);
  assert.equal(c.computedAt, CERTIFIED_AT);
  assert.equal(c.versionLine, 'engine 2026.09.02-3 · feasibility 2026.09.05-1');
  assert.equal(c.qualityLine, 'confidence low · buffer p90');
  assert.equal(c.inputHashShort, 'a1b2c3d4');
  // No freshness word may appear — the server published an instant, not a claim.
  const all = `${c.versionLine} ${c.qualityLine}`;
  for (const forbidden of ['live', 'current', 'up to date', 'just now', 'fresh']) {
    assert.equal(all.includes(forbidden), false, `certification line must not claim "${forbidden}"`);
  }
});

test('no certification yields no line rather than an invented one', () => {
  assert.equal(summarizeCertification(null), null);
  assert.equal(summarizeCertification(undefined), null);
});

// ── §15 posture ──────────────────────────────────────────────────────────────

const POSTURE_BASE = {
  safeReturnVersion: '2026.09.08-1',
  explorationCollapsed: false,
  returnRoutePrimary: false,
  pinTerminalContext: false,
  notifyCrew: false,
  offerRecoveryHelp: false,
  abortAvailable: true,
  minutesToHardReturn: 120,
} as const;

test('each certified return state gets its own headline and tone', () => {
  const seen = new Set<string>();
  for (const [state, tone] of [
    ['NORMAL', 'calm'],
    ['RETURN_SOON', 'warn'],
    ['RETURN_NOW', 'urgent'],
    ['CONNECTION_AT_RISK', 'critical'],
  ] as const) {
    const h = postureHeadline({ ...POSTURE_BASE, returnState: state, primaryAction: 'explore' });
    assert.equal(h.tone, tone, `${state} tone`);
    assert.equal(seen.has(h.title), false, `${state} must not reuse another state's headline`);
    seen.add(h.title);
  }
});

test('a missing posture falls back to NORMAL rather than throwing', () => {
  assert.equal(postureHeadline(null).tone, 'calm');
});

// ── §15.1 effects ────────────────────────────────────────────────────────────

test('failed effects are reported, and the always-present crew effect is not noise', () => {
  const lines = describeAbortEffects([
    'itinerary_cancel_failed',
    'status_unchanged_flag_off',
    'ledger_write_failed',
    'crew_notify_unavailable',
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /could NOT be cleared/);
  assert.match(lines[1], /not recorded/);
});

test('a clean abort produces no failure lines', () => {
  assert.deepEqual(
    describeAbortEffects(['itinerary_cancelled', 'status_marked_returning', 'ledger_recorded', 'crew_notify_unavailable']),
    [],
  );
});

test('the status-capability note only speaks when the status was not applied', () => {
  assert.equal(statusCapabilityNote('enabled', true), null);
  assert.equal(statusCapabilityNote('flag_off', true), null);
  assert.match(statusCapabilityNote('flag_off', false) ?? '', /stays open/);
  assert.match(statusCapabilityNote('flag_on_readers_not_widened', false) ?? '', /stays open/);
});

// ── §16 L154 — the CACHED crew meeting point ─────────────────────────────────
//
// WHAT WOULD TURN THIS RED. `crewMeetingPoint` was typed
// `OfflineCapability<never>` on this side of the wire, so `value` could only
// ever be `null` and no amount of server work could put a label on screen. The
// first case below does not compile against that type — which is the point:
// the type WAS the defect, not a missing branch.
//
// The second and third cases are the ones that stop the fix becoming a lie.
// A capability the server marked unavailable must not render as a blank line
// or as "no meeting point" stated as a fact about the crew; it says the label
// is not in the bundle and names the server's own reason word.

test('a cached meeting point is surfaced verbatim — the server’s label, not a derived one', () => {
  const withPoint: LayoverOfflineBundle = {
    ...BUNDLE,
    crewMeetingPoint: { available: true, value: 'Gate D4 Starbucks', reason: null },
  };
  const m = describeCrewMeetingPoint(withPoint);
  assert.equal(m.label, 'Gate D4 Starbucks');
  assert.equal(m.reason, null);
  assert.match(m.sentence, /Gate D4 Starbucks/);
});

test('an unavailable meeting point names the server’s reason and claims nothing about the crew', () => {
  const m = describeCrewMeetingPoint(BUNDLE);
  assert.equal(m.label, null);
  assert.equal(m.reason, 'no_crew_storage');
  assert.ok(m.sentence.length > 0, 'an unavailable capability still gets a sentence');
  // It must not assert that the crew HAS no meeting point — only that none is
  // cached here. The two are different facts and the bundle only knows one.
  assert.doesNotMatch(m.sentence, /crew has no meeting point/i);
});

test('an available capability carrying a blank label is no label, not an empty meeting point', () => {
  const blank: LayoverOfflineBundle = {
    ...BUNDLE,
    crewMeetingPoint: { available: true, value: '   ', reason: null },
  };
  const m = describeCrewMeetingPoint(blank);
  assert.equal(m.label, null);
  assert.ok(m.sentence.length > 0);
});

test('no bundle at all is not a meeting point of ""', () => {
  const m = describeCrewMeetingPoint(null);
  assert.equal(m.label, null);
  assert.equal(m.reason, null);
  assert.ok(m.sentence.length > 0);
});

// ── §15.1 L144 — whether the crew was told ───────────────────────────────────
//
// WHAT WOULD TURN THIS RED. `crewNotifyUnavailableReason` was typed
// `'no_crew_storage' | null`, so the only reason this client could hold was the
// one that has been FALSE since crew storage landed on 2026-09-16. Case 2 uses
// a reason outside that pair and does not compile against the old type.
//
// `describeAbortEffects` deliberately still drops `crew_notify_unavailable`
// (two tests above pin that) — the EFFECT is a marker, the FIELD is the value,
// and this reads the field.

test('a crew that WAS told is reported to the traveller, with the server’s count', () => {
  const line = describeCrewNotification({
    crewNotified: ['u-2', 'u-3'],
    crewNotifyUnavailableReason: null,
  });
  assert.ok(line);
  assert.match(line, /2/);
  assert.match(line, /crew/i);
});

test('a crew that was NOT told says so, for a reason the old type could not hold', () => {
  const line = describeCrewNotification({
    crewNotified: [],
    crewNotifyUnavailableReason: 'not_in_a_crew',
  });
  assert.ok(line);
  assert.match(line, /not/i);
});

test('an unrecognised reason is reported as "not told" and NEVER as a raw code', () => {
  const line = describeCrewNotification({
    crewNotified: [],
    crewNotifyUnavailableReason: 'some_reason_this_client_predates',
  });
  assert.ok(line);
  assert.doesNotMatch(line, /some_reason_this_client_predates/);
  assert.match(line, /not/i);
});

test('nothing to report is reported as nothing — no empty sentence', () => {
  assert.equal(
    describeCrewNotification({ crewNotified: [], crewNotifyUnavailableReason: null }),
    null,
  );
});

test('one crewmate is singular', () => {
  const line = describeCrewNotification({
    crewNotified: ['u-2'],
    crewNotifyUnavailableReason: null,
  });
  assert.ok(line);
  assert.doesNotMatch(line, /people/i);
});
