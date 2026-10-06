/**
 * LayoverConstraintsCard — the declared bags and connection, and §12.1's one
 * question (census-layover L22, L35, L49, L172, L229).
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Nothing here mocks `services/layover`. The real service module runs; only
 * `fetch` and the two auth modules beneath it are replaced, so the URL, the
 * method and the PUT BODY are asserted on the fetch spy and a body the server
 * does not send cannot make these pass. The bodies are transcribed from the
 * route that produces them (artifacts/api-server/src/routes/
 * layoverConstraints.ts, `constraintsPayload`), including the refusals.
 *
 *  * A FAILED READ RENDERED AS AN EMPTY ONE. Cases 2–4: the server's 503 for a
 *    declared set it could not read, a rejected fetch, and a 200 that is not
 *    the contract must each be a stated failure with a retry — and must NOT
 *    render the "No bag time is being counted" line, which is what a card that
 *    read `null` as "nothing declared" would say to a traveller who answered
 *    "not sure".
 *  * THE CARD DECIDING SOMETHING. Cases 6–8: the question, the closures and
 *    which fields are offered are the server's. A card that asked whenever the
 *    mode was UNKNOWN (rather than when `question` arrives), or that offered a
 *    field the server did not name in `declarable`, fails.
 *  * OPTIMISTIC PAINT. Case 10: a save the server refused must leave the
 *    PREVIOUS answer selected and say the server's sentence.
 *  * A SWALLOWED PARTIAL SAVE. Case 11: `unsaved` must be said.
 *  * A GREEN BADGE THE VERDICT DOES NOT SUPPORT (LAY-FIX). Cases 14–16: the
 *    badge is named for its TONE (`layover-badge-open` / `-caution` / …), and
 *    `-open` must exist only for the verdict `yes`. Case 14 is the payload
 *    PR #588's server sends today — `LANDSIDE_AVAILABLE` beside
 *    `entry_unverified` — and fails against a card that believed the state.
 *  * THE WRONG FIELD. Case 17: the airport question must PUT
 *    `airportChangeRequired`, not a bag mode. Case 18: "Not sure" must PUT
 *    `null`, and the card must then show what the server made of it.
 *  * A START THAT WAS NOT STORED LOOKING STORED. Case 19.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverConstraintsCard } from '../LayoverConstraintsCard.tsx';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const OPEN_GATE = {
  open: true, closedBy: [], needsInfo: null, criticalUnknowns: [],
  entryPermissionState: 'CONFIRMED_ALLOWED', constraintsRead: 'declared',
  constraintsVersion: 1, entryForbidsLandside: false,
};

/** `constraintsPayload` for a versioned store with CHECKED_THROUGH declared and landside open. */
function answer(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    storage: 'versioned',
    declarable: ['baggageMode', 'recheckRequired', 'airportChangeRequired'],
    constraints: { version: 1, baggageMode: 'CHECKED_THROUGH', recheckRequired: null, airportChangeRequired: null },
    baggageCharged: false,
    landsideGate: OPEN_GATE,
    layoverState: 'LANDSIDE_AVAILABLE',
    layoverStateUnavailableReason: null,
    question: null,
    verdict: 'yes',
    confidence: 'ESTIMATED',
    reasonCodes: [],
    certification: {},
    snapshotId: 'snap-1',
    ...over,
  };
}

/** The same payload when the unknown bag is DECISIVE: landside closed, one question. */
function needsInfo() {
  return answer({
    constraints: { version: 1, baggageMode: 'UNKNOWN', recheckRequired: null, airportChangeRequired: null },
    baggageCharged: true,
    landsideGate: {
      ...OPEN_GATE, open: false, closedBy: ['baggage_unknown'], needsInfo: 'baggageMode',
      criticalUnknowns: ['BAGGAGE_STATUS_CRITICAL_UNKNOWN'],
    },
    layoverState: 'NEEDS_INFO',
    verdict: 'no',
    confidence: 'INSUFFICIENT',
    question: {
      field: 'baggageMode',
      prompt: 'Is your checked bag tagged through to your final destination?',
      options: [
        { value: 'CHECKED_THROUGH', label: 'Yes — tagged through' },
        { value: 'COLLECT_RECHECK', label: 'No — I collect and re-check it' },
        { value: 'CARRY_ON_ONLY', label: 'I only have carry-on' },
      ],
    },
  });
}

