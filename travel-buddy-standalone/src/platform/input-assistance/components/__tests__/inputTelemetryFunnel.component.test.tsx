/**
 * §44/§45/§57 — the funnel arms that were DECLARED AND NEVER EMITTED.
 *
 * The census recorded nine event names as "declared, never emitted — no call
 * site": `suggestion_rendered`, `suggestion_dismissed`, `raw_search_submitted`,
 * `manual_value_kept`, `validation_shown`, `correction_accepted`,
 * `disambiguation_selected`, `action_completed`, `downstream_task_completed`.
 * Of the fourteen names in `InputTelemetryEventName`, exactly five had a call
 * site, and the one that moved rank — `suggestion_selected` — is the ACCEPTANCE
 * signal §45 explicitly forbids optimising for on its own.
 *
 * WHY THIS FILE DRIVES THE REAL COMPONENT. A test that called
 * `emitSuggestionsRendered` directly would prove the helper works and would be
 * worthless for these rows: the gap was never the helper, it was that nothing
 * called it. Every test below renders the REAL `SmartInput`, drives it with
 * focus / press / blur / submit, and asserts what reached a sink attached with
 * the module's own `setTelemetrySink`.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CLAIM. Emission is not measurement. The
 * default sink is still a no-op and this layer ships no transport, so in
 * production these events are produced and dropped. That is recorded against
 * the sink row in the census rather than papered over here. `action_completed`
 * and `downstream_task_completed` are likewise NOT asserted: both are owned by
 * the screen that finishes the task, and this layer cannot observe either.
 *
 * A HARNESS FACT THIS FILE IS SHAPED BY. React 19 + RNTL 14 in this repo start
 * returning a NULL tree from `render` after the FOURTH mount in one file — every
 * query then fails with "unable to find …" against an empty container, which
 * looks exactly like a broken component. (`jest.setup.ts` documents the
 * neighbouring overlapping-act() corruption.) Each test below therefore mounts
 * AT MOST ONCE and asserts several arms of one interaction, and teardown
 * unmounts explicitly rather than relying on auto-cleanup.
 *
 * MUTATION LOG (each applied, watched go red, reverted):
 *   - SmartInput.tsx: delete the `emitSuggestionsRendered` call in the render
 *     effect → the impression + validation assertions go red.
 *   - SmartInput.tsx: set `acceptedRef.current = true` in the render effect →
 *     the dismissal ("ignored arm") test goes red.
 *   - SmartInput.tsx: drop the `!acceptedRef.current` guard on blur → "an
 *     accepted list is never also a manual keep" goes red.
 *   - inputTelemetry.ts: make `scrubProps` return props unchanged → the
 *     raw-text assertions go red.
 */

import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stubs — both modules import the Supabase-backed
// token helper (apiToken.ts) at module load, which has no native module under
// jest. Each factory lists that module's complete export surface, so a new
// export is a deliberate contract change rather than silent drift.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — `recordSuggestionSelection` is this module's
// only export, and the module reaches Supabase through apiToken.ts at load.
jest.mock('../../services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
}));

import { SmartInput } from '../SmartInput.tsx';
import { requestSuggestions } from '../../services/inputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import {
  setTelemetrySink,
  resetTelemetrySink,
  emitInputEvent,
  type InputTelemetryEvent,
} from '../../services/inputTelemetry.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.telemetry.search';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? 's1',
    type: over.type ?? 'entity',
    context: over.context ?? 'global_search',
    label: over.label ?? 'Bangkok',
    entityType: over.entityType ?? 'city',
    entityId: over.entityId ?? 'c1',
    source: over.source ?? 'canonical',
    policyVersion: 'input-2026-08',
    ...over,
  };
}

let events: InputTelemetryEvent[] = [];
const names = () => events.map((e) => e.name);
const named = (n: string) => events.filter((e) => e.name === n);

beforeEach(() => {
  events = [];
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  registerField(FIELD, 'global_search', { debounceMs: 0 });
  setTelemetrySink((e) => { events.push(e); });
});

afterEach(async () => {
  await cleanup();
  resetTelemetrySink();
  unregisterField(FIELD);
});

