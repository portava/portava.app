/**
 * Unit tests for passportTelemetry — the §32 Passport telemetry seam.
 *
 * Covers the two invariants the module exists to guarantee:
 *   1. The pluggable sink receives exactly the events the `track*` helpers emit,
 *      with ids / enums / counts only.
 *   2. PII / raw text NEVER reaches the sink: `scrubPayload` strips any
 *      disallowed key (name, handle, email, label text, coordinate, …) at any
 *      depth, so even a mis-constructed payload cannot leak a name or a place.
 *
 * These are pure-logic tests (no React render needed) but live in a
 * *.component.test.tsx so the jest component runner — the one `check:all`
 * gates on — executes them.
 */
import {
  emit,
  scrubPayload,
  isDisallowedKey,
  containsDisallowedKey,
  setPassportTelemetrySink,
  resetPassportTelemetrySink,
  trackStampViewed,
  trackSharedContextViewed,
  trackMyWorldOpened,
  trackPassportShared,
  trackMakePlanStarted,
  trackPassportViewed,
  type PassportTelemetryEvent,
} from '../passportTelemetry.ts';

function spy() {
  const events: PassportTelemetryEvent[] = [];
  setPassportTelemetrySink((e) => events.push(e));
  return events;
}

afterEach(() => {
  resetPassportTelemetrySink();
});

describe('passportTelemetry — sink + helpers', () => {
  it('routes each track helper to the sink with the right type + payload', () => {
    const events = spy();

    trackStampViewed({ stampId: 's1', kind: 'city', verification: 'verified' });
    trackSharedContextViewed({ subjectId: 'them', factCount: 3, summary: 'Strong travel overlap' });
    trackMyWorldOpened({ countryCount: 2, cityCount: 5, stampCount: 9 });
    trackPassportShared('copy');
    trackMakePlanStarted('them', 'shared_context');

    expect(events.map((e) => e.type)).toEqual([
      'stamp_viewed',
      'shared_context_viewed',
      'my_world_opened',
      'passport_shared',
      'make_plan_started',
    ]);
    expect(events[0].payload).toEqual({ stampId: 's1', kind: 'city', verification: 'verified' });
    expect(events[3].payload).toEqual({ method: 'copy' });
    expect(events[4].payload).toEqual({ subjectId: 'them', from: 'shared_context' });
  });

  it('never lets analytics break the caller — a throwing sink is swallowed', () => {
    setPassportTelemetrySink(() => {
      throw new Error('sink boom');
    });
    expect(() => trackMyWorldOpened({ countryCount: 1, cityCount: 1, stampCount: 1 })).not.toThrow();
  });
});

describe('passportTelemetry — privacy scrubber (§23/§24)', () => {
  it('flags PII/free-text keys and allows ids/enums/counts', () => {
    for (const k of ['name', 'displayName', 'handle', 'username', 'email', 'phone', 'avatarUrl', 'bio', 'title', 'label', 'text', 'message', 'description', 'lat', 'lng', 'coordinate']) {
      expect(isDisallowedKey(k)).toBe(true);
    }
    for (const k of ['subjectId', 'stampId', 'kind', 'verification', 'method', 'factCount', 'countryCount', 'from', 'summary', 'viewerContext']) {
      expect(isDisallowedKey(k)).toBe(false);
    }
  });

  it('regression: the closed-enum viewerContext survives the "text" fragment, free text does not', () => {
    const events = spy();
    trackPassportViewed('them', 'follower');
    expect(events[0].payload).toEqual({ subjectId: 'them', viewerContext: 'follower' });
    // The exception is by exact key only — any other "…text…" key is still stripped.
    expect(scrubPayload({ subjectId: 'them', contextText: 'hello', text: 'hi' })).toEqual({ subjectId: 'them' });
  });

  it('strips disallowed keys at any depth', () => {
    const dirty = {
      subjectId: 'them',
      name: 'Mai Nguyen',
      nested: { handle: '@mai', factCount: 2, geo: { lat: 16.06, lng: 108.2 } },
      facts: [{ label: 'Both in Da Nang', magnitude: 1 }],
    };
    const clean = scrubPayload(dirty);
    expect(clean).toEqual({
      subjectId: 'them',
      nested: { factCount: 2, geo: {} },
      facts: [{ magnitude: 1 }],
    });
    expect(containsDisallowedKey(clean)).toBe(false);
  });

  it('emit scrubs before the sink sees the payload — no name reaches it', () => {
    const events = spy();
    // A deliberately mis-constructed payload with a name field slipped in.
    emit('shared_context_viewed', {
      subjectId: 'them',
      factCount: 3,
      summary: 'Strong travel overlap',
      // @ts-expect-error — proving the scrubber removes an off-contract PII key.
      name: 'Mai Nguyen',
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ subjectId: 'them', factCount: 3, summary: 'Strong travel overlap' });
    expect(JSON.stringify(events[0])).not.toContain('Mai');
  });
});
