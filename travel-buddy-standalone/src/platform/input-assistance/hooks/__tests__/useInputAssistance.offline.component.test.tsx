/**
 * Component test: §32 OFFLINE — the shipped local surface, through the real
 * hook (census G197, G198, G212, G350, G13).
 *
 * WHY A COMPONENT TEST AND NOT ONLY A PURE ONE. The rules are proven directly
 * in services/__tests__/localDictionary.test.ts. What those cannot prove is
 * that the HOOK reaches them with the network down — and "the gate is real and
 * nothing is behind it" is the exact state this layer was built to end. G340
 * made `offlinePolicy` an enforced branch; `static_dictionary` had no
 * substrate, so the branch licensed a surface that returned nothing. These
 * assertions are about that wiring:
 *
 *   1. an offline `country_picker` — empty cache, nothing accepted this
 *      session — RENDERS ROWS, which is the sentence G13 asks for;
 *   2. an offline typed query is answered from the shipped artifact;
 *   3. the rows are marked `local` and resolve nothing (G13's other half);
 *   4. a `server_required` field renders NOTHING offline, still;
 *   5. `display_name` renders nothing and asks nothing, online or off;
 *   6. ONLINE is unchanged — no shipped row leaks into a served answer.
 *
 * MUTATION LOG: see the bottom of this file.
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
import { clearLocalZeroState, recordLocalSelection } from '../../services/localZeroState.ts';
import { clearRecentSelections } from '../../services/suggestionHistory.ts';
import { resolveFieldPolicy } from '../../contexts/fieldRegistry.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

// ── SEEDED (G340) ───────────────────────────────────────────────────────────
// Since G340 every context resolves from the fetched authority, and with
// nothing fetched every context is CONSERVATIVE — `no_assistance`, an
// unreachable `minChars`, `offlinePolicy: 'unavailable'`. Every assertion below
// would then pass vacuously. The seed states the premise, and it states it with
// the REAL registry's offline vocabulary: `country_picker` is
// `static_dictionary` in `lib/inputAssistance/policyRegistry.ts`, `place_picker`
// is `server_required`, `display_name` is `unavailable` with no allowed types
// at all. Seeding them any other way would make these tests agree with
// themselves rather than with the authority.
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, {
  country_picker: {
    offlinePolicy: 'static_dictionary',
    entityTypes: ['country'],
    allowedSuggestionTypes: ['entity', 'recent'],
    minChars: 1,
  },
  language: {
    offlinePolicy: 'static_dictionary',
    entityTypes: ['language'],
    allowedSuggestionTypes: ['entity'],
    minChars: 1,
  },
  city_picker: {
    offlinePolicy: 'cached_local',
    entityTypes: ['city', 'country'],
    allowedSuggestionTypes: ['entity', 'recent'],
    minChars: 1,
  },
  global_search: {
    offlinePolicy: 'cached_local',
    entityTypes: ['city', 'country'],
    allowedSuggestionTypes: ['entity', 'recent', 'completion', 'action'],
    minChars: 2,
  },
  place_picker: {
    offlinePolicy: 'server_required',
    entityTypes: ['place', 'city'],
    allowedSuggestionTypes: ['entity', 'recent'],
    minChars: 1,
  },
  display_name: {
    offlinePolicy: 'unavailable',
    entityTypes: [],
    allowedSuggestionTypes: [],
    minChars: 99,
    maxSuggestions: 0,
    zeroStateAssistance: false,
  },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;

const COUNTRY_FIELD = 'test.offline.country';
const LANGUAGE_FIELD = 'test.offline.language';
const CITY_FIELD = 'test.offline.city';
const SEARCH_FIELD = 'test.offline.search';
const PLACE_FIELD = 'test.offline.place';
const NAME_FIELD = 'test.offline.displayname';

const OFFLINE = { ok: false as const, aborted: false, unavailable: true, error: 'endpoint unavailable' };

function Probe({ fieldId, text }: { fieldId: string; text: string }) {
  const { suggestions, unavailable } = useInputAssistance({ fieldId, text });
  return (
    <>
      <Text testID="labels">{suggestions.map((s) => s.label).join('|')}</Text>
      <Text testID="sources">{suggestions.map((s) => s.source).join('|')}</Text>
      <Text testID="actions">{suggestions.map((s) => s.action?.type ?? '-').join('|')}</Text>
      <Text testID="ids">{suggestions.map((s) => s.entityId ?? '-').join('|')}</Text>
      <Text testID="unavailable">{String(unavailable)}</Text>
    </>
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  clearLocalZeroState();
  clearRecentSelections();
  registerField(COUNTRY_FIELD, 'country_picker', { debounceMs: 0 });
  registerField(LANGUAGE_FIELD, 'language', { debounceMs: 0 });
  registerField(CITY_FIELD, 'city_picker', { debounceMs: 0 });
  registerField(SEARCH_FIELD, 'global_search', { debounceMs: 0 });
  registerField(PLACE_FIELD, 'place_picker', { debounceMs: 0 });
  registerField(NAME_FIELD, 'display_name', { debounceMs: 0 });
});

afterEach(() => {
  for (const f of [COUNTRY_FIELD, LANGUAGE_FIELD, CITY_FIELD, SEARCH_FIELD, PLACE_FIELD, NAME_FIELD]) {
    unregisterField(f);
  }
});

test('G197/G13: an OFFLINE country picker returns rows from the shipped dictionary', async () => {
  // Nothing cached, nothing accepted this session — before this layer existed
  // the only possible answer here was an empty panel, and the census said so.
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('Thailand');
});

test('G13: an offline row is marked LOCAL and resolves nothing', async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  // Distinguishable from a server row in the projected result …
  expect(screen.getByTestId('sources').props.children).toBe('local');
  // … and claiming no resolution the server never returned.
  expect(screen.getByTestId('actions').props.children).toBe('-');
  expect(screen.getByTestId('ids').props.children).toBe('-');
});

test('G197: an offline LANGUAGE field is answered from its own dictionary', async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={LANGUAGE_FIELD} text="viet" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('Vietnamese');
});

test('G198: an offline CITY picker is answered from the compact city index', async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={CITY_FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('Bangkok');
});

test('G241: a RETAINED server row still comes first, and is not duplicated', async () => {
  // What the session already accepted is a row the SERVER projected. It
  // outranks anything shipped, and the shipped copy of the same name is dropped
  // rather than shown beside it.
  recordLocalSelection(resolveFieldPolicy(CITY_FIELD), {
    id: 'srv:c1',
    type: 'entity',
    context: 'city_picker',
    label: 'Bangkok',
    entityType: 'city',
    entityId: 'c1',
    action: { type: 'open_entity', entityType: 'city', entityId: 'c1' },
    source: 'canonical',
    policyVersion: 'input-2026-08',
  } satisfies InputSuggestion);

  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={CITY_FIELD} text="" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  const labels = String(screen.getByTestId('labels').props.children).split('|');
  expect(labels[0]).toBe('Bangkok');
  expect(labels.filter((l) => l === 'Bangkok')).toHaveLength(1);
  expect(String(screen.getByTestId('sources').props.children).split('|')[0]).toBe('canonical');
});

test('G350: an offline SEARCH field with no match still offers the raw query', async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={SEARCH_FIELD} text="zzzzqqq" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('Search "zzzzqqq"');
  expect(screen.getByTestId('actions').props.children).toBe('submit_search');
});

test('§32: a SERVER_REQUIRED field renders nothing offline — the gate still holds', async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={PLACE_FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  // "Bangkok" is in the shipped city index and `place_picker` declares `city`
  // among its entity types — so this is the case where a dictionary COULD have
  // answered and the authority says it may not.
  expect(screen.getByTestId('labels').props.children).toBe('');
});

test('G5: display_name stays MANUAL — no rows and no request, offline or on', async () => {
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={NAME_FIELD} text="Vanessa" />);

  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe(''));
  expect(mockRequest).not.toHaveBeenCalled();
});

test('ONLINE is unchanged: a served answer is served alone, with nothing shipped mixed in', async () => {
  mockRequest.mockResolvedValueOnce({
    ok: true,
    requestId: 'req-1',
    policyVersion: 'input-2026-08',
    suggestions: [
      {
        id: 'srv:th',
        type: 'entity',
        context: 'country_picker',
        label: 'Thailand',
        entityType: 'country',
        entityId: 'th',
        action: { type: 'open_entity', entityType: 'country', entityId: 'th' },
        source: 'canonical',
        policyVersion: 'input-2026-08',
      },
    ],
  });
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('Thailand'));
  expect(screen.getByTestId('unavailable').props.children).toBe('false');
  expect(screen.getByTestId('sources').props.children).toBe('canonical');
  expect(screen.getByTestId('ids').props.children).toBe('th');
});

test('§34: the shipped dictionary does NOT pre-empt the request — the server is still asked', async () => {
  // The boundary census G224 draws: a local hit does not suppress the round
  // trip, because "the local answer is sufficient" is not a judgement this
  // client may make alone. The dictionary is a fallback, not a short-circuit.
  mockRequest.mockResolvedValueOnce(OFFLINE);
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(mockRequest).toHaveBeenCalledTimes(1);
});

test('§33: a TRANSIENT error is not offline — nothing shipped is shown for it', async () => {
  // The `unavailable` arm is the only one that may serve a shipped row. A
  // transient failure keeps whatever is on screen (nothing, here) and does NOT
  // fall back to the dictionary, because the field is not degraded — one
  // request failed.
  mockRequest.mockResolvedValueOnce({
    ok: false,
    aborted: false,
    unavailable: false,
    error: 'boom',
  });
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);

  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('labels').props.children).toBe('');
  expect(screen.getByTestId('unavailable').props.children).toBe('false');
});

/*
 * MUTATION LOG — filled in from the runs recorded in the report.
 */