async function renderWith(suggestions: InputSuggestion[], value = 'bang') {
  mockRequest.mockResolvedValue({
    ok: true, requestId: 'req-test', policyVersion: 'input-2026-08', suggestions,
  });
  const r = await render(
    <SmartInput fieldId={FIELD} value={value} onChangeText={() => {}} label="Search" testID="tel-input" />,
  );
  fireEvent(r.getByTestId('tel-input'), 'focus');
  if (suggestions.length > 0) {
    await waitFor(() => expect(names()).toContain('suggestion_rendered'));
  }
  return r;
}

// ── 1. the denominator + the validation impression (G311, G316) ──────────────

test('§44: a rendered list emits ONE impression, its types, and a validation_shown', async () => {
  await renderWith([
    sug({ id: 'a', label: 'Bangkok', entityId: 'c1' }),
    sug({ id: 'v', type: 'validation', label: 'Username is already taken', entityId: undefined, entityType: undefined }),
  ]);

  // G311 — `suggestion_rendered` is §57's denominator. Nothing recorded that a
  // suggestion had ever been PUT IN FRONT of the user, so "valid entity
  // resolution rate" and "manual fallback rate" had nothing to divide by.
  const rendered = named('suggestion_rendered');
  expect(rendered).toHaveLength(1);
  expect(rendered[0]!.props).toMatchObject({ count: 2, types: 'entity,validation' });
  expect(rendered[0]!.fieldId).toBe(FIELD);
  expect(rendered[0]!.context).toBe('global_search');

  // The impression carries counts and TYPE names, never labels: a rendered
  // recipient list is a list of people.
  expect(JSON.stringify(rendered[0]!.props)).not.toContain('Bangkok');

  // G316 — a §23 validation row reached the user. Validations have been produced
  // and rendered since Phase 5 and nothing recorded that they were ever seen.
  expect(named('validation_shown')[0]!.props).toMatchObject({ count: 1 });
});

// ── 2. no impression without an impression, and the raw-submit path (G314) ───

test('§44: an empty result set emits no impression, and submitting it is a RAW search', async () => {
  mockRequest.mockResolvedValue({
    ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [],
  });
  const r = await render(
    <SmartInput fieldId={FIELD} value="street food" onChangeText={() => {}} testID="tel-input" />,
  );
  fireEvent(r.getByTestId('tel-input'), 'focus');
  await waitFor(() => expect(names()).toContain('suggestion_request_completed'));
  expect(names()).not.toContain('suggestion_rendered');
  expect(names()).not.toContain('validation_shown');

  // G314's OTHER path: the user pressed return on their own text, resolving
  // nothing. §57's "manual fallback rate" counts this alongside manual_value_kept.
  fireEvent(r.getByTestId('tel-input'), 'submitEditing');
  const raw = named('raw_search_submitted');
  expect(raw).toHaveLength(1);
  expect(raw[0]!.props).toMatchObject({ viaSuggestion: false, length: 'street food'.length });
  expect(names()).not.toContain('suggestion_selected');
});

// ── 3. the IGNORED and EDITED arms (G313, G315) ──────────────────────────────

test('§45: blurring past a shown list records it as IGNORED and the text as KEPT', async () => {
  const r = await renderWith(
    [
      sug({ id: 'a', label: 'Bangkok', entityId: 'c1' }),
      sug({ id: 'b', label: 'Bangkok Noi', entityId: 'c2' }),
    ],
    'my own words',
  );
  fireEvent(r.getByTestId('tel-input'), 'blur');
  await waitFor(() => expect(names()).toContain('suggestion_dismissed'));

  // G313 — §45 requires learning from accepted AND IGNORED suggestions. Only
  // acceptance was ever recorded, which is the anti-pattern §45 names by hand.
  expect(named('suggestion_dismissed')[0]!.props).toMatchObject({ shownCount: 2 });

  // G315 — the EDITED arm, and §57's "manual fallback rate" numerator. A LENGTH,
  // never the text: this event must be emittable on a caption or a private
  // message whose policy forbids raw capture.
  const kept = named('manual_value_kept');
  expect(kept).toHaveLength(1);
  expect(kept[0]!.props).toMatchObject({ length: 'my own words'.length });
  expect(JSON.stringify(kept[0]!.props)).not.toContain('words');
});

// ── 4b. §55 duplicate resolution — §57's duplicate-prevention count (G369) ───

