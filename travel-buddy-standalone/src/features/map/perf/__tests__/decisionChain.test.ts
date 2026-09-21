/**
 * The M292 capture-and-assert tooling, tested (census-map M292, and M275's
 * outcome loop in the same shape).
 *
 * This proves the ASSERTION, not the walk. No physical handset was available
 * (plan blocker B4), so no telemetry stream has been captured from a real
 * 10:47 PM walk and M292 is NOT measured. See
 * docs/map/device-measurement-protocol.md §M292.
 *
 * The rows below are the shape of `public.map_telemetry_events` as
 * `2202_map_telemetry.sql` defines it, constructed in this file. They are not
 * evidence that the emitters write them.
 *
 * Run: npm test  (in travel-buddy-standalone)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DECISION_CHAIN,
  chainCandidates,
  formatChainVerdict,
  gradeDecisionChain,
  type TelemetryRow,
} from '../decisionChain.ts';

const SESSION = 'mse_01H0000000000000000000';
const DECISION = 'dec_01H1111111111111111111';

let seq = 0;
function ev(
  event_name: string,
  over: Partial<TelemetryRow> = {},
): TelemetryRow {
  seq += 1;
  return {
    event_name,
    map_session_id: SESSION,
    seq,
    client_ts: new Date(Date.UTC(2026, 8, 20, 22, 47, 0, seq)).toISOString(),
    synthesized_session: false,
    payload: { decisionId: DECISION },
    ...over,
  };
}

/** The §38 walk, in order, all five on one decisionId. */
function completeWalk(): TelemetryRow[] {
  seq = 0;
  return DECISION_CHAIN.map((name) => ev(name));
}

describe('§38 — the pass condition', () => {
  it('passes when one decisionId walks all five events in order', () => {
    const verdict = gradeDecisionChain(completeWalk());
    assert.equal(verdict.pass, true);
    assert.equal(verdict.complete.length, 1);
    assert.equal(verdict.complete[0].decisionId, DECISION);
    assert.match(formatChainVerdict(verdict), /^PASS/);
  });

  it('ignores unrelated events that happened during the same session', () => {
    seq = 0;
    const rows = [
      ev('map_opened', { payload: null }),
      ...DECISION_CHAIN.map((name) => ev(name)),
      ev('zone_selected', { payload: null }),
      ev('why_shown_opened', { payload: null }),
    ];
    assert.equal(gradeDecisionChain(rows).pass, true);
  });
});

