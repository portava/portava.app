/**
 * Telemetry raw-text scrubbing — §44 / §49 Certification (Phase 10).
 *
 * "Telemetry should measure usefulness without unnecessarily capturing raw
 * private text." The field-registry test proves each policy DECLARES the right
 * `captureRawText`; this proves the emit path ENFORCES it — the actual scrub that
 * makes a private message impossible to leak through analytics.
 *
 * Locks:
 *   - A `captureRawText:false` field drops every raw-text prop (text / query /
 *     rawText / message) before the event leaves the module, while keeping the
 *     non-sensitive metadata (counts, lengths, types).
 *   - A public field (`captureRawText:true`) keeps its props verbatim.
 *   - The `events` allowlist gates which events fire at all.
 *   - A throwing sink never surfaces to the caller (telemetry must not affect UX).
 *
 * MUTATION-PROOF: delete the `RAW_TEXT_KEYS.has(k)` drop in scrubProps (or make it
 * honour no policy) and the "private field drops raw text" assertion goes RED.
 *
 * Pure logic — no React/network — runs under the node:test runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emitInputEvent,
  setTelemetrySink,
  resetTelemetrySink,
  type InputTelemetryEvent,
} from '../inputTelemetry.ts';
import type { InputTelemetryPolicy } from '../../types/fieldPolicy.ts';

const PUBLIC_POLICY: InputTelemetryPolicy = { captureRawText: true, events: 'all' };
const PRIVATE_POLICY: InputTelemetryPolicy = { captureRawText: false, events: 'all' };
const NARROW_POLICY: InputTelemetryPolicy = {
  captureRawText: false,
  events: ['suggestion_selected'],
};

function withSpy(fn: (events: InputTelemetryEvent[]) => void): void {
  const events: InputTelemetryEvent[] = [];
  setTelemetrySink((e) => events.push(e));
  try {
    fn(events);
  } finally {
    resetTelemetrySink();
  }
}

// ── private field: raw text stripped ─────────────────────────────────────────────

test('captureRawText:false drops every raw-text prop but keeps metadata', () => {
  withSpy((events) => {
    emitInputEvent(
      'suggestion_request_completed',
      'telegraph_message',
      'telegraph_message',
      { text: 'meet at my home address', query: 'meet at', message: 'secret', count: 3, latencyMs: 42 },
      PRIVATE_POLICY,
    );
    assert.equal(events.length, 1);
    const props = events[0]!.props ?? {};
    // Raw-text carriers are gone.
    assert.equal('text' in props, false, 'raw text must be dropped');
    assert.equal('query' in props, false, 'raw query must be dropped');
    assert.equal('message' in props, false, 'raw message must be dropped');
    // Non-sensitive metadata survives.
    assert.equal(props.count, 3);
    assert.equal(props.latencyMs, 42);
  });
});

// ── public field: props preserved ────────────────────────────────────────────────

test('captureRawText:true keeps raw-text props verbatim (public search field)', () => {
  withSpy((events) => {
    emitInputEvent(
      'raw_search_submitted',
      'global_search',
      'global_search',
      { query: 'da nang', count: 5 },
      PUBLIC_POLICY,
    );
    assert.equal(events.length, 1);
    const props = events[0]!.props ?? {};
    assert.equal(props.query, 'da nang', 'a public search field may retain its query');
    assert.equal(props.count, 5);
  });
});

// ── event allowlist gating ───────────────────────────────────────────────────────

test('the events allowlist gates which events fire', () => {
  withSpy((events) => {
    // Not in the allowlist → suppressed entirely.
    emitInputEvent('suggestion_request_completed', 'f', 'telegraph_message', { count: 1 }, NARROW_POLICY);
    assert.equal(events.length, 0, 'an event outside the allowlist must not fire');
    // In the allowlist → fires (still scrubbed).
    emitInputEvent('suggestion_selected', 'f', 'telegraph_message', { text: 'x', suggestionType: 'entity' }, NARROW_POLICY);
    assert.equal(events.length, 1);
    assert.equal('text' in (events[0]!.props ?? {}), false, 'even an allowed event is scrubbed');
    assert.equal((events[0]!.props ?? {}).suggestionType, 'entity');
  });
});

// ── no policy → passthrough, still safe shape ────────────────────────────────────

test('a missing policy emits (fields always default to a policy upstream) and never throws', () => {
  withSpy((events) => {
    emitInputEvent('input_opened', 'f', 'global_search', undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.name, 'input_opened');
  });
});

// ── a throwing sink is swallowed ─────────────────────────────────────────────────

test('a throwing sink never surfaces to the caller', () => {
  setTelemetrySink(() => { throw new Error('analytics down'); });
  try {
    assert.doesNotThrow(() =>
      emitInputEvent('suggestion_selected', 'f', 'global_search', { count: 1 }, PUBLIC_POLICY),
    );
  } finally {
    resetTelemetrySink();
  }
});
