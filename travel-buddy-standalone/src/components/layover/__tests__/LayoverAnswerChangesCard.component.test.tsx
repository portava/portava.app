/**
 * LayoverAnswerChangesCard — census-layover L190: the client caller of
 *   GET /api/airport/sessions/:id/decisions/diff?from=<snapshotId>&to=<snapshotId>
 * ("what changed since the last answer").
 *
 * The REAL card over the REAL service (`services/layover.ts`) and the REAL device
 * memory (`lib/layoverAnswerMemory.ts`, over jest's AsyncStorage mock): only
 * `fetch` and the token helper stand in. Server bodies are shaped exactly as
 * routes/airport.ts writes them (`{ featureEnabled, state: "stored", diff, changes }`).
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *   - a request when the answer on screen was not stored (production today);
 *   - comparing against anything but the answer last ACKNOWLEDGED (from) and the
 *     answer on screen (to);
 *   - moving the remembered answer before "Got it", or after a failed read;
 *   - drawing a card for an empty change list, or drawing nothing for a failure;
 *   - printing a value the server did not send.
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverAnswerChangesCard } from '../LayoverAnswerChangesCard.tsx';
import { answerSeenKey, readAnswerSeen } from '../../../lib/layoverAnswerMemory.ts';

// NOTE: intentional stub — the real helper reads a Supabase session through the
// native SecureStore adapter; a fixed token lets this suite assert the Bearer header.
jest.mock('../../../services/apiToken', () => ({ freshToken: jest.fn(async () => 'test-token') }));

const A = 'snap:' + 'a1'.repeat(16);
const B = 'snap:' + 'b2'.repeat(16);
const C = 'snap:' + 'c3'.repeat(16);

type Answer = { status: number; body?: unknown; reject?: boolean };
let answers: Answer[] = [];
let calls: Array<{ url: string; init: any }> = [];

beforeEach(async () => {
  await AsyncStorage.clear();
  answers = [];
  calls = [];
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('test: no server answer queued');
    if (next.reject) throw new TypeError('Network request failed');
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  });
});

async function remember(id: string) {
  await AsyncStorage.setItem(answerSeenKey('sess-1'), JSON.stringify({ snapshotId: id }));
}

async function mount(over: Partial<React.ComponentProps<typeof LayoverAnswerChangesCard>> = {}) {
  return await render(
    <LayoverAnswerChangesCard sessionId="sess-1" snapshotId={B} persisted={{ state: 'recorded' }} timezone="UTC" {...over} />,
  );
}

function stored(changes: unknown[], diff: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      featureEnabled: true,
      state: 'stored',
      diff: { previousSnapshotId: A, nextSnapshotId: B, changed: [], reasonCodesAdded: [], reasonCodesRemoved: [], materiallyChanged: true, ...diff },
      changes,
    },
  };
}

const EARLIER = [
  { field: 'verdict', previous: 'yes', next: 'tight' },
  { field: 'hardReturnTime', previous: '2026-09-13T14:05:00.000Z', next: '2026-09-13T13:48:00.000Z', minutesMoved: -17 },
];

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('L190 — drawn and asked only over a STORED answer', () => {
  it('production today (persisted: not_stored): no card, no request, nothing remembered', async () => {
    await remember(A);
    await mount({ persisted: { state: 'not_stored', reason: 'persistence_disabled' } });
    await flush();
    expect(screen.queryByTestId('layover-answer-changes-card')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await readAnswerSeen('sess-1')).toBe(A);
  });

  it('no usable snapshot id: no request', async () => {
    await remember(A);
    await mount({ snapshotId: 'snap:not-hex' });
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('the first stored answer on this device: nothing to compare, no request, and it becomes the remembered answer', async () => {
    await mount();
    await waitFor(async () => expect(await readAnswerSeen('sess-1')).toBe(B));
    expect(calls).toHaveLength(0);
    expect(screen.queryByTestId('layover-answer-changes-card')).toBeNull();
  });

  it('the answer on screen IS the remembered one: no request', async () => {
    await remember(B);
    await mount();
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe('L190 — what changed since the acknowledged answer', () => {
  it('asks the server from the ACKNOWLEDGED answer to the one on screen, with the Bearer token, and says each change it sent', async () => {
    await remember(A);
    answers.push(stored(EARLIER, { reasonCodesAdded: ['TRAFFIC_DEGRADED'] }));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-card')).toBeTruthy());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/airport/sessions/sess-1/decisions/diff?from=${encodeURIComponent(A)}&to=${encodeURIComponent(B)}`);
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');

    const line0 = String(screen.getByTestId('layover-answer-change-0').props.children.join(''));
    expect(line0).toMatch(/Tight — stay close \(was Yes — you have time\)/);
    const line1 = String(screen.getByTestId('layover-answer-change-1').props.children.join(''));
    expect(line1).toMatch(/13:48|1:48/);
    expect(line1).toMatch(/14:05|2:05/);
    expect(line1).toMatch(/17 min earlier/);
    expect(String(screen.getByTestId('layover-answer-change-2').props.children.join(''))).toMatch(/^• New: /);
  });

  it('the remembered answer moves ONLY on "Got it"', async () => {
    await remember(A);
    answers.push(stored(EARLIER));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-card')).toBeTruthy());
    expect(await readAnswerSeen('sess-1')).toBe(A);

    await fireEvent.press(screen.getByTestId('layover-answer-changes-ack'));
    await waitFor(() => expect(screen.queryByTestId('layover-answer-changes-card')).toBeNull());
    expect(await readAnswerSeen('sess-1')).toBe(B);
  });

  it('changes ACCUMULATE: a newer answer before "Got it" is compared with the acknowledged one, not the one in between', async () => {
    await remember(A);
    answers.push(stored(EARLIER));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-card')).toBeTruthy());

    answers.push(stored(EARLIER, { nextSnapshotId: C }));
    await screen.rerender(<LayoverAnswerChangesCard sessionId="sess-1" snapshotId={C} persisted={{ state: 'already_recorded' }} timezone="UTC" />);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].url).toBe(`/api/airport/sessions/sess-1/decisions/diff?from=${encodeURIComponent(A)}&to=${encodeURIComponent(C)}`);
  });

  it('an EMPTY change list (the clock only): no card, and the answer on screen becomes the remembered one', async () => {
    await remember(A);
    answers.push(stored([]));
    await mount();
    await waitFor(async () => expect(await readAnswerSeen('sess-1')).toBe(B));
    expect(screen.queryByTestId('layover-answer-changes-card')).toBeNull();
  });

  it('a cleared reason code alone is still news', async () => {
    await remember(A);
    answers.push(stored([], { reasonCodesRemoved: ['RETURN_THRESHOLD_REACHED'] }));
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-card')).toBeTruthy());
    expect(String(screen.getByTestId('layover-answer-change-0').props.children.join(''))).toMatch(/^• No longer: /);
  });
});

describe('L190 — every refusal is said, and none moves the remembered answer silently', () => {
  it('an unreadable ledger (503): says it could not check, offers to check again, and remembers nothing new', async () => {
    await remember(A);
    answers.push({ status: 503, body: { error: 'degraded_unavailable', message: "Your layover's decision history could not be read. Please try again." } });
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-cannot_check')).toBeTruthy());
    expect(screen.getByText(/could not check what changed since your last answer/)).toBeTruthy();
    expect(await readAnswerSeen('sess-1')).toBe(A);

    answers.push(stored(EARLIER));
    await fireEvent.press(screen.getByTestId('layover-answer-changes-retry'));
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-card')).toBeTruthy());
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain(`from=${encodeURIComponent(A)}`);
  });

  it('no network: the same "could not check", never "nothing changed"', async () => {
    await remember(A);
    answers.push({ status: 0, reject: true });
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-cannot_check')).toBeTruthy());
    expect(await readAnswerSeen('sess-1')).toBe(A);
  });

  it('the earlier answer is no longer kept (404): said, and "Got it" re-anchors on the answer on screen', async () => {
    await remember(A);
    answers.push({ status: 404, body: { error: 'not_found', message: 'Snapshot not found' } });
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-earlier-gone')).toBeTruthy());
    expect(await readAnswerSeen('sess-1')).toBe(A);
    await fireEvent.press(screen.getByTestId('layover-answer-changes-ack'));
    await waitFor(async () => expect(await readAnswerSeen('sess-1')).toBe(B));
  });

  it('the ledger switched off between the overview and the call (not_stored): said, remembered answer kept', async () => {
    await remember(A);
    answers.push({ status: 200, body: { featureEnabled: true, state: 'not_stored', reason: 'persistence_disabled' } });
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-not_stored')).toBeTruthy());
    expect(await readAnswerSeen('sess-1')).toBe(A);
  });

  it('a body this build cannot read (no `changes`) is a failure, never an empty card', async () => {
    await remember(A);
    answers.push({ status: 200, body: { featureEnabled: true, state: 'stored', diff: { previousSnapshotId: A, nextSnapshotId: B } } });
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-answer-changes-cannot_check')).toBeTruthy());
    expect(await readAnswerSeen('sess-1')).toBe(A);
  });
});