let fetchSpy: jest.SpyInstance;

function calls(method: string) {
  return fetchSpy.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method);
}

async function mount(props: Partial<React.ComponentProps<typeof LayoverConstraintsCard>> = {}) {
  return await render(<LayoverConstraintsCard sessionId="sess-1" canEdit {...props} />);
}

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('LayoverConstraintsCard — the read', () => {
  it('1. CONTROL: a declared answer renders as declared, from the session\'s own route', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, answer()));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/api\/airport\/sessions\/sess-1\/constraints$/);
    expect(screen.getByTestId('layover-constraints-baggage-current').props.children.join('')).toMatch(/Checked through/);
    // verdict `yes`, gate open, LANDSIDE_AVAILABLE: the one combination that is green.
    expect(screen.getByTestId('layover-badge-open').props.children).toBe('You can go out');
    expect(screen.queryByTestId('layover-constraints-question')).toBeNull();
    expect(screen.queryByTestId('layover-landside-closed')).toBeNull();
    expect(screen.queryByTestId('layover-landside-caution')).toBeNull();
    expect(screen.queryByTestId('layover-constraints-not-stored')).toBeNull();
    expect(screen.queryByTestId('layover-constraints-failed')).toBeNull();
  });

  it('2. the server\'s 503 for an UNREADABLE declared set is a failure with a retry — never "no bags"', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(503, {
      error: 'degraded_unavailable',
      message: 'Your bag and connection details could not be loaded. Please try again.',
      retryable: true,
    }));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-failed')).toBeTruthy());
    expect(screen.getByTestId('layover-constraints-failed-message').props.children)
      .toBe('Your bag and connection details could not be loaded. Please try again.');
    expect(screen.getByTestId('layover-constraints-retry')).toBeTruthy();
    expect(screen.queryByTestId('layover-constraints-card')).toBeNull();
    expect(screen.queryByTestId('layover-constraints-baggage-legacy')).toBeNull();
    expect(screen.queryByText(/No bag time/)).toBeNull();
  });

  it('3. a rejected fetch is a failure with a retry, and the retry reads again', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Network request failed'));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-failed')).toBeTruthy());
    expect(screen.queryByText(/No bag time/)).toBeNull();

    fetchSpy.mockResolvedValue(jsonResponse(200, answer()));
    await fireEvent.press(screen.getByTestId('layover-constraints-retry'));
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());
    expect(calls('GET')).toHaveLength(2);
    expect(screen.queryByTestId('layover-constraints-failed')).toBeNull();
  });

  it('4. a 200 that is NOT the contract is a failure — a missing gate is not an open one', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { ok: true, constraints: null }));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-failed')).toBeTruthy());
    expect(screen.queryByTestId('layover-constraints-card')).toBeNull();
    expect(screen.queryByText(/No bag time/)).toBeNull();
  });

  // ONE render per case, deliberately: two renders with an unmount between them
  // detach the RNTL screen and silently fail every LATER case in the file (the
  // note in LayoverMapCard.envelope.component.test.tsx).
  it('5. a server with NO SUCH ROUTE renders nothing — not a failure', async () => {
    // Express's own 404 for an unmounted route carries no envelope code.
    fetchSpy.mockResolvedValue(jsonResponse(404, {}));
    await mount();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('layover-constraints-loading')).toBeNull());
    expect(screen.queryByTestId('layover-constraints-failed')).toBeNull();
    expect(screen.queryByTestId('layover-constraints-card')).toBeNull();
  });

  it('5a. Layover switched OFF renders nothing — not a failure', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'feature_disabled', message: 'feature_disabled' }));
    await mount();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('layover-constraints-loading')).toBeNull());
    expect(screen.queryByTestId('layover-constraints-failed')).toBeNull();
    expect(screen.queryByTestId('layover-constraints-card')).toBeNull();
  });

  it('5b. the other half of case 5: a 404 the server CODED not_found is a stated failure', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'not_found', message: 'Session not found' }));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-failed-message').props.children).toBe('Session not found'));
  });
});

