/**
 * MapSearchSheet — a server REFUSAL is not "Nothing matched".
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `GET /discovery/search` — the endpoint this sheet calls, twice, on every
 * query — gained a refusal envelope on 2026-09-14. It answers an internal
 * failure with HTTP **200** and a `refusal` key naming what broke
 * (`routes/discoverySearch.ts`, `transient_db` / `search_failed` and
 * `transient_db` / `visibility_state_unreadable`). The client service parses it
 * and hands it back on the SUCCESS arm, deliberately:
 * `services/discovery.ts` returns `{ ok: true, data }` with `data.refusal` set,
 * because the request really did succeed — the ANSWER is "we did not look".
 *
 * This sheet branches on `res.ok` alone. So a refused search arrives as
 * `ok: true` with `results: []`, and the sheet renders
 *
 *     Nothing matched "kopitiam".
 *
 * which is a SETTLED answer to a RETRYABLE failure, and is the exact sentence
 * the owner ruling quoted at the top of `services/discovery.ts` forbids:
 *
 *   "A distinguishable response body alone is insufficient if consumers still
 *    treat it as successful empty data."
 *
 * WHAT IS ASSERTED, and why each one is separate
 * ==============================================
 *  (1) TOTAL REFUSAL of the `all` lane must not read as an empty result set.
 *      The failure mode is a person retyping a query that was never run.
 *  (2) A `coverage: "partial"` body keeps its real results — those items WERE
 *      served — and still says the answer is incomplete. Discarding them would
 *      be the opposite defect, and a fix that only handled (1) could pass by
 *      blanking everything.
 *  (3) The SAVED lane refusing must not silently vanish. §27's ninth heading is
 *      viewer-scoped and is fetched separately; "we did not read your saves"
 *      and "none of your saves matched" are different facts and the sheet shows
 *      only one of them today.
 *  (4) A genuinely empty result set must STILL say "Nothing matched". Without
 *      this, a fix that shows the refusal notice unconditionally passes (1)-(3)
 *      while destroying the empty state.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

const mockSearchUnified = jest.fn();

// NOTE: intentionally exhaustive — the real module imports the Supabase client,
// and spreading requireActual loads it and OOMs the Jest runner. `searchUnified`
// is the only export this component uses.
jest.mock('../../../services/discovery', () => ({
  searchUnified: (...args: unknown[]) => mockSearchUnified(...args),
}));

// NOTE: intentionally exhaustive — the real hook reads native safe-area insets,
// which do not exist under the test renderer.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { MapSearchSheet } from '../MapSearchSheet.tsx';

/** A refusal envelope exactly as `parseRefusal` returns one. */
function refusal(coverage: 'nothing' | 'partial') {
  return {
    class: 'transient_db',
    code: 'search_failed',
    route: 'GET /discovery/search',
    coverage,
  };
}

/** One §27 place result, shaped as the unified wire returns it. */
function placeHit(id: string, title: string) {
  return {
    id,
    type: 'places',
    title,
    subtitle: null,
    imageUrl: null,
    route: `/place/${id}`,
    metadata: { lat: 1.3, lng: 103.8 },
  };
}

/**
 * One §27 SAVED result, as `searchSaved` emits it. `savedKind` is stated by the
 * server rather than inferred by the adapter, so the fixture states it too.
 */
function savedHit(id: string, title: string) {
  return {
    id,
    type: 'saved',
    title,
    subtitle: null,
    imageUrl: null,
    route: `/place/${id}`,
    metadata: { savedKind: 'place', lat: 1.3, lng: 103.8 },
  };
}

function envelope(results: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: { results, total: results.length, query: 'kopitiam', type: 'all', timeLabel: null, ...extra },
  };
}

