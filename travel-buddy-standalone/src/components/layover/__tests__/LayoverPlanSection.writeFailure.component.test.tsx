import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { LayoverPlanSection } from '../LayoverPlanSection.tsx';
import type { PlanFit, StopsResponse } from '../../../services/layover.ts';

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
const placeholder = 'e.g. Ramen at the old market';
const planFit: PlanFit = {
  totalPlannedMin: 0,
  returnTravelMin: 0,
  neededMin: 0,
  usableMinutes: 120,
  fitsWindow: true,
  fit: 'fits',
  unstatedTravelStops: 0,
  unstatedDurationStops: 0,
  neededMinIsLowerBound: false,
  overflowMin: 0,
  backByTime: '2026-10-16T16:00:00.000Z',
};
const saved: StopsResponse = { stops: [], planFit };

function response(status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => saved } as Response;
}

function deferred<ResponseType>() {
  let resolve!: (value: ResponseType) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ResponseType>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function props(sessionId = 'session-one') {
  return {
    sessionId,
    stops: [],
    planFit,
    timezone: 'UTC',
    canEdit: true,
    onChanged: jest.fn(),
    onError: jest.fn(),
  };
}

async function openDraft(title = 'My unsaved stop') {
  await fireEvent.press(screen.getByText('Add a stop'));
  await fireEvent.changeText(screen.getByPlaceholderText(placeholder), title);
}

async function submit() {
  await fireEvent.press(screen.getByText('Add to plan'));
  await act(async () => {});
}

function expectDraft(title = 'My unsaved stop') {
  expect(screen.getByPlaceholderText(placeholder).props.value).toBe(title);
  expect(screen.getByText('New stop')).toBeTruthy();
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

describe('LayoverPlanSection write acknowledgment and draft ownership', () => {
  it.each([400, 503])('HTTP %s keeps the draft and permits only an explicit retry', async (status) => {
    const callbacks = props();
    fetchMock.mockResolvedValueOnce(response(status)).mockResolvedValueOnce(response());
    await render(<LayoverPlanSection {...callbacks} />);
    await openDraft();
    await fireEvent.press(screen.getAllByText('45m')[0]);
    await fireEvent.press(screen.getAllByText('30m')[1]);
    await submit();
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledWith('Could not add the stop.');
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectDraft();
    expect(screen.getByText('Add to plan')).toBeEnabled();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      title: 'My unsaved stop', durationMin: 45, travelMin: 30, insideAirport: false,
    });
    expect(callbacks.onChanged).toHaveBeenCalledWith(saved);
    expect(screen.queryByPlaceholderText(placeholder)).toBeNull();
  });

  it.each(['network', 'json'])('%s rejection reports the existing error and resets busy without losing the draft', async (failure) => {
    const callbacks = props();
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
    else fetchMock.mockResolvedValueOnce({ ...response(), json: async () => { throw new SyntaxError('invalid JSON'); } });
    fetchMock.mockResolvedValueOnce(response());
    await render(<LayoverPlanSection {...callbacks} />);
    await openDraft();
    await submit();
    await waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith('Could not add the stop.'));
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectDraft();
    expect(screen.getByText('Add to plan')).toBeEnabled();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callbacks.onChanged).toHaveBeenCalledWith(saved);
  });

  it('successful acknowledgment updates the plan and clears only the submitted draft', async () => {
    const callbacks = props();
    fetchMock.mockResolvedValueOnce(response());
    await render(<LayoverPlanSection {...callbacks} />);
    await openDraft('  My unsaved stop  ');
    await submit();
    expect(fetchMock).toHaveBeenCalledWith('http://example.invalid/api/airport/sessions/session-one/stops', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy-token' },
      body: JSON.stringify({ title: 'My unsaved stop', durationMin: 60, travelMin: 20, insideAirport: false }),
    }));
    expect(callbacks.onChanged).toHaveBeenCalledTimes(1);
    expect(callbacks.onChanged).toHaveBeenCalledWith(saved);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(placeholder)).toBeNull();
    await fireEvent.press(screen.getByText('Add a stop'));
    expectDraft('');
    expect(screen.getByText('Add to plan')).toBeEnabled();
  });

  it.each(['title', 'duration', 'travel', 'inside', 'edit-back'])('success preserves later %s edits rather than clearing the editor', async (field) => {
    const callbacks = props();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response());
    await render(<LayoverPlanSection {...callbacks} />);
    await openDraft();
    await submit();
    if (field === 'title' || field === 'edit-back') {
      await fireEvent.changeText(screen.getByPlaceholderText(placeholder), 'Later draft');
      if (field === 'edit-back') await fireEvent.changeText(screen.getByPlaceholderText(placeholder), 'My unsaved stop');
    } else if (field === 'duration') await fireEvent.press(screen.getAllByText('45m')[0]);
    else if (field === 'travel') await fireEvent.press(screen.getAllByText('30m')[1]);
    else await fireEvent(screen.getByRole('switch'), 'valueChange', true);
    await act(async () => pending.resolve(response()));
    expectDraft(field === 'title' ? 'Later draft' : 'My unsaved stop');
    expect(callbacks.onChanged).toHaveBeenCalledWith(saved);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Add to plan')).toBeEnabled();
    await submit();
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      title: field === 'title' ? 'Later draft' : 'My unsaved stop',
      durationMin: field === 'duration' ? 45 : 60,
      travelMin: field === 'inside' ? 0 : field === 'travel' ? 30 : 20,
      insideAirport: field === 'inside',
    });
  });

  it.each([false, true])('closing the editor invalidates draft cleanup even when reopened=%s', async (reopen) => {
    const callbacks = props();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await render(<LayoverPlanSection {...callbacks} />);
    await openDraft();
    await submit();
    await fireEvent.press(screen.getByTestId('icon-X'));
    if (reopen) await fireEvent.press(screen.getByText('Add a stop'));
    await act(async () => pending.resolve(response()));
    expect(callbacks.onChanged).toHaveBeenCalledWith(saved);
    expect(callbacks.onError).not.toHaveBeenCalled();
    if (!reopen) {
      expect(screen.queryByPlaceholderText(placeholder)).toBeNull();
      await fireEvent.press(screen.getByText('Add a stop'));
    }
    expectDraft();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'refusal', 'throw'])('old-session %s cannot publish, clear a later draft, or release its busy state', async (completion) => {
    const previous = props();
    const current = props('session-two');
    const oldRequest = deferred<Response>();
    const newRequest = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const view = await render(<LayoverPlanSection {...previous} />);
    await openDraft();
    await submit();
    await view.rerender(<LayoverPlanSection {...current} />);
    if (screen.queryByPlaceholderText(placeholder)) await fireEvent.press(screen.getByTestId('icon-X'));
    await openDraft('New session draft');
    await submit();
    await act(async () => {
      if (completion === 'throw') oldRequest.reject(new Error('late offline'));
      else oldRequest.resolve(response(completion === 'refusal' ? 503 : 200));
    });
    const observed = {
      oldChanges: previous.onChanged.mock.calls.length,
      oldErrors: previous.onError.mock.calls.length,
      requests: fetchMock.mock.calls.length,
      draft: screen.queryByPlaceholderText(placeholder)?.props.value,
    };
    try {
      expect(observed).toEqual({ oldChanges: 0, oldErrors: 0, requests: 2, draft: 'New session draft' });
      expect(screen.getByText('Add to plan')).toBeDisabled();
    } finally {
      await act(async () => newRequest.resolve(response()));
    }
    expect(current.onChanged).toHaveBeenCalledWith(saved);
    expect(current.onError).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][0]).toBe('http://example.invalid/api/airport/sessions/session-two/stops');
  });

  it('switching session away and back does not revive the previous request', async () => {
    const callbacks = props();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = await render(<LayoverPlanSection {...callbacks} />);
    await openDraft();
    await submit();
    await view.rerender(<LayoverPlanSection {...callbacks} sessionId="session-two" />);
    await view.rerender(<LayoverPlanSection {...callbacks} />);
    await act(async () => pending.resolve(response()));
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Add a stop'));
    expectDraft('');
  });

  it('loss of editability invalidates the pending response even if editability returns', async () => {
    const callbacks = props();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = await render(<LayoverPlanSection {...callbacks} />);
    await openDraft();
    await submit();
    await view.rerender(<LayoverPlanSection {...callbacks} canEdit={false} />);
    await view.rerender(<LayoverPlanSection {...callbacks} />);
    await fireEvent.changeText(screen.getByPlaceholderText(placeholder), 'Later draft');
    await act(async () => pending.resolve(response()));
    expectDraft('Later draft');
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(screen.getByText('Add to plan')).toBeEnabled();
  });

  it.each(['success', 'throw'])('unmount blocks late %s callbacks without touching a replacement editor', async (completion) => {
    const previous = props();
    const current = props();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = await render(<LayoverPlanSection {...previous} />);
    await openDraft();
    await submit();
    await view.unmount();
    await render(<LayoverPlanSection {...current} />);
    await openDraft('Replacement draft');
    await act(async () => {
      if (completion === 'throw') pending.reject(new Error('late offline'));
      else pending.resolve(response());
    });
    expectDraft('Replacement draft');
    expect(previous.onChanged).not.toHaveBeenCalled();
    expect(previous.onError).not.toHaveBeenCalled();
    expect(current.onChanged).not.toHaveBeenCalled();
    expect(current.onError).not.toHaveBeenCalled();
  });

  it.each(['success', 'throw'])('superseded %s cannot release a newer request in the same editor', async (completion) => {
    const callbacks = props();
    const oldRequest = deferred<Response>();
    const newRequest = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const view = await render(<LayoverPlanSection {...callbacks} />);
    await openDraft();
    await submit();
    await view.rerender(<LayoverPlanSection {...callbacks} canEdit={false} />);
    await view.rerender(<LayoverPlanSection {...callbacks} />);
    await fireEvent.changeText(screen.getByPlaceholderText(placeholder), 'Later draft');
    await submit();
    await act(async () => {
      if (completion === 'throw') oldRequest.reject(new Error('late offline'));
      else oldRequest.resolve(response());
    });
    try {
      expectDraft('Later draft');
      expect(screen.getByText('Add to plan')).toBeDisabled();
      expect(callbacks.onChanged).not.toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => newRequest.resolve(response()));
    }
    expect(callbacks.onChanged).toHaveBeenCalledTimes(1);
    expect(callbacks.onChanged).toHaveBeenCalledWith(saved);
    expect(screen.queryByPlaceholderText(placeholder)).toBeNull();
    await openDraft();
    expect(screen.getByText('Add to plan')).toBeEnabled();
  });

  it('an in-flight add cannot be submitted twice', async () => {
    const callbacks = props();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await render(<LayoverPlanSection {...callbacks} />);
    await openDraft();
    await submit();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(response()));
    expect(callbacks.onChanged).toHaveBeenCalledTimes(1);
  });
});