describe('LayoverConstraintsCard — what the server decided', () => {
  it('6. the ONE question appears when the server sends it, with the server\'s wording and options', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, needsInfo()));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-question')).toBeTruthy());
    expect(screen.getByText('Is your checked bag tagged through to your final destination?')).toBeTruthy();
    expect(screen.getByTestId('layover-constraints-answer-CHECKED_THROUGH')).toBeTruthy();
    expect(screen.getByTestId('layover-constraints-answer-COLLECT_RECHECK')).toBeTruthy();
    expect(screen.getByTestId('layover-constraints-answer-CARRY_ON_ONLY')).toBeTruthy();
    // "Not sure" is not an answer to the question — it is what raised it.
    expect(screen.queryByTestId('layover-constraints-answer-UNKNOWN')).toBeNull();
    expect(screen.getByTestId('layover-badge-ask').props.children).toBe('One answer needed');
    expect(screen.queryByTestId('layover-badge-open')).toBeNull();
  });

  it('7. UNKNOWN with NO question from the server asks nothing — the card does not decide it matters', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, answer({
      constraints: { version: 1, baggageMode: 'UNKNOWN', recheckRequired: null, airportChangeRequired: null },
      baggageCharged: true,
    })));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());
    expect(screen.queryByTestId('layover-constraints-question')).toBeNull();
    expect(screen.getByTestId('layover-constraints-baggage-current').props.children.join('')).toMatch(/Not sure/);
  });

  it('8. closures are listed in the server\'s order; a field the server cannot keep is not offered', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, answer({
      storage: 'session_booleans_only',
      declarable: ['baggageMode'],
      constraints: null,
      baggageCharged: true,
      landsideGate: { ...OPEN_GATE, open: false, closedBy: ['airport_change', 'entry_unconfirmed'], constraintsRead: 'legacy', constraintsVersion: null },
      layoverState: 'AIRPORT_ONLY',
      verdict: 'no',
    })));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-landside-closed')).toBeTruthy());
    expect(screen.getByTestId('layover-landside-closed-airport_change')).toBeTruthy();
    expect(screen.getByTestId('layover-landside-closed-entry_unconfirmed')).toBeTruthy();
    // Nothing four-way is stored: what is COUNTED is said, not a mode nobody chose.
    expect(screen.getByTestId('layover-constraints-baggage-legacy').props.children).toMatch(/is being counted/);
    expect(screen.queryByTestId('layover-constraints-baggage-current')).toBeNull();
    expect(screen.getByTestId('layover-constraints-baggage-UNKNOWN')).toBeTruthy();
    expect(screen.queryByTestId('layover-constraints-recheckRequired-true')).toBeNull();
    expect(screen.queryByTestId('layover-constraints-airportChangeRequired-true')).toBeNull();
    expect(screen.getByTestId('layover-constraints-storage-note')).toBeTruthy();
  });
});