test('§44/G369: a duplicate row taken is recorded as resolving an EXISTING entity', async () => {
  // This is what lib/inputAssistance/creation.ts#projectDuplicate puts on the
  // wire: a `disambiguation` row carrying a `resolve_existing` structured value.
  // Before this bit existed, a §55 duplicate and a §19 ambiguity were the same
  // event, so "duplicate creation prevented" could only be GUESSED at from the
  // context the event happened in — which is a different claim.
  const r = await renderWith([
    sug({
      id: 'dup',
      type: 'disambiguation',
      label: 'Did you mean Hidden Bar?',
      entityType: 'hidden_gem',
      entityId: 'g-1',
      confidence: 0.72,
      structuredValue: { kind: 'resolve_existing', entityType: 'hidden_gem', entityId: 'g-1' },
    }),
  ]);

  fireEvent.press(r.getByTestId('ia-entity-row-dup'));

  const ev = named('disambiguation_selected');
  expect(ev).toHaveLength(1);
  expect(ev[0]!.props).toMatchObject({ resolvedExisting: true, entityType: 'hidden_gem' });
  // One BOOL and nothing else new: no label, no name, no free text rides along
  // on the back of the duplicate signal.
  expect(JSON.stringify(ev[0]!.props)).not.toContain('Hidden Bar');
});

// ── 4. the per-kind acceptance events (G314, G317, G318) ─────────────────────

test('§44: correction, disambiguation and query rows each record their own kind', async () => {
  const r = await renderWith([
    sug({ id: 'c', type: 'correction', label: 'Did you mean "bangkok"?', replacementText: 'bangkok', confidence: 0.87, entityId: undefined, entityType: undefined }),
    sug({ id: 'd', type: 'disambiguation', label: 'Paris', subtitle: 'Texas', confidence: 0.55, entityId: 'p-tx' }),
    sug({ id: 'q', type: 'completion', label: 'Search "bang"', replacementText: 'bang', entityId: undefined, entityType: undefined, action: { type: 'submit_search', query: 'bang' } }),
  ]);

  // G317 — a §10 spelling correction was taken.
  fireEvent.press(r.getByTestId('ia-entity-row-c'));
  expect(named('correction_accepted')[0]!.props).toMatchObject({ confidence: 0.87 });

  // G318 — a §19 ranked CHOICE was resolved by the user rather than guessed.
  fireEvent.press(r.getByTestId('ia-entity-row-d'));
  expect(named('disambiguation_selected')[0]!.props).toMatchObject({ entityType: 'city' });
  // …and this one is an AMBIGUITY, not a duplicate: it carries no
  // `resolve_existing` structured value, so §57's duplicate count must not
  // claim it (G369).
  expect(named('disambiguation_selected')[0]!.props).toMatchObject({ resolvedExisting: false });

  // G314 — the user submitted their query instead of resolving it.
  fireEvent.press(r.getByTestId('ia-entity-row-q'));
  expect(named('raw_search_submitted')[0]!.props).toMatchObject({ viaSuggestion: true });

  // Each kind is ALSO a generic acceptance — complementary, not alternative,
  // because §57 needs both "how many resolved" and "resolved how".
  expect(named('suggestion_selected')).toHaveLength(3);

  // …and an accepted list is never ALSO counted as ignored or manually kept.
  fireEvent(r.getByTestId('tel-input'), 'blur');
  expect(names()).not.toContain('suggestion_dismissed');
  expect(names()).not.toContain('manual_value_kept');
});

// ── 5. the privacy guarantee the new arms must not break (no mount) ──────────

test('§44: a non-capturing policy drops every raw-text prop the new arms could carry', () => {
  emitInputEvent(
    'manual_value_kept',
    'f',
    'telegraph_message',
    { length: 5, text: 'secret', query: 'secret', rawText: 'secret', message: 'secret' },
    { logRawText: false, events: ['manual_value_kept'] },
  );
  expect(named('manual_value_kept')[0]!.props).toEqual({ length: 5 });
});

test("§44: a policy's event allowlist still gates the new names", () => {
  emitInputEvent(
    'suggestion_dismissed',
    'f',
    'telegraph_message',
    { shownCount: 3 },
    { logRawText: false, events: ['input_opened'] },
  );
  expect(names()).not.toContain('suggestion_dismissed');
});
