/**
 * Telegraph §10.3 — the end-of-night recap, rendered.
 *
 *   "4 places · 6 people · 18 photos · 2 videos
 *    [ Create Memory ] [ Share Photos ] [ Follow People You Met ] [ Done ]
 *    Recap is derived from confirmed session context and shared content
 *    references. It is an INVITATION TO CURATE, NOT AUTOMATIC HISTORICAL
 *    TRUTH."
 *
 * The counting half is the server's and is asserted in
 * `artifacts/api-server/src/test/telegraphMemory.test.ts`. What this file
 * settles is the surface, and specifically the last sentence, which is not
 * decoration:
 *
 *   - the four actions exist with the spec's labels, in the spec's order;
 *   - mounting the sheet CREATES NOTHING — no action fires without a press;
 *   - a thread with no completed plan is told so, and is NOT shown a recap
 *     assembled out of recent chat;
 *   - a failed read says "we could not put this together", never an empty
 *     night.
 *
 * MODAL RULE 6 (src/components/__tests__/TESTING.md): the sheet is Modal-rooted
 * and does async work, so it lives in its own file with the Proxy Modal mock.
 *
 * SHOWN RED before commit (10 pass green), each mutation reverted:
 *   • `RECAP_CURATE_ACTIONS` trimmed to `['CREATE_MEMORY','DONE']`
 *       -> 1 failed / 9 passed ("offers §10.3's four actions, with the spec's
 *          labels, in the spec's order")
 *   • the `recap === null` branch disabled AND the recap body rendered
 *     whenever the read did not fail — i.e. an empty recap shown for a thread
 *     with no completed plan
 *       -> 1 failed / 9 passed ("a thread with no completed plan is told so,
 *          not given an invented recap")
 *
 * BOTH mutations had to defeat two things at once to land, and both still cost
 * only one test. That is measured, not assumed: the "DONE is an equal-weight
 * outcome" test survived the first mutation because the fixture spreads
 * `RECAP_CURATE_ACTIONS` and DONE stayed in the trimmed list, and the "failed
 * read" test survived the second because `failed` is a separate guard. The
 * redundancy is real; the count is what it is.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react');
        return ({ children, visible }: any) =>
          visible ? R.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: intentional stub — memoryApi reaches lib/supabase, which builds a
// client at import time and fails outside an Expo runtime. Everything the
// sheet itself decides is the real module.
jest.mock('../memory/memoryApi.ts', () => {
  const actual = jest.requireActual('../memory/memoryApi.ts');
  return {
    ...actual,
    fetchRecap: jest.fn(),
    saveMessageAsMemoryDraft: jest.fn(),
  };
});

import { RecapSheet } from '../memory/RecapSheet.tsx';
import { fetchRecap, RECAP_CURATE_ACTIONS, recapHeadline } from '../memory/memoryApi.ts';

const mockedFetchRecap = fetchRecap as jest.MockedFunction<typeof fetchRecap>;

const recapOk = {
  ok: true as const,
  data: {
    recap: {
      threadId: 't1',
      planId: 'p1',
      windowStartsAt: '2026-05-01T18:00:00.000Z',
      windowEndsAt: '2026-05-01T23:30:00.000Z',
      counts: { places: 4, people: 6, photos: 18, videos: 2 },
      sourceMessageIds: ['m1', 'm2'],
      curateActions: [...RECAP_CURATE_ACTIONS],
      invitation: true as const,
      empty: false,
    },
    headline: '4 places · 6 people · 18 photos · 2 videos',
    wrote: 'nothing' as const,
  },
};

const recapNone = {
  ok: true as const,
  data: { recap: null, headline: '', reason: 'no_completed_plan' },
};

beforeEach(() => {
  mockedFetchRecap.mockReset();
});

describe('§10.3 — the recap sheet', () => {
  it("renders the spec's headline for the spec's counts", async () => {
    mockedFetchRecap.mockResolvedValue(recapOk as any);
    await render(<RecapSheet visible threadId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('telegraph-recap-headline')).toBeTruthy());
    expect(screen.getByTestId('telegraph-recap-headline').props.children).toBe(
      '4 places · 6 people · 18 photos · 2 videos',
    );
  });

  it("offers §10.3's four actions, with the spec's labels, in the spec's order", async () => {
    mockedFetchRecap.mockResolvedValue(recapOk as any);
    await render(<RecapSheet visible threadId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('telegraph-recap-action-CREATE_MEMORY')).toBeTruthy());
    expect(RECAP_CURATE_ACTIONS).toEqual([
      'CREATE_MEMORY',
      'SHARE_PHOTOS',
      'FOLLOW_PEOPLE_YOU_MET',
      'DONE',
    ]);
    expect(screen.getByLabelText('Create Memory')).toBeTruthy();
    expect(screen.getByLabelText('Share Photos')).toBeTruthy();
    expect(screen.getByLabelText('Follow People You Met')).toBeTruthy();
    expect(screen.getByLabelText('Done')).toBeTruthy();
  });

  it('is an INVITATION: mounting it curates nothing and says nothing was saved', async () => {
    const onCurate = jest.fn();
    mockedFetchRecap.mockResolvedValue(recapOk as any);
    await render(<RecapSheet visible threadId="t1" onClose={() => {}} onCurate={onCurate} />);
    await waitFor(() => expect(screen.getByTestId('telegraph-recap-headline')).toBeTruthy());
    // Rendering a recap must never be the thing that created the Memory.
    expect(onCurate).not.toHaveBeenCalled();
    expect(screen.getByTestId('telegraph-recap-wrote-nothing')).toBeTruthy();
    expect(screen.getByTestId('telegraph-recap-invitation')).toBeTruthy();
  });

  it('curates only on an explicit press', async () => {
    const onCurate = jest.fn();
    mockedFetchRecap.mockResolvedValue(recapOk as any);
    await render(<RecapSheet visible threadId="t1" onClose={() => {}} onCurate={onCurate} />);
    await waitFor(() => expect(screen.getByTestId('telegraph-recap-action-CREATE_MEMORY')).toBeTruthy());
    fireEvent.press(screen.getByTestId('telegraph-recap-action-CREATE_MEMORY'));
    await waitFor(() => expect(onCurate).toHaveBeenCalledWith('CREATE_MEMORY'));
    expect(onCurate).toHaveBeenCalledTimes(1);
  });

  it('DONE is an equal-weight outcome that closes without curating', async () => {
    const onCurate = jest.fn();
    const onClose = jest.fn();
    mockedFetchRecap.mockResolvedValue(recapOk as any);
    await render(<RecapSheet visible threadId="t1" onClose={onClose} onCurate={onCurate} />);
    await waitFor(() => expect(screen.getByTestId('telegraph-recap-action-DONE')).toBeTruthy());
    fireEvent.press(screen.getByTestId('telegraph-recap-action-DONE'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onCurate).toHaveBeenCalledWith('DONE');
  });

  it('a thread with no completed plan is told so, not given an invented recap', async () => {
    mockedFetchRecap.mockResolvedValue(recapNone as any);
    await render(<RecapSheet visible threadId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('telegraph-recap-none')).toBeTruthy());
    expect(screen.queryByTestId('telegraph-recap-headline')).toBeNull();
    expect(screen.queryByTestId('telegraph-recap-action-CREATE_MEMORY')).toBeNull();
  });

  it('a failed read does not read as an empty night', async () => {
    mockedFetchRecap.mockResolvedValue({ ok: false, error: 'network' } as any);
    await render(<RecapSheet visible threadId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('telegraph-recap-failed')).toBeTruthy());
    expect(screen.queryByTestId('telegraph-recap-headline')).toBeNull();
    expect(screen.queryByTestId('telegraph-recap-none')).toBeNull();
  });

  it('uses the recap it was handed rather than re-reading', async () => {
    await render(
      <RecapSheet visible threadId="t1" onClose={() => {}} initialRecap={recapOk.data as any} />,
    );
    expect(screen.getByTestId('telegraph-recap-headline')).toBeTruthy();
    expect(mockedFetchRecap).not.toHaveBeenCalled();
  });
});

describe('§10.3 — the headline', () => {
  it("renders the spec's example verbatim", () => {
    expect(recapHeadline({ places: 4, people: 6, photos: 18, videos: 2 })).toBe(
      '4 places · 6 people · 18 photos · 2 videos',
    );
  });

  it('omits a zero rather than reporting an absence', () => {
    expect(recapHeadline({ places: 1, people: 2, photos: 0, videos: 0 })).toBe('1 place · 2 people');
  });
});