describe('LayoverConstraintsCard — declaring', () => {
  it('9. answering the question PUTs that one field, renders the server\'s new answer and tells the screen', async () => {
    const onChanged = jest.fn();
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, needsInfo()));
    await mount({ onChanged });
    await waitFor(() => expect(screen.getByTestId('layover-constraints-question')).toBeTruthy());

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, {
      ...answer({ constraints: { version: 2, baggageMode: 'CHECKED_THROUGH', recheckRequired: null, airportChangeRequired: null } }),
      stored: 'versioned', unsaved: [], sessionSynced: true, persisted: { state: 'not_stored', reason: 'flag_off' },
    }));
    await fireEvent.press(screen.getByTestId('layover-constraints-answer-CHECKED_THROUGH'));

    await waitFor(() => expect(screen.queryByTestId('layover-constraints-question')).toBeNull());
    const [url, init] = calls('PUT')[0];
    expect(String(url)).toMatch(/\/api\/airport\/sessions\/sess-1\/constraints$/);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ baggageMode: 'CHECKED_THROUGH' });
    expect(screen.getByTestId('layover-badge-open')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('layover-constraints-unsaved')).toBeNull();
  });

  it('10. a REFUSED save says the server\'s sentence and leaves the previous answer on screen', async () => {
    const onChanged = jest.fn();
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, answer()));
    await mount({ onChanged });
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());

    fetchSpy.mockResolvedValueOnce(jsonResponse(503, {
      error: 'degraded_unavailable',
      message: 'Your bag and connection details could not be saved. Please try again.',
      retryable: true,
    }));
    await fireEvent.press(screen.getByTestId('layover-constraints-baggage-COLLECT_RECHECK'));

    await waitFor(() => expect(screen.getByTestId('layover-constraints-save-error')).toBeTruthy());
    expect(screen.getByTestId('layover-constraints-save-error').props.children)
      .toBe('Your bag and connection details could not be saved. Please try again.');
    // Still the answer the server last certified — not the option that was pressed.
    expect(screen.getByTestId('layover-constraints-baggage-current').props.children.join('')).toMatch(/Checked through/);
    expect(screen.getByTestId('layover-constraints-baggage-CHECKED_THROUGH').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('layover-constraints-baggage-COLLECT_RECHECK').props.accessibilityState.selected).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('11. a connection fact is sent as stated — and what could NOT be kept is said', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, answer()));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, {
      ...answer({
        constraints: { version: 2, baggageMode: 'CHECKED_THROUGH', recheckRequired: null, airportChangeRequired: true },
        landsideGate: { ...OPEN_GATE, open: false, closedBy: ['airport_change'], constraintsVersion: 2 },
        layoverState: 'AIRPORT_ONLY', verdict: 'no',
      }),
      stored: 'versioned', unsaved: ['recheckRequired'], sessionSynced: true,
    }));
    await fireEvent.press(screen.getByTestId('layover-constraints-airportChangeRequired-true'));

    await waitFor(() => expect(screen.getByTestId('layover-landside-closed-airport_change')).toBeTruthy());
    expect(JSON.parse(String((calls('PUT')[0][1] as RequestInit).body))).toEqual({ airportChangeRequired: true });
    expect(screen.getByTestId('layover-constraints-airportChangeRequired-true').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('layover-constraints-unsaved').props.children).toMatch(/check in again/);
  });

  it('12. a closed layover is read-only: the answer is shown and nothing can be pressed into a PUT', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, needsInfo()));
    await mount({ canEdit: false });
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());
    // Not asked a question it can no longer answer — told why instead.
    expect(screen.queryByTestId('layover-constraints-question')).toBeNull();
    expect(screen.queryByTestId('layover-constraints-answer-CHECKED_THROUGH')).toBeNull();
    expect(screen.getByTestId('layover-landside-closed-baggage_unknown')).toBeTruthy();
    expect(screen.queryByTestId('layover-constraints-baggage-CARRY_ON_ONLY')).toBeNull();
    await fireEvent.press(screen.getByTestId('layover-constraints-airportChangeRequired-true'));
    expect(calls('PUT')).toHaveLength(0);
  });

  it('13. the parent\'s refresh re-reads, and a read that fails AFTER an answer is a failure, not the old answer', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, answer()));
    const view = await mount({ refreshKey: 1 });
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());

    fetchSpy.mockResolvedValueOnce(jsonResponse(503, {
      error: 'degraded_unavailable', message: 'Your layover could not be loaded. Please try again.', retryable: true,
    }));
    await view.rerender(<LayoverConstraintsCard sessionId="sess-1" canEdit refreshKey={2} />);
    await waitFor(() => expect(screen.getByTestId('layover-constraints-failed')).toBeTruthy());
    expect(calls('GET')).toHaveLength(2);
  });
});

/**
 * LAY-FIX — the badge cannot say more than the verdict card mounted above it.
 * Bodies are `constraintsPayload`'s, transcribed from
 * artifacts/api-server/src/services/layover/LayoverConstraintService.ts.
 */