describe('§38 — the ways a walk fails, each named', () => {
  it('fails when one link is missing, and says which', () => {
    seq = 0;
    const rows = DECISION_CHAIN.filter((e) => e !== 'route_started').map((name) => ev(name));
    const verdict = gradeDecisionChain(rows);
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.partial[0].missing, ['route_started']);
    assert.match(formatChainVerdict(verdict), /route_started/);
  });

  it('fails when the five events are split across two decisionIds', () => {
    // Five events that share nothing are five events, not a decision loop.
    seq = 0;
    const rows = [
      ev('compass_requested', { payload: { decisionId: 'dec_a' } }),
      ev('compass_option_selected', { payload: { decisionId: 'dec_a' } }),
      ev('recommendation_accepted', { payload: { decisionId: 'dec_b' } }),
      ev('route_started', { payload: { decisionId: 'dec_b' } }),
      ev('contribution_submitted', { payload: { decisionId: 'dec_b' } }),
    ];
    assert.equal(gradeDecisionChain(rows).pass, false);
  });

  it('fails when all five are present but out of order', () => {
    // A contribution_submitted that preceded the compass_requested it is
    // supposed to be an outcome of is not an outcome loop.
    seq = 0;
    const reversed = [...DECISION_CHAIN].reverse().map((name) => ev(name));
    const verdict = gradeDecisionChain(reversed);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.outOfOrder.length, 1);
    assert.equal(verdict.partial.length, 0, 'nothing is missing — the ORDER is the defect');
  });

  it('orders by seq even when every event shares one millisecond', () => {
    // Two taps in the same millisecond are ordinary. `seq` is the emitter's own
    // monotonic counter and is the authority.
    const rows = DECISION_CHAIN.map((name, i) => ({
      event_name: name,
      map_session_id: SESSION,
      seq: i + 1,
      client_ts: new Date(Date.UTC(2026, 8, 20, 22, 47, 0, 0)).toISOString(),
      synthesized_session: false,
      payload: { decisionId: DECISION },
    }));
    assert.equal(gradeDecisionChain(rows).pass, true);
  });

  it('orders by seq even when the device clock stepped BACKWARDS mid-walk', () => {
    /*
     * Added after mutation I5 survived. In the case above every `client_ts` is
     * identical, so the two orderings agree and the `seq` branch could be
     * deleted with the suite green. Here they DISAGREE: `seq` is correct and
     * the timestamps run backwards, which is what an NTP correction or a
     * timezone change during the walk produces on a real handset.
     *
     * A harness that trusted the wall clock would read §38's walk as five
     * events in reverse and report the outcome loop as broken — failing a row
     * for a reason that has nothing to do with the product.
     */
    const rows = DECISION_CHAIN.map((name, i) => ({
      event_name: name,
      map_session_id: SESSION,
      seq: i + 1,
      client_ts: new Date(Date.UTC(2026, 8, 20, 22, 47, 0, 0) - i * 1000).toISOString(),
      synthesized_session: false,
      payload: { decisionId: DECISION },
    }));
    const verdict = gradeDecisionChain(rows);
    assert.equal(verdict.pass, true, 'seq must outrank a clock that went backwards');
    assert.deepEqual(verdict.complete[0].observed, [...DECISION_CHAIN]);
  });

  it('falls back to client_ts only when seq is absent', () => {
    // Anti-vacuity for the two above: the fallback must be a real fallback, not
    // dead code. Rows with no `seq` are ordered by their timestamps.
    const reversed = [...DECISION_CHAIN].reverse();
    const rows = reversed.map((name, i) => ({
      event_name: name,
      map_session_id: SESSION,
      seq: null,
      // The reversed list carries DESCENDING timestamps, so sorting by them
      // restores §38's order.
      client_ts: new Date(
        Date.UTC(2026, 8, 20, 22, 47, 0, 0) + (reversed.length - i) * 1000,
      ).toISOString(),
      synthesized_session: false,
      payload: { decisionId: DECISION },
    }));
    assert.equal(gradeDecisionChain(rows).pass, true);
  });

  it('fails when the chain crosses two map sessions', () => {
    seq = 0;
    const rows = DECISION_CHAIN.map((name, i) =>
      ev(name, { map_session_id: i < 2 ? SESSION : 'mse_other' }),
    );
    const verdict = gradeDecisionChain(rows);
    assert.equal(verdict.pass, false);
    assert.equal(chainCandidates(rows)[0].crossSession, true);
  });

  it('excludes synthesised-session strays and counts them', () => {
    // 2202_map_telemetry.sql: these fired before any map_opened, and "analysis
    // must exclude these from session funnels rather than counting a stray as a
    // real map visit". A chain assembled from strays is not a walk.
    seq = 0;
    const rows = DECISION_CHAIN.map((name, i) =>
      ev(name, { synthesized_session: i === 4 }),
    );
    const verdict = gradeDecisionChain(rows);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.synthesizedRowsExcluded, 1);
    assert.deepEqual(verdict.partial[0].missing, ['contribution_submitted']);
  });

  it('counts chain rows that carried no decisionId, so a lost correlation is visible', () => {
    // The difference between "the user never finished" and "the id was dropped"
    // is the whole diagnosis, and both look like a missing row otherwise.
    seq = 0;
    const rows = DECISION_CHAIN.map((name, i) => ev(name, i === 3 ? { payload: {} } : {}));
    const verdict = gradeDecisionChain(rows);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.rowsWithoutDecisionId, 1);
    assert.match(formatChainVerdict(verdict), /1 rows without a decisionId/);
  });
});

describe('anti-vacuity — an empty or broken stream is a FAIL', () => {
  it('fails on an empty stream', () => {
    // A device run that produced no telemetry at all is the most likely way
    // for this row to "pass" with nothing having happened: no decisionId was
    // broken, because there was none.
    const verdict = gradeDecisionChain([]);
    assert.equal(verdict.pass, false);
    assert.match(formatChainVerdict(verdict), /no chain event carried a decisionId/);
  });

  it('fails on rows with no decisionId at all', () => {
    seq = 0;
    assert.equal(
      gradeDecisionChain(DECISION_CHAIN.map((n) => ev(n, { payload: null }))).pass,
      false,
    );
  });

  it('survives malformed rows without throwing', () => {
    const junk = [
      null,
      undefined,
      {},
      { event_name: 42 },
      { event_name: 'route_started' },
    ] as unknown as TelemetryRow[];
    assert.equal(gradeDecisionChain(junk).pass, false);
    assert.equal(gradeDecisionChain(undefined as never).pass, false);
  });

  it('refuses a decisionId that is not a non-empty string', () => {
    seq = 0;
    for (const bad of [null, '', 0, true, {}]) {
      const rows = DECISION_CHAIN.map((n) => ev(n, { payload: { decisionId: bad } }));
      assert.equal(gradeDecisionChain(rows).pass, false, `decisionId ${JSON.stringify(bad)}`);
    }
  });
});
