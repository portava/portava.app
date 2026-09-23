/**
 * §44/§57 — the DEGRADED serve, recorded (census G373, and the privacy rules of
 * G306/G355/G371 it had to pass first).
 *
 * WHAT WAS MISSING. `lib/inputAssistance/metrics.ts` refuses "offline
 * completion rate" with a precise reason rather than reporting 0: *"nothing
 * marks a serve as degraded — useInputAssistance sets `unavailable` state and
 * emits no event for it, so there is no offline denominator"*. The `unavailable`
 * arm was the only arm of the request that emitted nothing at all, and the
 * degraded case could not be inferred from what WAS logged: a
 * `suggestion_request_started` with no completion is equally an aborted request
 * and an abandoned one.
 *
 * WHAT THESE CASES ASSERT, AND WHY EACH ONE IS A PRIVACY ASSERTION TOO.
 * Migration 2950 carries no account id by design (G371), refuses thirteen
 * raw-text key names (`iate_props_no_raw_text`) and admits only fourteen event
 * names. Every case below therefore checks the SHAPE of what is emitted, not
 * only that something was: the event name must be one 2950 already knows, the
 * props must be a bool and an int, and the typed text must not appear anywhere
 * in the payload — including under a key nobody thought to forbid.
 *
 * MUTATION LOG: see the bottom of this file.
 *
 * Run: npx jest --testPathPattern='degradedTelemetry'
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper (apiToken.ts) at module load, which has no
// native module under jest. `requestSuggestions` is its only export, so this
// factory is complete; a new export would be a deliberate contract change.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));

import { requestSuggestions } from '../../services/inputAssistance.ts';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { clearLocalZeroState } from '../../services/localZeroState.ts';
import { clearRecentSelections } from '../../services/suggestionHistory.ts';
import {
  setTelemetrySink,
  resetTelemetrySink,
  type InputTelemetryEvent,
} from '../../services/inputTelemetry.ts';
import type { InputTelemetryEventName } from '../../types/fieldPolicy.ts';

/**
 * Migration 2950's `iate_event_name_known` CHECK, transcribed. The client side
 * of this vocabulary is a TYPE UNION (`InputTelemetryEventName`) with no
 * runtime array, so the list is written out here and typed as that union —
 * which means a name the union does not have will not compile, and a name the
 * union gains without this list gaining it is caught by the server's own
 * parity check rather than by silence.
 */
const MIGRATION_2950_EVENT_NAMES: readonly InputTelemetryEventName[] = [
  'input_opened',
  'query_length_changed',
  'suggestion_request_started',
  'suggestion_request_completed',
  'suggestion_rendered',
  'suggestion_selected',
  'suggestion_dismissed',
  'raw_search_submitted',
  'manual_value_kept',
  'validation_shown',
  'correction_accepted',
  'disambiguation_selected',
  'action_completed',
  'downstream_task_completed',
];

// ── SEEDED (G340) ───────────────────────────────────────────────────────────
// With nothing fetched every context is CONSERVATIVE (`no_assistance`, an
// unreachable `minChars`), under which the hook makes no request at all and
// every assertion here would be vacuous. The seed states the premise with the
// authority's own offline vocabulary: `country_picker` is `static_dictionary`
// and `place_picker` is `server_required`
// (`lib/inputAssistance/policyRegistry.ts`).
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, {
  country_picker: {
    offlinePolicy: 'static_dictionary',
    entityTypes: ['country'],
    allowedSuggestionTypes: ['entity', 'recent'],
    minChars: 1,
  },
  place_picker: {
    offlinePolicy: 'server_required',
    entityTypes: ['place', 'city'],
    allowedSuggestionTypes: ['entity', 'recent'],
    minChars: 1,
  },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;

const COUNTRY_FIELD = 'test.degtel.country';
const PLACE_FIELD = 'test.degtel.place';

const OFFLINE = { ok: false as const, aborted: false, unavailable: true, error: 'endpoint unavailable' };

let events: InputTelemetryEvent[] = [];
const completions = () => events.filter((e) => e.name === 'suggestion_request_completed');

function Probe({ fieldId, text }: { fieldId: string; text: string }) {
  const { unavailable } = useInputAssistance({ fieldId, text });
  return <Text testID="unavailable">{String(unavailable)}</Text>;
}

beforeEach(() => {
  events = [];
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  clearLocalZeroState();
  clearRecentSelections();
  registerField(COUNTRY_FIELD, 'country_picker', { debounceMs: 0 });
  registerField(PLACE_FIELD, 'place_picker', { debounceMs: 0 });
  setTelemetrySink((e) => { events.push(e); });
});

afterEach(() => {
  resetTelemetrySink();
  unregisterField(COUNTRY_FIELD);
  unregisterField(PLACE_FIELD);
});

test('G373: a degraded serve emits a completion FLAGGED degraded, with the row count', async () => {
  // `country_picker` is `static_dictionary`, so the offline tier answers and
  // the "completion" is real: the field ended up with rows without a server.
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  await waitFor(() => expect(completions()).toHaveLength(1));

  const done = completions()[0]!;
  expect(done.props?.degraded).toBe(true);
  // The numerator of "offline completion rate": this serve DID complete the
  // field, offline, from the shipped dictionary.
  expect(done.props?.count).toBe(1);
});

test('G373: a SERVER_REQUIRED field degrades with a count of ZERO — the denominator without a numerator', async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={PLACE_FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  await waitFor(() => expect(completions()).toHaveLength(1));

  const done = completions()[0]!;
  expect(done.props?.degraded).toBe(true);
  // The §32 gate is untouched: no row is retained for this field, and the event
  // says so rather than the absence being unrecorded.
  expect(done.props?.count).toBe(0);
});

test('G306/G371: the degraded event is METADATA — no text, no identifier, no latency', async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(completions()).toHaveLength(1));
  const done = completions()[0]!;

  // Migration 2950's `iate_props_no_raw_text` refuses these thirteen key names
  // at the database. None is produced here in the first place.
  for (const k of [
    'text', 'query', 'rawText', 'raw_text', 'message',
    'label', 'labels', 'name', 'handle', 'username', 'title', 'body', 'caption',
  ]) {
    expect(done.props).not.toHaveProperty(k);
  }
  // Not under a key nobody forbade, either.
  expect(JSON.stringify(done.props)).not.toContain('thai');
  // Two props, both metadata.
  expect(Object.keys(done.props ?? {}).sort()).toEqual(['count', 'degraded']);

  // NO LATENCY, DELIBERATELY. `metrics.ts` builds G372's P95 from every
  // `suggestion_request_completed` carrying `clientMs`/`serverMs`, and the
  // ingest does not yet know `degraded` — so a degraded row carrying a round
  // trip would arrive indistinguishable from a successful serve and pull the
  // quantile toward failures that never touched a network.
  expect(done.props?.clientMs).toBeUndefined();
  expect(done.props?.serverMs).toBeUndefined();

  // The table stores no account id by construction (G371) and nothing here
  // supplies one.
  expect(JSON.stringify(done)).not.toMatch(/userId|accountId|user_id|viewerId/);
});