describe('LayoverConstraintsCard — the badge follows the verdict', () => {
  it('14. a STALE server\'s LANDSIDE_AVAILABLE beside `entry_unverified` is NOT drawn as "You can go out"', async () => {
    // Exactly what PR #588's server answers for a 12 h layover on a border
    // nobody has checked: an open gate, an affirmative state, a cautionary verdict.
    fetchSpy.mockResolvedValue(jsonResponse(200, answer({
      verdict: 'entry_unverified',
      landsideGate: { ...OPEN_GATE, entryPermissionState: 'UNKNOWN', constraintsRead: 'legacy', constraintsVersion: null },
      layoverState: 'LANDSIDE_AVAILABLE',
    })));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());
    expect(screen.queryByTestId('layover-badge-open')).toBeNull();
    expect(screen.queryByText('You can go out')).toBeNull();
    expect(screen.getByTestId('layover-badge-caution').props.children).toBe('Entry unconfirmed');
  });

  it('15. the fixed server\'s cautionary answer: no state, a caution, and the reason said in the card', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, answer({
      verdict: 'entry_unverified',
      landsideGate: {
        ...OPEN_GATE, open: false, status: 'caution', closedBy: [], cautions: ['entry_unconfirmed'],
        entryPermissionState: 'UNKNOWN', constraintsRead: 'legacy', constraintsVersion: null,
      },
      layoverState: null,
      layoverStateUnavailableReason: 'landside_unconfirmed',
    })));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());
    expect(screen.queryByTestId('layover-badge-open')).toBeNull();
    expect(screen.getByTestId('layover-badge-caution').props.children).toBe('Entry unconfirmed');
    expect(screen.getByTestId('layover-landside-caution-entry_unconfirmed')).toBeTruthy();
    // A caution is not a closure, and is not worded as one.
    expect(screen.queryByTestId('layover-landside-closed')).toBeNull();
  });

  it('16. a tight window is amber too, in the verdict\'s own words — and an unreadable store is closed, by name', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, answer({
      verdict: 'tight',
      landsideGate: { ...OPEN_GATE, open: false, status: 'caution', closedBy: [], cautions: ['tight_window'] },
      layoverState: null, layoverStateUnavailableReason: 'landside_unconfirmed',
    })));
    const view = await mount({ refreshKey: 1 });
    await waitFor(() => expect(screen.getByTestId('layover-badge-caution')).toBeTruthy());
    expect(screen.getByTestId('layover-badge-caution').props.children).toBe('Tight — stay close');
    expect(screen.getByTestId('layover-landside-caution-tight_window')).toBeTruthy();

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, answer({
      verdict: 'no',
      landsideGate: { ...OPEN_GATE, open: false, status: 'closed', closedBy: ['constraints_unreadable'], cautions: [], constraintsRead: 'unreadable', constraintsVersion: null },
      layoverState: 'AIRPORT_ONLY',
    })));
    await view.rerender(<LayoverConstraintsCard sessionId="sess-1" canEdit refreshKey={2} />);
    await waitFor(() => expect(screen.getByTestId('layover-landside-closed-constraints_unreadable')).toBeTruthy());
    expect(screen.getByTestId('layover-badge-closed').props.children).toBe('Airport only');
    expect(screen.queryByTestId('layover-badge-open')).toBeNull();
    expect(screen.queryByTestId('layover-landside-caution')).toBeNull();
  });
});

/** `constraintsPayload` when "not sure" about the airport change is what closed landside. */
function needsAirport() {
  return answer({
    constraints: { version: 2, baggageMode: 'CARRY_ON_ONLY', recheckRequired: false, airportChangeRequired: null },
    landsideGate: {
      ...OPEN_GATE, open: false, status: 'closed', closedBy: ['airport_change_unknown'], cautions: [],
      needsInfo: 'airportChangeRequired', criticalUnknowns: ['airport_change_required'], constraintsVersion: 2,
    },
    layoverState: 'NEEDS_INFO',
    verdict: 'no',
    confidence: 'INSUFFICIENT',
    question: {
      field: 'airportChangeRequired',
      prompt: 'Does your next flight leave from this airport, or a different airport?',
      options: [{ value: false, label: 'This airport' }, { value: true, label: 'A different airport' }],
    },
  });
}

