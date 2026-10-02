/**
 * TM-live (WP-11) — the place screen's live decision surfaces, through the
 * REAL service (placeLive.ts → liveApi.ts). Only `fetch` is faked, answering
 * in the api-server routes' own shapes:
 *
 *   COMP-F15  routes/compassDecision.ts
 *   SEN-F08   routes/intelReadModels.ts (live-state, typical-patterns, neighbourhood pulse)
 *   SEN-F07   routes/opportunities.ts + routes/experienceSessions.ts
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import { PlaceLivePanel } from '../PlaceLivePanel.tsx';
import { _setLiveTestToken } from '../liveApi.ts';

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';

const PLACE = '88888888-bbbb-4bbb-8bbb-888888888888';
const OTHER = '99999999-cccc-4ccc-8ccc-999999999999';
const SESSION = 'abababab-0000-4000-a000-000000000001';
const later = new Date(Date.now() + 40 * 60_000).toISOString();

type Ans = { status: number; body: unknown };
type Routes = Partial<Record<'decision' | 'live' | 'typical' | 'pulse' | 'opps' | 'open' | 'start' | 'close', Ans | ((url: URL, body: any) => Ans)>>;
type Call = { method: string; url: URL; body: any };
let calls: Call[] = [];

const TRUTH = { truthClass: 'corroborated', confidence: 'high', freshness: 'fresh', coverage: 'several' };
const DEFAULTS: Required<Routes> = {
  decision: { status: 200, body: { ok: true, subjectId: PLACE, decision: 'GO_NOW', reasons: ['interception_unknown', 'live_reachable_compatible'], grounding: TRUTH, summary: 'Go now. Crowd busy (corroborated by several, fresh).', interception: { reachable: null, etaMinutes: null, marginMinutes: null }, switchingCost: {}, confirmation: { required: false, reason: 'no_committed_plan_changes' }, liveIntelligenceReadable: true, generatedAt: new Date().toISOString() } },
  live: { status: 200, body: { schema_version: 1, source_label: 'consensus', subject_id: PLACE, state: 'live', valid_until: later, truth: TRUTH, claims: [{ claimType: 'crowd.level', value: { level: 'busy' }, truth: TRUTH }], live_read_failed: false } },
  typical: { status: 200, body: { schema_version: 1, patterns: [{ claim_family: 'crowd.level', pattern_kind: 'weekly', time_band: 'hour_18', dow: 2, value: { level: 'packed' }, band: 'medium' }] } },
  pulse: { status: 200, body: { schema_version: 1, pulse: { exposable: false, reason: 'no_data', subjectCount: 0, levels: {} } } },
  opps: { status: 200, body: { ok: true, surface: 'compass', liveIntelligenceReadable: true, opportunities: [{ subjectId: PLACE, kind: 'go_now', decision: 'GO_NOW', reachable: null, window: { expiresAt: later } }], refusals: [] } },
  open: { status: 200, body: { ok: true, session: null, state: null, refusal: null } },
  start: { status: 201, body: { ok: true, state: 'open', session: { session_id: SESSION, subject_id: PLACE, opportunity_kind: 'go_now', opened_at: new Date().toISOString(), expires_at: later, phase: 'opened', claim_refs: [] } } },
  close: { status: 200, body: { ok: true, state: 'closed', calibrated: false } },
};

function serve(over: Routes = {}) {
  const r = { ...DEFAULTS, ...over };
  (global as any).fetch = jest.fn(async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const p = url.pathname;
    const key: keyof Routes | null =
      p === '/api/compass/decision' ? 'decision'
      : p.endsWith('/live-state') ? 'live'
      : p.endsWith('/typical-patterns') ? 'typical'
      : p.includes('/neighborhoods/') ? 'pulse'
      : p === '/api/intel/opportunities' ? 'opps'
      : p === '/api/intel/experience-sessions/open' ? 'open'
      : p === '/api/intel/experience-sessions/from-opportunity' ? 'start'
      : p.endsWith('/close') ? 'close' : null;
    const a = key ? r[key] : { status: 404, body: { error: 'not_found' } };
    const ans = typeof a === 'function' ? a(url, body) : a;
    return { ok: ans.status >= 200 && ans.status < 300, status: ans.status, json: async () => ans.body };
  });
}
const OFF: Ans = { status: 404, body: { error: 'feature_disabled', message: 'off' } };
const DOWN: Ans = { status: 503, body: { error: 'degraded_unavailable', message: 'timeout' } };

beforeEach(() => { calls = []; _setLiveTestToken(async () => 'tok'); });
afterEach(() => _setLiveTestToken(null));

describe('COMP-F15 the decision card', () => {
  it('shows the server\'s decision, its own sentence, its reasons in words and its grounding', async () => {
    serve();
    const { findByTestId, getByText, getByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    expect((await findByTestId('place-decision-word')).props.children).toBe('Go now');
    expect(getByTestId('place-decision-summary').props.children).toBe('Go now. Crowd busy (corroborated by several, fresh).');
    expect(getByText("• Your arrival time isn't known")).toBeTruthy();
    expect(getByTestId('place-decision-grounding').props.children.join('')).toMatch(/corroborated · fresh · several coverage/);
    const d = calls.find((c) => c.url.pathname === '/api/compass/decision')!;
    expect(d.url.searchParams.get('subjectId')).toBe(PLACE);
    expect(d.url.searchParams.get('currentSubjectId')).toBeNull();
  });

  it('a WAIT that could not read live intelligence says so — never a bare WAIT', async () => {
    serve({ decision: { status: 200, body: { ...(DEFAULTS.decision as Ans).body as object, decision: 'WAIT', reasons: ['live_intelligence_unavailable'], summary: 'Wait. No current crowd reading (no current evidence).', liveIntelligenceReadable: false } } });
    const { findByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    expect((await findByTestId('place-decision-word')).props.children).toBe('Wait');
    expect((await findByTestId('place-decision-caveat')).props.children).toMatch(/couldn't read live intelligence/);
  });

  it('a failed decision read is a failure with Try again', async () => {
    let down = true;
    serve({ decision: () => (down ? DOWN : (DEFAULTS.decision as Ans)) });
    const { findByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    expect(await findByTestId('place-decision-failed')).toBeTruthy();
    down = false;
    fireEvent.press(await findByTestId('place-decision-failed-retry'));
    expect((await findByTestId('place-decision-word')).props.children).toBe('Go now');
  });

  it('an open session at another place goes with the request as the CURRENT experience', async () => {
    serve({ open: { status: 200, body: { ok: true, session: { session_id: SESSION, subject_id: OTHER, opportunity_kind: 'go_now', opened_at: '', expires_at: later }, state: 'open', refusal: null } } });
    const { findByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    await findByTestId('place-decision-word');
    expect(calls.find((c) => c.url.pathname === '/api/compass/decision')!.url.searchParams.get('currentSubjectId')).toBe(OTHER);
  });
});

describe('SEN-F08 the read models', () => {
  it('live state, typical pattern and a withheld pulse, each labelled for what it is', async () => {
    serve();
    const { findByTestId, getByText, findByText } = await render(<PlaceLivePanel placeId={PLACE} neighborhood="An Hoi" />);
    expect((await findByTestId('place-live-word')).props.children).toBe('Live now');
    expect(getByText('crowd level: busy (corroborated, fresh)')).toBeTruthy();
    expect(await findByText('Tue 18:00 — crowd level usually packed (medium confidence)')).toBeTruthy();
    expect((await findByTestId('place-pulse-withheld')).props.children).toMatch(/not a reading of quiet/);
    expect(calls.some((c) => c.url.pathname === '/api/v1/neighborhoods/An%20Hoi/pulse')).toBe(true);
  });

  it('a FAILED live read is said to have failed — not "no current reports"', async () => {
    serve({ live: { status: 200, body: { state: 'unknown', claims: [], truth: null, valid_until: null, live_read_failed: true } } });
    const { findByTestId, queryByText } = await render(<PlaceLivePanel placeId={PLACE} />);
    expect(await findByTestId('place-live-read-failed')).toBeTruthy();
    expect(queryByText(/No current reports here/)).toBeNull();
  });

  it('a healthy unknown is "no current reports", which is not quiet', async () => {
    serve({ live: { status: 200, body: { state: 'unknown', claims: [], truth: null, valid_until: null, live_read_failed: false } } });
    const { findByText, queryByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    expect(await findByText("No current reports here — that isn't the same as quiet.")).toBeTruthy();
    expect(queryByTestId('place-live-read-failed')).toBeNull();
  });

  it('a failed pattern read is a failure, not "no pattern learned"; no neighbourhood means no pulse request', async () => {
    serve({ typical: { status: 500, body: { error: 'db_error', message: 'pattern read failed' } } });
    const { findByTestId, queryByTestId } = await render(<PlaceLivePanel placeId={PLACE} neighborhood={null} />);
    expect(await findByTestId('place-typical-failed')).toBeTruthy();
    expect(queryByTestId('place-typical-none')).toBeNull();
    expect(calls.some((c) => c.url.pathname.includes('/neighborhoods/'))).toBe(false);
  });
});

describe('SEN-F07 opportunity → session → outcome', () => {
  it("I'm going opens a session from the opportunity; the outcome closes it", async () => {
    serve();
    const { findByTestId, getByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    fireEvent.press(await findByTestId('place-going'));
    expect(await findByTestId('place-session-open')).toBeTruthy();
    const start = calls.find((c) => c.url.pathname === '/api/intel/experience-sessions/from-opportunity')!;
    expect(start.method).toBe('POST');
    expect(start.body).toEqual({ subjectId: PLACE, surface: 'place' });
    // Now here: the decision is asked again with this place as the current experience.
    await waitFor(() => expect(calls.filter((c) => c.url.pathname === '/api/compass/decision').pop()!.url.searchParams.get('currentSubjectId')).toBe(PLACE));
    fireEvent.press(getByTestId('place-session-outcome-same'));
    await waitFor(() => expect(getByTestId('place-session-note').props.children).toBe('Thanks — recorded.'));
    const close = calls.find((c) => c.url.pathname === `/api/intel/experience-sessions/${SESSION}/close`)!;
    expect(close.body).toEqual({ outcome: 'same', surface: 'place' });
  });

  it('a refused start names the refusal and opens nothing', async () => {
    serve({ start: { status: 409, body: { ok: false, refusal: 'subject_not_actionable', reason: 'live_intelligence_unavailable' } } });
    const { findByTestId, queryByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    fireEvent.press(await findByTestId('place-going'));
    await waitFor(() => expect(queryByTestId('place-session-note')).toBeTruthy());
    expect(queryByTestId('place-session-note')!.props.children).toMatch(/Live intelligence couldn't be read, so no session was opened/);
    expect(queryByTestId('place-session-open')).toBeNull();
  });

  it('an opportunity refused for unreadable live intelligence is "can\'t check", not "nothing here"', async () => {
    serve({ opps: { status: 200, body: { ok: true, liveIntelligenceReadable: true, opportunities: [], refusals: [{ subjectId: PLACE, reason: 'live_intelligence_unavailable', decision: 'WAIT', decisionReasons: [] }] } } });
    const { findByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    expect((await findByTestId('place-opportunity-none')).props.children).toMatch(/^Can't check for a live opportunity here right now/);
  });

  it('an open-session read the server refused is a failure — never "no session" (which would offer a second one)', async () => {
    serve({ open: { status: 200, body: { ok: true, session: null, state: null, refusal: 'read_failed' } } });
    const { findByTestId, queryByTestId } = await render(<PlaceLivePanel placeId={PLACE} />);
    expect(await findByTestId('place-session-failed')).toBeTruthy();
    expect(queryByTestId('place-going')).toBeNull();
  });

  it('with every surface off in this build, the panel renders nothing', async () => {
    serve({ decision: OFF, live: OFF, typical: OFF, pulse: OFF, opps: OFF, open: OFF });
    const { toJSON } = await render(<PlaceLivePanel placeId={PLACE} neighborhood="An Hoi" />);
    await waitFor(() => expect(toJSON()).toBeNull());
  });
});
