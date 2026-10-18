/**
 * LayoverDecisionRecordCard — census-layover L189 / L191: the client caller of
 *   GET /api/airport/sessions/:id/decisions/:snapshotId/explain   (explain)
 *   GET /api/airport/sessions/:id/decisions/replay?engineVersion= (replay)
 *
 * The REAL card over the REAL service (`services/layover.ts`): only `fetch` and
 * the token helper stand in, so every case pins the wire — URL, method, Bearer —
 * as well as the screen. Server bodies are shaped exactly as routes/airport.ts
 * writes them.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *   - the card drawn over an answer the ledger did NOT store (production today);
 *   - a call that names a snapshot other than the one on screen, or no engine;
 *   - a named refusal (feature_disabled / flag_unreadable / storage_unavailable)
 *     rendered as an explanation, a count, or nothing at all;
 *   - a stored answer that does not reproduce rendered as explained;
 *   - a replay summary re-counted on the client instead of said as sent.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverDecisionRecordCard } from '../LayoverDecisionRecordCard.tsx';

// NOTE: intentional stub — the real helper reads a Supabase session through the
// native SecureStore adapter; a fixed token lets this suite assert the Bearer header.
jest.mock('../../../services/apiToken', () => ({ freshToken: jest.fn(async () => 'test-token') }));

const SNAP = 'snap:' + 'a1'.repeat(16);
const SNAP2 = 'snap:' + 'b2'.repeat(16);
const ENGINE = '2026.09.22-1';

type Answer = { status: number; body?: unknown; reject?: boolean };
let answers: Answer[] = [];
let calls: Array<{ url: string; init: any }> = [];

beforeEach(() => {
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

function mount(over: Partial<React.ComponentProps<typeof LayoverDecisionRecordCard>> = {}) {
  return render(
    <LayoverDecisionRecordCard
      sessionId="sess-1"
      snapshotId={SNAP}
      persisted={{ state: 'recorded' }}
      engineVersion={ENGINE}
      timezone="UTC"
      {...over}
    />,
  );
}

const EXPLAINED = {
  featureEnabled: true,
  state: 'explained',
  explanation: {
    snapshotId: SNAP, sessionId: 'sess-1',
    decision: {
      sessionId: 'sess-1', snapshotId: SNAP, engineVersion: ENGINE, inputHash: 'sha256:x', computedAt: '2026-09-08T10:00:00.000Z',
      inputFacts: [], sourceRefs: [], rulesApplied: ['buffer.base.international'], reasonCodes: ['WINDOW_TIGHT'],
      result: { verdict: 'tight', hardReturnTime: '2026-09-08T13:40:00.000Z', usableMinutes: 254 },
    },
    reasons: ['About 4h 14m of usable time after exit and return buffers.'],
    unknowns: ['Live queue times at immigration'],
    disclaimer: 'Estimates only.',
    breakdown: { totalBuffer: 176 }, bufferPercentile: 'p90',
    verifiedBy: 'replay_match',
  },
};

describe('L189 / L191 — drawn only over an answer the ledger STORED', () => {
  it('production today (persisted: not_stored / persistence_disabled): no card, no request', async () => {
    await mount({ persisted: { state: 'not_stored', reason: 'persistence_disabled' } });
    expect(screen.queryByTestId('layover-decision-record-card')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('no `persisted` (an older server) or no usable snapshot id: no card', async () => {
    await mount({ persisted: null });
    expect(screen.queryByTestId('layover-decision-record-card')).toBeNull();
    await mount({ snapshotId: 'snap:not-hex' });
    expect(screen.queryByTestId('layover-decision-record-card')).toBeNull();
    await mount({ snapshotId: null, persisted: { state: 'already_recorded' } });
    expect(screen.queryByTestId('layover-decision-record-card')).toBeNull();
  });

  it('stored (`recorded` or `already_recorded`): the card offers both checks (anti-vacuity for the two above)', async () => {
    await mount({ persisted: { state: 'already_recorded' } });
    expect(screen.getByTestId('layover-decision-explain')).toBeTruthy();
    expect(screen.getByTestId('layover-decision-replay')).toBeTruthy();
  });
});

describe('L189 — explain the stored answer on screen', () => {
  it('asks for THIS snapshot of THIS session with the Bearer token, and shows the server\'s checked explanation', async () => {
    answers.push({ status: 200, body: EXPLAINED });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-decision-explain'));
    await waitFor(() => expect(screen.getByTestId('layover-decision-explanation')).toBeTruthy());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/airport/sessions/sess-1/decisions/${encodeURIComponent(SNAP)}/explain`);
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');

    expect(screen.getByTestId('layover-decision-verified').props.children).toMatch(/comes out exactly the same/);
    expect(screen.getByText('• About 4h 14m of usable time after exit and return buffers.')).toBeTruthy();
    expect(screen.getByText('• Live queue times at immigration')).toBeTruthy();
    expect(screen.getByText('Estimates only.')).toBeTruthy();
    const deadline = screen.getByTestId('layover-decision-stored-deadline');
    expect(JSON.stringify(deadline.props.children)).toMatch(/13:40|1:40/);
  });

  for (const [reason, retryable, words] of [
    ['feature_disabled', false, /not keeping a record of its answers right now/],
    ['flag_unreadable', true, /could not tell whether its record is switched on, so nothing was read/],
    ['storage_unavailable', false, /not set up on this server/],
  ] as const) {
    it(`a NAMED refusal, ${reason}, is said in words — never an explanation`, async () => {
      answers.push({ status: 200, body: { featureEnabled: true, state: 'unavailable', reason, retryable } });
      await mount();
      await fireEvent.press(screen.getByTestId('layover-decision-explain'));
      await waitFor(() => expect(screen.getByTestId('layover-decision-explain-unavailable')).toBeTruthy());
      expect(screen.getByText(words)).toBeTruthy();
      expect(screen.queryByTestId('layover-decision-explanation')).toBeNull();
    });
  }

  it('a stored answer that does not reproduce is said to be one, with the field the server named — not explained', async () => {
    answers.push({ status: 200, body: { featureEnabled: true, state: 'not_explained', reason: 'replay_mismatch', detail: ['hard_return_time'] } });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-decision-explain'));
    await waitFor(() => expect(screen.getByTestId('layover-decision-explain-not_explained')).toBeTruthy());
    expect(screen.getByText(/will not explain this stored answer.*\(hard_return_time\)/)).toBeTruthy();
    expect(screen.queryByTestId('layover-decision-explanation')).toBeNull();
  });

  it('404 → no stored record; 503 → the server\'s sentence; no signal → nothing was checked', async () => {
    answers.push({ status: 404, body: { error: 'not_found', message: 'Snapshot not found' } });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-decision-explain'));
    await waitFor(() => expect(screen.getByText('Portava has no stored record of this answer.')).toBeTruthy());

    answers.push({ status: 503, body: { error: 'degraded_unavailable', message: "Your layover's decision history could not be read. Please try again.", retryable: true } });
    await fireEvent.press(screen.getByTestId('layover-decision-explain'));
    await waitFor(() => expect(screen.getByText("Your layover's decision history could not be read. Please try again.")).toBeTruthy());

    answers.push({ status: 0, reject: true });
    await fireEvent.press(screen.getByTestId('layover-decision-explain'));
    await waitFor(() => expect(screen.getByText('Could not reach Portava. Nothing was checked.')).toBeTruthy());
  });

  it('a new answer on screen (new snapshot) clears what was said about the old one', async () => {
    answers.push({ status: 200, body: EXPLAINED });
    const view = await mount();
    await fireEvent.press(screen.getByTestId('layover-decision-explain'));
    await waitFor(() => expect(screen.getByTestId('layover-decision-explanation')).toBeTruthy());
    await view.rerender(
      <LayoverDecisionRecordCard sessionId="sess-1" snapshotId={SNAP2} persisted={{ state: 'recorded' }} engineVersion={ENGINE} timezone="UTC" />,
    );
    await waitFor(() => expect(screen.queryByTestId('layover-decision-explanation')).toBeNull());
  });
});

describe('L191 — re-check every stored answer of this layover', () => {
  it('asks under the engine that made the answer on screen, and says the server\'s counts as sent', async () => {
    answers.push({
      status: 200,
      body: {
        featureEnabled: true, state: 'replayed', engineVersion: ENGINE, truncated: true,
        summary: {
          read: 4, replayed: 3, matched: 2, mismatched: 1, refused: 1, refusalsByReason: { INPUTS_UNUSABLE: 1 }, mismatchRate: 0.33,
          results: [],
        },
      },
    });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-decision-replay'));
    await waitFor(() => expect(screen.getByTestId('layover-decision-replay-summary')).toBeTruthy());

    expect(calls[0].url).toBe(`/api/airport/sessions/sess-1/decisions/replay?engineVersion=${encodeURIComponent(ENGINE)}`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');
    expect(screen.getByText('Portava re-ran 4 stored answers for this layover: 2 came out exactly as stored.')).toBeTruthy();
    expect(screen.getByText('1 did not — re-run from the facts it was given, it comes out differently.')).toBeTruthy();
    expect(screen.getByText('1 could not be re-run here (made by different rules).')).toBeTruthy();
    expect(screen.getByText('Only the newest 4 were checked.')).toBeTruthy();
  });

  it('an engine this server does not run is said, with the one it does', async () => {
    answers.push({ status: 200, body: { featureEnabled: true, state: 'not_replayed', reason: 'engine_version_not_running', runningEngineVersion: '2026.10.01-1' } });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-decision-replay'));
    await waitFor(() => expect(screen.getByTestId('layover-decision-replay-not_replayed')).toBeTruthy());
    expect(screen.getByText(/different version of Portava's engine \(this server runs 2026\.10\.01-1\)/)).toBeTruthy();
  });

  it('a NAMED refusal (flag_unreadable) is said — never an all-clear count', async () => {
    answers.push({ status: 200, body: { featureEnabled: true, state: 'unavailable', reason: 'flag_unreadable', retryable: true } });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-decision-replay'));
    await waitFor(() => expect(screen.getByTestId('layover-decision-replay-unavailable')).toBeTruthy());
    expect(screen.queryByText(/came out exactly/)).toBeNull();
  });

  it('no engine version on the answer: the re-check is not offered', async () => {
    await mount({ engineVersion: null });
    expect(screen.getByTestId('layover-decision-explain')).toBeTruthy();
    expect(screen.queryByTestId('layover-decision-replay')).toBeNull();
  });
});