describe('LayoverConstraintsCard — "Not sure" on the airport change', () => {
  it('17. the airport question is asked in the server\'s words and answered on ITS field', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, needsAirport()));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-constraints-question')).toBeTruthy());
    expect(screen.getByText('Does your next flight leave from this airport, or a different airport?')).toBeTruthy();
    expect(screen.getByTestId('layover-constraints-question-why').props.children).toMatch(/different airport/);
    expect(screen.getByTestId('layover-constraints-answer-false')).toBeTruthy();
    expect(screen.getByTestId('layover-constraints-answer-true')).toBeTruthy();
    expect(screen.getByTestId('layover-badge-ask')).toBeTruthy();

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, {
      ...answer({ constraints: { version: 3, baggageMode: 'CARRY_ON_ONLY', recheckRequired: false, airportChangeRequired: false } }),
      stored: 'versioned', unsaved: [], sessionSynced: true, unchanged: false,
    }));
    await fireEvent.press(screen.getByTestId('layover-constraints-answer-false'));
    await waitFor(() => expect(screen.queryByTestId('layover-constraints-question')).toBeNull());
    // NOT `{ baggageMode: false }`, which is what a card that assumed every
    // question was the bag question would have sent.
    expect(JSON.parse(String((calls('PUT')[0][1] as RequestInit).body))).toEqual({ airportChangeRequired: false });
    expect(screen.getByTestId('layover-badge-open')).toBeTruthy();
  });

  it('18. pressing "Not sure" PUTs null, and the card shows the closure the server made of it — not an open gate', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, answer({
      constraints: { version: 1, baggageMode: 'CARRY_ON_ONLY', recheckRequired: false, airportChangeRequired: false },
    })));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-badge-open')).toBeTruthy());

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { ...needsAirport(), stored: 'versioned', unsaved: [], sessionSynced: true, unchanged: false }));
    await fireEvent.press(screen.getByTestId('layover-constraints-airportChangeRequired-null'));

    await waitFor(() => expect(screen.getByTestId('layover-constraints-question')).toBeTruthy());
    expect(JSON.parse(String((calls('PUT')[0][1] as RequestInit).body))).toEqual({ airportChangeRequired: null });
    expect(screen.queryByTestId('layover-badge-open')).toBeNull();
    expect(screen.getByTestId('layover-badge-ask')).toBeTruthy();
    expect(screen.getByTestId('layover-constraints-airportChangeRequired-null').props.accessibilityState.selected).toBe(true);
  });
});

describe('LayoverConstraintsCard — what the start sheet could not keep', () => {
  it('19. a start whose answers were NOT stored says so, until the traveller declares here', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, answer({
      storage: 'versioned', constraints: null, baggageCharged: true,
      landsideGate: { ...OPEN_GATE, open: false, status: 'closed', closedBy: ['airport_change_unknown'], cautions: [], constraintsRead: 'undeclared', constraintsVersion: null },
      layoverState: 'AIRPORT_ONLY', verdict: 'no',
    })));
    await mount({ creationNotice: 'not_stored' });
    await waitFor(() => expect(screen.getByTestId('layover-constraints-not-stored')).toBeTruthy());
    expect(screen.getByTestId('layover-constraints-not-stored').props.children).toMatch(/were not saved/);
    // Nothing is shown as the traveller's chosen mode: none was kept.
    expect(screen.queryByTestId('layover-constraints-baggage-current')).toBeNull();
    for (const mode of ['CARRY_ON_ONLY', 'CHECKED_THROUGH', 'COLLECT_RECHECK', 'UNKNOWN']) {
      expect(screen.getByTestId(`layover-constraints-baggage-${mode}`).props.accessibilityState.selected).toBe(false);
    }

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, {
      ...answer({ constraints: { version: 1, baggageMode: 'UNKNOWN', recheckRequired: null, airportChangeRequired: null } }),
      stored: 'versioned', unsaved: [], sessionSynced: true, unchanged: false,
    }));
    await fireEvent.press(screen.getByTestId('layover-constraints-baggage-UNKNOWN'));
    await waitFor(() => expect(screen.queryByTestId('layover-constraints-not-stored')).toBeNull());
    expect(screen.getByTestId('layover-constraints-baggage-UNKNOWN').props.accessibilityState.selected).toBe(true);
  });

  it('20. CONTROL: with nothing reported from the start, nothing is said', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, answer()));
    await mount({ creationNotice: null });
    await waitFor(() => expect(screen.getByTestId('layover-constraints-card')).toBeTruthy());
    expect(screen.queryByTestId('layover-constraints-not-stored')).toBeNull();
  });
});
