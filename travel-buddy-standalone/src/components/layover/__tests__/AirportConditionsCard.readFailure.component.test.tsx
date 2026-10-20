import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AirportConditionsCard } from '../AirportConditionsCard.tsx';
import type { AirportObservationsResult } from '../../../services/layover.ts';

jest.mock('@supabase/supabase-js', () => ({
  ...jest.requireActual('@supabase/supabase-js'),
  createClient: jest.fn(() => ({
    auth: {
      getSession: jest.fn(async () => ({
        data: { session: { access_token: 'dummy-token', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      })),
    },
  })),
}));

const originalFetch = global.fetch;
const originalApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const unavailable = 'Reports for this airport could not be loaded.';
const retry = 'Retry loading airport reports';
const reportChoice = 'Report Queue right now: 15 min';

function readings(airportRef = 'AIRPORT-A'): AirportObservationsResult {
  return {
    airportRef,
    submittableFactTypes: ['queue_report_minutes', 'checkpoint_timing_minutes', 'closure_reported'],
    rateLimit: { maxPerWindow: 3, windowMinutes: 30 },
    facts: [],
  };
}

function response(body: unknown = readings(), status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function invalidJson(): Response {
  return { ...response(), json: async () => { throw new SyntaxError('Invalid JSON'); } };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function failNext(kind: string) {
  if (kind === 'offline') fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
  else fetchMock.mockResolvedValueOnce(kind === 'json' ? invalidJson() : response({}, 503));
}

async function flush() {
  await act(async () => {});
}

function expectUnavailable() {
  expect(screen.getByText(unavailable)).toBeTruthy();
  expect(screen.getByLabelText(retry)).toBeEnabled();
  expect(screen.queryByText('No reading yet.')).toBeNull();
  expect(screen.queryByLabelText(reportChoice)).toBeNull();
  expect(screen.container.queryAll(element => element.type === 'ActivityIndicator')).toHaveLength(0);
}

function expectAirport(airportRef = 'AIRPORT-A') {
  expect(screen.getByText(`What other travellers are reporting at ${airportRef}, and your chance to add to it.`)).toBeTruthy();
  expect(screen.queryByText(unavailable)).toBeNull();
}

function postedReports() {
  return fetchMock.mock.calls
    .filter(([, options]) => options?.method === 'POST')
    .map(([url, options]) => ({ url, body: JSON.parse(String(options?.body)) }));
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://example.invalid';
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBase;
});

describe('AirportConditionsCard real-service read failures', () => {
  it.each(['offline', 'json', 'http'])('%s is unavailable, not empty or zero, until an explicit retry', async (failure) => {
    failNext(failure);
    await render(<AirportConditionsCard sessionId="session-a" />);
    await flush();
    expectUnavailable();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await fireEvent.press(screen.getByLabelText(retry));
    expect(screen.queryByText(unavailable)).toBeNull();
    expect(screen.container.queryAll(element => element.type === 'ActivityIndicator')).toHaveLength(1);
    await act(async () => pending.resolve(response()));
    expectAirport();
    expect(screen.getAllByText('No reading yet.')).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual([
      'http://example.invalid/api/airport/sessions/session-a/observations',
      { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy-token' } },
    ]);
    expect(postedReports()).toHaveLength(0);
  });

  it('a successful empty read is not unavailable or a zero-valued reading', async () => {
    fetchMock.mockResolvedValueOnce(response());
    await render(<AirportConditionsCard sessionId="session-a" />);
    expectAirport();
    expect(screen.getAllByText('No reading yet.')).toHaveLength(3);
    expect(screen.queryByLabelText(retry)).toBeNull();
    expect(screen.getByLabelText(reportChoice)).toBeEnabled();
  });

  it('preserves server confidence, corroboration and conflict without inventing a reading', async () => {
    const data = readings();
    data.facts = [
      {
        factType: 'queue_report_minutes', factClass: 'TRAVELER_OBSERVATION', truthVersion: 'fixture',
        truth: { value: 37, confidence: 'LOW', conflict: true, sourceClass: 'LIVE', sourceRefs: ['fixture'], observedAt: null, expiresAt: null, fallbackLevel: 'NONE' },
        corroboration: { community: 2 }, conflictBetween: { low: 5, high: 37 }, rulesApplied: [],
      },
      {
        factType: 'checkpoint_timing_minutes', factClass: 'TRAVELER_OBSERVATION', truthVersion: 'fixture',
        truth: null, corroboration: { community: 1 }, conflictBetween: null, rulesApplied: [],
      },
    ];
    fetchMock.mockResolvedValueOnce(response(data));
    await render(<AirportConditionsCard sessionId="session-a" />);
    expect(screen.getByText('37 min')).toBeTruthy();
    expect(screen.getByText('2 travellers · low confidence')).toBeTruthy();
    expect(screen.getByText('Reports disagree — the more cautious one is shown.')).toBeTruthy();
    expect(screen.getByText(/1 traveller has reported/)).toBeTruthy();
    expect(screen.getAllByText('No reading yet.')).toHaveLength(1);
  });

  it('refresh clears the previous reading while pending and ends unavailable on rejection', async () => {
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    expectAirport();
    await view.rerender(<AirportConditionsCard sessionId="session-a" refreshKey={1} />);
    const oldAirport = Boolean(screen.queryByText(/What other travellers are reporting at AIRPORT-A/));
    await act(async () => pending.reject(new Error('offline refresh')));
    expect(oldAirport).toBe(false);
    expectUnavailable();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed explicit retry returns to retryable unavailable without looping', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(invalidJson());
    await render(<AirportConditionsCard sessionId="session-a" />);
    await fireEvent.press(screen.getByLabelText(retry));
    await flush();
    expectUnavailable();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AirportConditionsCard read ownership', () => {
  it.each(['success', 'refusal', 'rejection'])('an older refresh %s cannot overwrite the newer read', async (completion) => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(readings('CURRENT')));
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await view.rerender(<AirportConditionsCard sessionId="session-a" refreshKey={1} />);
    expectAirport('CURRENT');
    await act(async () => {
      if (completion === 'rejection') pending.reject(new Error('stale read'));
      else pending.resolve(response(readings('STALE'), completion === 'refusal' ? 503 : 200));
    });
    expectAirport('CURRENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'refusal', 'rejection'])('previous-session %s cannot end the current airport loading state', async (completion) => {
    const previous = deferred<Response>();
    const current = deferred<Response>();
    fetchMock.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await view.rerender(<AirportConditionsCard sessionId="session-b" />);
    await act(async () => {
      if (completion === 'rejection') previous.reject(new Error('old airport'));
      else previous.resolve(response(readings('OLD'), completion === 'refusal' ? 503 : 200));
    });
    const result = { spinners: screen.container.queryAll(element => element.type === 'ActivityIndicator').length, unavailable: Boolean(screen.queryByText(unavailable)), oldAirport: Boolean(screen.queryByText(/reporting at OLD/)) };
    await act(async () => current.resolve(response(readings('NEW'))));
    expect(result).toEqual({ spinners: 1, unavailable: false, oldAirport: false });
    expectAirport('NEW');
  });

  it('an already displayed airport disappears immediately when the session changes', async () => {
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await view.rerender(<AirportConditionsCard sessionId="session-b" />);
    const oldAirport = Boolean(screen.queryByText(/reporting at AIRPORT-A/));
    await act(async () => pending.resolve(response(readings('NEW'))));
    expect(oldAirport).toBe(false);
    expectAirport('NEW');
  });

  it('changing away and back never revives the earlier airport lifetime', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response(readings('B'))).mockResolvedValueOnce(response(readings('CURRENT-A')));
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await view.rerender(<AirportConditionsCard sessionId="session-b" />);
    await view.rerender(<AirportConditionsCard sessionId="session-a" />);
    await act(async () => pending.resolve(response(readings('OLD-A'))));
    expectAirport('CURRENT-A');
  });

  it.each(['success', 'rejection'])('unmounted read %s cannot affect a replacement card', async (completion) => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(readings('REPLACEMENT')));
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await view.unmount();
    await render(<AirportConditionsCard sessionId="session-a" />);
    await act(async () => {
      if (completion === 'rejection') pending.reject(new Error('late unmounted read'));
      else pending.resolve(response(readings('OLD')));
    });
    expectAirport('REPLACEMENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fences a stale JSON body that finishes after the newer read', async () => {
    const body = deferred<AirportObservationsResult>();
    fetchMock.mockResolvedValueOnce({ ...response(), json: () => body.promise })
      .mockResolvedValueOnce(response(readings('CURRENT')));
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await view.rerender(<AirportConditionsCard sessionId="session-a" refreshKey={1} />);
    await act(async () => body.resolve(readings('OLD')));
    expectAirport('CURRENT');
  });
});

describe('AirportConditionsCard accepted reports and submission tokens', () => {
  it('repeated presses while a report is pending do not submit another report', async () => {
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
    await render(<AirportConditionsCard sessionId="session-a" />);
    await fireEvent.press(screen.getByLabelText(reportChoice));
    await fireEvent.press(screen.getByLabelText(reportChoice));
    expect(postedReports()).toHaveLength(1);
    expect(screen.getByLabelText(reportChoice).props.accessibilityState.busy).toBe(true);
    fetchMock.mockResolvedValueOnce(response());
    await act(async () => pending.resolve(response({ duplicate: false })));
    expectAirport();
    expect(postedReports()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('report refusal cannot finish a pending parent refresh or discard its retry token', async () => {
    const report = deferred<Response>();
    const refresh = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(report.promise).mockReturnValueOnce(refresh.promise);
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await fireEvent.press(screen.getByLabelText(reportChoice));
    const token = postedReports()[0].body.submissionToken;
    await view.rerender(<AirportConditionsCard sessionId="session-a" refreshKey={1} />);
    await act(async () => report.resolve(response({ message: 'Retry this report.' }, 429)));
    expect(screen.container.queryAll(element => element.type === 'ActivityIndicator')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => refresh.resolve(response()));
    expect(screen.getByText('Retry this report.')).toBeTruthy();
    expect(screen.getByLabelText(reportChoice)).toBeEnabled();
    fetchMock.mockResolvedValueOnce(response({ duplicate: false })).mockResolvedValueOnce(response());
    await fireEvent.press(screen.getByLabelText(reportChoice));
    expect(postedReports()).toHaveLength(2);
    expect(postedReports()[1].body.submissionToken).toBe(token);
  });

  it.each([
    ['offline', false], ['json', false], ['http', false],
    ['offline', true], ['json', true], ['http', true],
  ])('accepted report then %s refresh failure (duplicate=%s) retries only the read', async (failure, duplicate) => {
    fetchMock.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ duplicate }));
    failNext(String(failure));
    await render(<AirportConditionsCard sessionId="session-a" />);
    await fireEvent.press(screen.getByLabelText(reportChoice));
    await flush();
    expectUnavailable();
    const firstReport = postedReports()[0];
    expect(firstReport.body).toEqual({ factType: 'queue_report_minutes', value: 15, submissionToken: expect.any(String) });
    expect(postedReports()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockResolvedValueOnce(response());
    await fireEvent.press(screen.getByLabelText(retry));
    expectAirport();
    expect(screen.getByText(duplicate ? 'Already recorded — thank you.' : 'Thank you — your report is in.')).toBeTruthy();
    expect(screen.getByLabelText(reportChoice)).toBeEnabled();
    expect(postedReports()).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(response({ duplicate: false })).mockResolvedValueOnce(response());
    await fireEvent.press(screen.getByLabelText(reportChoice));
    expect(postedReports()).toHaveLength(2);
    expect(postedReports()[1].body.submissionToken).not.toBe(firstReport.body.submissionToken);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each(['offline', 'refusal'])('a %s report keeps its token through failed read and explicit retries', async (failure) => {
    fetchMock.mockResolvedValueOnce(response());
    if (failure === 'offline') fetchMock.mockRejectedValueOnce(new Error('offline report'));
    else fetchMock.mockResolvedValueOnce(response({ message: 'Report refused.' }, 429));
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await fireEvent.press(screen.getByLabelText(reportChoice));
    expect(screen.getByText(failure === 'offline' ? 'Your report could not be sent. Please try again.' : 'Report refused.')).toBeTruthy();
    expect(screen.getByLabelText(reportChoice)).toBeEnabled();
    const firstToken = postedReports()[0].body.submissionToken;
    fetchMock.mockResolvedValueOnce(response({}, 503));
    await view.rerender(<AirportConditionsCard sessionId="session-a" refreshKey={1} />);
    expectUnavailable();
    fetchMock.mockResolvedValueOnce(response());
    await fireEvent.press(screen.getByLabelText(retry));
    expect(postedReports()).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(response({ duplicate: true })).mockResolvedValueOnce(response());
    await fireEvent.press(screen.getByLabelText(reportChoice));
    expect(postedReports()[1].body.submissionToken).toBe(firstToken);
    expect(screen.getByText('Already recorded — thank you.')).toBeTruthy();
  });

  it('different report choices do not share a refused-intent token', async () => {
    fetchMock.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({}, 429)).mockResolvedValueOnce(response({}, 429));
    await render(<AirportConditionsCard sessionId="session-a" />);
    await fireEvent.press(screen.getByLabelText(reportChoice));
    await fireEvent.press(screen.getByLabelText('Report Queue right now: 30 min'));
    expect(postedReports()).toHaveLength(2);
    expect(postedReports()[0].body.submissionToken).not.toBe(postedReports()[1].body.submissionToken);
  });

  it.each(['success', 'refusal', 'offline'])('previous-session report %s cannot refresh the old airport or alter a new report', async (completion) => {
    const previous = deferred<Response>();
    const current = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(response(readings('CURRENT'))).mockReturnValueOnce(current.promise);
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await fireEvent.press(screen.getByLabelText(reportChoice));
    await view.rerender(<AirportConditionsCard sessionId="session-b" />);
    await fireEvent.press(screen.getByLabelText(reportChoice));
    await act(async () => {
      if (completion === 'offline') previous.reject(new Error('old report offline'));
      else previous.resolve(response({ duplicate: false, message: 'Old refusal.' }, completion === 'refusal' ? 429 : 200));
    });
    const observed = { requests: fetchMock.mock.calls.length, reports: postedReports().length, oldNotice: Boolean(screen.queryByText('Old refusal.')), busy: screen.getByLabelText(reportChoice).props.accessibilityState.busy };
    fetchMock.mockResolvedValueOnce(response(readings('CURRENT')));
    await act(async () => current.resolve(response({ duplicate: false })));
    expect(observed).toEqual({ requests: 4, reports: 2, oldNotice: false, busy: true });
    expectAirport('CURRENT');
    expect(postedReports()[0].body.submissionToken).not.toBe(postedReports()[1].body.submissionToken);
    expect(postedReports()[1].url).toContain('/sessions/session-b/observations');
  });

  it('a report accepted after unmount does not launch a follow-up read', async () => {
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
    const view = await render(<AirportConditionsCard sessionId="session-a" />);
    await fireEvent.press(screen.getByLabelText(reportChoice));
    await view.unmount();
    await act(async () => pending.resolve(response({ duplicate: false })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