/** Mount, type a query, and let the 300 ms debounce fire. */
async function search(): Promise<void> {
  await render(
    <MapSearchSheet visible lat={1.3} lng={103.8} city="Singapore" onClose={() => {}} onSelect={() => {}} />,
  );
  const input = screen.getByLabelText('Search the map');
  await act(async () => {
    input.props.onChangeText('kopitiam');
  });
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSearchUnified.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('MapSearchSheet — refusals', () => {
  it('(1) a REFUSED search is never reported as "Nothing matched"', async () => {
    // Both lanes refuse outright: the server did not search.
    mockSearchUnified.mockResolvedValue(envelope([], { refusal: refusal('nothing') }));

    await search();

    await waitFor(() => {
      expect(screen.queryByText(/Nothing matched/i)).toBeNull();
    });
    // And it must SAY something, rather than leaving a blank sheet — a blank
    // sheet is the same lie with fewer words.
    expect(screen.getByText(/couldn’t be run|could not be run/i)).toBeTruthy();
  });

  it('(2) a PARTIAL refusal keeps the results it did serve and still says so', async () => {
    mockSearchUnified.mockResolvedValue(
      envelope([placeHit('p1', 'Kopitiam Ang Mo Kio')], { refusal: refusal('partial') }),
    );

    await search();

    await waitFor(() => {
      expect(screen.getByText('Kopitiam Ang Mo Kio')).toBeTruthy();
    });
    expect(screen.getByText(/incomplete/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing matched/i)).toBeNull();
  });

  it('(3) the SAVED lane refusing is said out loud, not swallowed', async () => {
    mockSearchUnified.mockImplementation((_q: string, type: string) =>
      Promise.resolve(
        type === 'saved'
          ? envelope([], { refusal: refusal('nothing') })
          : envelope([placeHit('p2', 'Kopitiam Tiong Bahru')]),
      ),
    );

    await search();

    // The eight public headings still answer — that part is an owner decision
    // recorded in the sheet and is not being reversed here.
    await waitFor(() => {
      expect(screen.getByText('Kopitiam Tiong Bahru')).toBeTruthy();
    });
    expect(screen.getByText(/saved items/i)).toBeTruthy();
  });

  /**
   * (3b) THE SAVED LANE CAN ALSO BE HALF-READ, and that used to be invisible.
   *
   * Saves live in TWO tables — `wishlist_places` and `discovery_place_saves` —
   * written by paths that never write each other's. One can fail while the
   * other answers, and the server now says so with `coverage: "partial"` and
   * `failedSources` rather than serving the survivor's rows under a plain 200.
   *
   * This sheet used to compute `savedFailed` as `coverage === 'nothing'` ONLY,
   * so a partial saved shelf took the healthy branch: the short list rendered
   * with no notice at all, under a heading whose contents the person knows for
   * a fact, because the contents are their own saves. Case (3) does not cover
   * it — its fixture refuses the saved lane outright — so a sheet that ignored
   * `partial` passed (1)-(6) with the defect intact.
   */
  it('(3b) a PARTIAL saved shelf keeps its rows AND says the list may be short', async () => {
    mockSearchUnified.mockImplementation((_q: string, type: string) =>
      Promise.resolve(
        type === 'saved'
          ? envelope([savedHit('s1', 'Kopitiam Katong')], {
              refusal: { ...refusal('partial'), failedSources: ['wishlist_places'] },
            })
          : envelope([placeHit('p7', 'Kopitiam Clementi')]),
      ),
    );

    await search();

    // The rows that WERE read are real and must survive — discarding them is
    // the opposite defect, and is what case (5) forbids for `nothing` bodies.
    await waitFor(() => {
      expect(screen.getByText('Kopitiam Katong')).toBeTruthy();
    });
    expect(screen.getByText('Kopitiam Clementi')).toBeTruthy();
    // And the person is told, in the saved lane's own words rather than the
    // whole-search "incomplete" line, which would misdescribe what happened.
    expect(screen.getByText(/saved items couldn’t be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing matched/i)).toBeNull();
  });

  it('(3c) VACUITY GUARD — a healthy saved shelf says nothing at all', async () => {
    // Without this, "(3b) shows the partial notice" is satisfied by a sheet
    // that shows it on every search, which would make the notice noise and
    // train the person to ignore the one that matters.
    mockSearchUnified.mockImplementation((_q: string, type: string) =>
      Promise.resolve(
        type === 'saved'
          ? envelope([savedHit('s2', 'Kopitiam Bugis')])
          : envelope([placeHit('p8', 'Kopitiam Novena')]),
      ),
    );

    await search();

    await waitFor(() => {
      expect(screen.getByText('Kopitiam Bugis')).toBeTruthy();
    });
    expect(screen.queryByText(/saved items couldn’t be loaded/i)).toBeNull();
    expect(screen.queryByText(/saved items couldn’t be read/i)).toBeNull();
    expect(screen.queryByText(/incomplete/i)).toBeNull();
  });

  it('(4) a genuinely empty answer STILL says "Nothing matched"', async () => {
    mockSearchUnified.mockResolvedValue(envelope([]));

    await search();

    await waitFor(() => {
      expect(screen.getByText(/Nothing matched/i)).toBeTruthy();
    });
  });

  /**
   * (5) and (6) EXIST BECAUSE OF TWO SURVIVING MUTATIONS, and they are written
   * down rather than quietly added.
   *
   * Deleting the two `coverage === 'nothing'` result discards in
   * `MapSearchSheet.run` left cases (1)-(4) green: every fixture above pairs a
   * `coverage: "nothing"` refusal with `results: []`, so discarding an already
   * empty list is unobservable. The fixtures were too well-formed to tell the
   * mutation from the original.
   *
   * WHICH ANSWER IS RIGHT is not a matter of taste. `coverage` is the server's
   * own claim about its own body, and the server acts on that claim: the
   * refusal helper suppresses the serve log for a `coverage: "nothing"`
   * response (`lib/discoveryRefusal.ts` — `logServeUnlessRefused`), so no
   * `rank_events` impression row and no `eligible_impressions` increment exists
   * for anything in it. Rendering items out of such a body would put content on
   * screen that the exposure funnel has no record of serving — the exact
   * corruption D11 names, arriving through the client instead of the server.
   * So `coverage` wins over the payload, and these two cases pin that.
   */
  it('(5) items inside a coverage:"nothing" body are NOT rendered', async () => {
    mockSearchUnified.mockResolvedValue(
      envelope([placeHit('p3', 'Kopitiam Bedok')], { refusal: refusal('nothing') }),
    );

    await search();

    await waitFor(() => {
      expect(screen.getByText(/couldn’t be run|could not be run/i)).toBeTruthy();
    });
    expect(screen.queryByText('Kopitiam Bedok')).toBeNull();
  });

  it('(6) items inside a REFUSED SAVED body are NOT rendered beside real results', async () => {
    mockSearchUnified.mockImplementation((_q: string, type: string) =>
      Promise.resolve(
        type === 'saved'
          ? envelope([placeHit('s1', 'Saved Kopitiam Bugis')], { refusal: refusal('nothing') })
          : envelope([placeHit('p4', 'Kopitiam Novena')]),
      ),
    );

    await search();

    await waitFor(() => {
      expect(screen.getByText('Kopitiam Novena')).toBeTruthy();
    });
    expect(screen.queryByText('Saved Kopitiam Bugis')).toBeNull();
    expect(screen.getByText(/saved items/i)).toBeTruthy();
  });

  /**
   * (7) and (8) EXIST BECAUSE OF A SURVIVING MUTATION I FOUND AFTER the six
   * above were green, and they are written down rather than quietly added.
   *
   * `run` calls `searchUnified(...).catch(() => null)` on BOTH lanes. So there
   * are two ways a lane can fail, not one: it can answer 200 with a refusal
   * envelope (cases 1-6), or it can REJECT — a dropped connection, a JSON parse
   * failure, a thrown adapter — and arrive as `null`. The refusal envelope is
   * the path the endpoint was built for; the rejection is the path that existed
   * before it and still does.
   *
   * Rewriting the saved-lane guard from
   *     !savedRes || !savedRes.ok || savedRes.data.refusal?.coverage === 'nothing'
   * to
   *     savedRes ? (!savedRes.ok || ...) : false
   * left cases (1)-(6) ALL GREEN. Every fixture above resolves; none of them
   * rejects. Under that mutation a saved search that THREW produced no notice
   * at all, and the person read an answer missing its ninth heading as a
   * complete one — which is the same lie this file was opened to stop, reached
   * by the other door.
   */
  it('(7) a saved lane that THREW is reported, not silently dropped', async () => {
    mockSearchUnified.mockImplementation((_q: string, type: string) =>
      type === 'saved'
        ? Promise.reject(new Error('network'))
        : Promise.resolve(envelope([placeHit('p5', 'Kopitiam Clementi')])),
    );

    await search();

    // The eight public headings still answer, exactly as in (3).
    await waitFor(() => {
      expect(screen.getByText('Kopitiam Clementi')).toBeTruthy();
    });
    // And the ninth is named as unread, exactly as in (3). A rejection and a
    // `coverage: "nothing"` body are different transports for one fact.
    expect(screen.getByText(/saved items/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing matched/i)).toBeNull();
  });

  it('(8) an `all` lane that THREW is an error, not "Nothing matched"', async () => {
    mockSearchUnified.mockImplementation((_q: string, type: string) =>
      type === 'saved'
        ? Promise.resolve(envelope([]))
        : Promise.reject(new Error('network')),
    );

    await search();

    // `run` takes the error arm here and clears the notice. What must NOT
    // happen is the empty state: the search did not come back, so nothing is
    // known about whether anything matched.
    await waitFor(() => {
      expect(screen.queryByText(/Nothing matched/i)).toBeNull();
    });
    expect(screen.getByText(/Search failed/i)).toBeTruthy();
  });
});
