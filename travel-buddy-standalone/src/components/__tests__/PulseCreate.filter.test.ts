/**
 * Filter-apply-result machine tests for UnifiedPostComposer (PulseCreate.tsx).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/PulseCreate.filter.test.ts
 *
 * ## Why this test exists
 *
 * The filter-apply path (MediaFilterEditor.onApply → handleFilterApplyResult) was
 * previously inline in PulseCreate.tsx and untested at the machine layer. A
 * regression in the failure branch could dismiss the composer sheet when the filter
 * step errors, silently discarding the user's draft.
 *
 * ## Testing strategy
 *
 * handleFilterApplyResult is a pure synchronous function that receives injected
 * side-effect handlers — no React Native renderer required. Two branches:
 *
 *   1. ok: true  → setMedia + setFilterId + setFilterIntensity + clear pending
 *                  + close editor; setError NOT called; returns { continue: true }
 *   2. ok: false → setError called; setMedia NOT called; editor closed;
 *                  returns { continue: false }
 *
 * The absence of `onClose` in FilterApplyResultHandlers is a structural
 * guarantee that the composer cannot be dismissed on filter failure — the
 * function signature enforces it at compile time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleFilterApplyResult } from '../PulseCreate.machine.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHandlers() {
  const calls = {
    setMedia: [] as unknown[],
    setFilterId: [] as string[],
    setFilterIntensity: [] as number[],
    setFilterEditorPending: [] as (null)[],
    setFilterEditorOpen: [] as boolean[],
    setError: [] as string[],
  };
  const handlers = {
    setMedia: (m: unknown) => { calls.setMedia.push(m); },
    setFilterId: (id: string) => { calls.setFilterId.push(id); },
    setFilterIntensity: (n: number) => { calls.setFilterIntensity.push(n); },
    setFilterEditorPending: (m: null) => { calls.setFilterEditorPending.push(m); },
    setFilterEditorOpen: (open: boolean) => { calls.setFilterEditorOpen.push(open); },
    setError: (msg: string) => { calls.setError.push(msg); },
  };
  return { calls, handlers };
}

// ── Success path ──────────────────────────────────────────────────────────────

describe('filter ok — handleFilterApplyResult with ok: true', () => {
  it('returns { continue: true }', () => {
    const { handlers } = makeHandlers();
    const result = handleFilterApplyResult(
      { ok: true, filteredMedia: { uri: 'file://processed.jpg' }, filterId: 'warm', filterIntensity: 80 },
      handlers,
    );
    assert.equal(result.continue, true, 'must return { continue: true } on success');
  });

  it('calls setMedia with the provided filteredMedia', () => {
    const { calls, handlers } = makeHandlers();
    const filteredMedia = { uri: 'file://processed.jpg', mimeType: 'image/jpeg' };
    handleFilterApplyResult(
      { ok: true, filteredMedia, filterId: 'warm', filterIntensity: 80 },
      handlers,
    );
    assert.equal(calls.setMedia.length, 1, 'setMedia must be called exactly once');
    assert.deepEqual(calls.setMedia[0], filteredMedia, 'setMedia must receive the filteredMedia object');
  });

  it('calls setFilterId with the correct id', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult(
      { ok: true, filteredMedia: { uri: 'file://x.jpg' }, filterId: 'vivid', filterIntensity: 60 },
      handlers,
    );
    assert.deepEqual(calls.setFilterId, ['vivid'], 'setFilterId must be called with the resolved filterId');
  });

  it('calls setFilterIntensity with the correct value', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult(
      { ok: true, filteredMedia: { uri: 'file://x.jpg' }, filterId: 'vivid', filterIntensity: 65 },
      handlers,
    );
    assert.deepEqual(calls.setFilterIntensity, [65], 'setFilterIntensity must be called with the resolved intensity');
  });

  it('calls setFilterEditorPending with null to clear the pending slot', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult(
      { ok: true, filteredMedia: { uri: 'file://x.jpg' }, filterId: 'original', filterIntensity: 100 },
      handlers,
    );
    assert.equal(calls.setFilterEditorPending.length, 1, 'setFilterEditorPending must be called once');
    assert.equal(calls.setFilterEditorPending[0], null, 'setFilterEditorPending must be called with null');
  });

  it('calls setFilterEditorOpen(false) to close the editor', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult(
      { ok: true, filteredMedia: { uri: 'file://x.jpg' }, filterId: 'original', filterIntensity: 100 },
      handlers,
    );
    assert.ok(calls.setFilterEditorOpen.includes(false), 'setFilterEditorOpen must be called with false');
  });

  it('does NOT call setError on success', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult(
      { ok: true, filteredMedia: { uri: 'file://x.jpg' }, filterId: 'warm', filterIntensity: 80 },
      handlers,
    );
    assert.equal(calls.setError.length, 0, 'setError must NOT be called on success');
  });
});

// ── Failure path — composer stays open ───────────────────────────────────────

describe('filter fails — handleFilterApplyResult with ok: false', () => {
  it('returns { continue: false }', () => {
    const { handlers } = makeHandlers();
    const result = handleFilterApplyResult(
      { ok: false, message: 'Render failed' },
      handlers,
    );
    assert.equal(result.continue, false, 'must return { continue: false } on failure');
  });

  it('calls setError with the provided message', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult(
      { ok: false, message: 'Render failed' },
      handlers,
    );
    assert.deepEqual(calls.setError, ['Render failed'], 'setError must be called with the error message');
  });

  it('calls setError with a default message when none is provided', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult({ ok: false }, handlers);
    assert.equal(calls.setError.length, 1, 'setError must be called exactly once');
    assert.ok(calls.setError[0].length > 0, 'default error message must be non-empty');
  });

  it('does NOT call setMedia on failure — composer stays open with original media', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult({ ok: false, message: 'oops' }, handlers);
    assert.equal(calls.setMedia.length, 0, 'setMedia must NOT be called on failure');
  });

  it('does NOT call setFilterId on failure', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult({ ok: false }, handlers);
    assert.equal(calls.setFilterId.length, 0, 'setFilterId must NOT be called on failure');
  });

  it('does NOT call setFilterEditorPending on failure', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult({ ok: false }, handlers);
    assert.equal(calls.setFilterEditorPending.length, 0, 'setFilterEditorPending must NOT be called on failure');
  });

  it('still calls setFilterEditorOpen(false) on failure — editor always closes', () => {
    const { calls, handlers } = makeHandlers();
    handleFilterApplyResult({ ok: false, message: 'oops' }, handlers);
    assert.ok(calls.setFilterEditorOpen.includes(false), 'setFilterEditorOpen must be called with false even on failure');
  });
});