test("2950: the event name is one the migration's CHECK already knows — no new name, no migration", async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(completions()).toHaveLength(1));
  // A degraded serve that needed a FIFTEENTH name would need a migration into
  // the reserved 2963-2969 band. This asserts that it does not.
  expect(MIGRATION_2950_EVENT_NAMES).toContain(completions()[0]!.name);
  expect(completions()[0]!.name).toBe('suggestion_request_completed');
});

test('an ONLINE serve is still ONE completion, and it is NOT flagged degraded', async () => {
  mockRequest.mockResolvedValueOnce({
    ok: true,
    requestId: 'req-1',
    policyVersion: 'input-2026-08',
    serverMs: 12,
    suggestions: [
      {
        id: 'srv:th',
        type: 'entity',
        context: 'country_picker',
        label: 'Thailand',
        entityType: 'country',
        entityId: 'th',
        source: 'canonical',
        policyVersion: 'input-2026-08',
      },
    ],
  });
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(completions()).toHaveLength(1));
  const done = completions()[0]!;
  // The two arms must stay tellable apart in BOTH directions, or the "offline"
  // rate is a rate over everything.
  expect(done.props?.degraded).toBeUndefined();
  expect(done.props?.clientMs).toEqual(expect.any(Number));
  expect(done.requestId).toBe('req-1');
});

test('§33: a TRANSIENT error is not a degraded serve, and emits no completion at all', async () => {
  // The distinction the flag exists to preserve. One failed request is not the
  // field being degraded, and counting it as one would inflate the denominator
  // of every offline rate with ordinary 500s.
  mockRequest.mockResolvedValueOnce({ ok: false, aborted: false, unavailable: false, error: 'boom' });
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(events.map((e) => e.name)).toContain('suggestion_request_started'));
  expect(completions()).toHaveLength(0);
});

/*
 * MUTATION LOG — applied to `hooks/useInputAssistance.ts`, run, watched,
 * reverted, `cmp`-verified. Baseline for this file: 6/6.
 *
 * FAILING-FIRST, FIRST: with the `emitInputEvent` call removed from the
 * `unavailable` arm — the shipped state this work replaces — 4 of 6 fail. The
 * two that survive are the ONLINE case and the TRANSIENT case, which is
 * correct: both assert that the degraded arm does NOT fire, and it did not
 * exist to fire.
 *
 *   - delete the `emitInputEvent` call in the `unavailable` arm → 2/6.
 *   - `{ count: degradedRows.length, degraded: true }` → `{ degraded: true }`
 *     → 3/6. Both count assertions go red (the rate loses its numerator) and so
 *       does the key-set assertion in the metadata case.
 *   - `degraded: true` → `degraded: false` → 4/6.
 *   - add `clientMs: Date.now() - sentAt` to the degraded props → 5/6. "The
 *     degraded event is METADATA" goes RED on the key-set and the no-latency
 *     assertions. This is the mutation that guards G372's quantile, and it is
 *     the one a well-meaning later pass is most likely to apply — a degraded
 *     round trip looks like free data until you notice the ingest cannot yet
 *     tell the two rows apart.
 *   - emit the same event from the TRANSIENT-error arm as well → 5/6. "A
 *     TRANSIENT error is not a degraded serve" goes RED. One failed request is
 *     not a degraded field, and counting it as one would inflate every offline
 *     denominator with ordinary 500s.
 *
 * WHAT NO MUTATION HERE CAN REACH, and it is the reason G373 does not move:
 * the ingest's allow-list
 * (`artifacts/api-server/src/lib/inputAssistance/telemetry.ts#TELEMETRY_EVENT_PROPS`)
 * does not name `degraded`, so the flag is DROPPED on the way into the serve
 * log and the stored row cannot be told from an online one. That file is not in
 * this lane's file set, and nothing in the client tree can assert over a key
 * the server declines to write.
 */
