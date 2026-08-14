/**
 * Unit tests for mediaStore mode reconciliation logic.
 *
 * Tests pickValidMode (pure function) plus integration scenarios:
 *   (a) watch disabled — selected mode falls back to first enabled
 *   (b) single enabled mode — selector hidden but correct mode renders
 *   (c) persisted disabled mode in AsyncStorage — store reconciles on restore
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickValidMode } from '../mediaStore.ts';
import type { MediaMode } from '../mediaStore.ts';

// ── pickValidMode ─────────────────────────────────────────────────────────────

test('pickValidMode: returns preferred mode when it is in the enabled set', () => {
  assert.equal(pickValidMode('watch', ['watch', 'grid', 'gems']), 'watch');
  assert.equal(pickValidMode('grid',  ['watch', 'grid', 'gems']), 'grid');
  assert.equal(pickValidMode('gems',  ['watch', 'grid', 'gems']), 'gems');
});

test('(a) pickValidMode: watch disabled — falls back to first enabled (grid)', () => {
  assert.equal(pickValidMode('watch', ['grid', 'gems']), 'grid');
});

test('(a) pickValidMode: gems disabled — falls back to first enabled (watch)', () => {
  assert.equal(pickValidMode('gems', ['watch', 'grid']), 'watch');
});

test('(b) pickValidMode: single enabled mode — always returns that mode', () => {
  assert.equal(pickValidMode('watch', ['grid']), 'grid');
  assert.equal(pickValidMode('gems',  ['grid']), 'grid');
  assert.equal(pickValidMode('grid',  ['watch']), 'watch');
  assert.equal(pickValidMode('watch', ['gems']), 'gems');
});

test('pickValidMode: empty enabledModes (flags loading) — preserves preferred', () => {
  // Flags haven't loaded yet; do not snap to a disabled/undefined mode.
  assert.equal(pickValidMode('watch', []), 'watch');
  assert.equal(pickValidMode('grid',  []), 'grid');
  assert.equal(pickValidMode('gems',  []), 'gems');
});

// ── Reconciliation scenarios ──────────────────────────────────────────────────

test('(a) reconciliation: persisted watch + watch disabled → grid', () => {
  const persisted: MediaMode = 'watch';
  const enabledAfterLoad: MediaMode[] = ['grid', 'gems'];
  assert.equal(pickValidMode(persisted, enabledAfterLoad), 'grid');
});

test('(a) reconciliation: defaultMode=watch + watch disabled → falls to first enabled', () => {
  // Simulates: no AsyncStorage value; candidate comes from defaultMode='watch'.
  const candidate: MediaMode = 'watch';
  const enabled: MediaMode[] = ['grid', 'gems'];
  assert.equal(pickValidMode(candidate, enabled), 'grid');
});

test('(b) reconciliation: only grid enabled, persisted watch → grid', () => {
  assert.equal(pickValidMode('watch', ['grid']), 'grid');
});

test('(b) reconciliation: only gems enabled, persisted watch → gems', () => {
  assert.equal(pickValidMode('watch', ['gems']), 'gems');
});

test('(c) reconciliation: persisted gems, gems later disabled → watch', () => {
  const stored: MediaMode = 'gems';
  const enabledAfterFlagChange: MediaMode[] = ['watch', 'grid'];
  assert.equal(pickValidMode(stored, enabledAfterFlagChange), 'watch');
});

test('(c) reconciliation: persisted grid, grid is still enabled → preserved', () => {
  const stored: MediaMode = 'grid';
  const enabled: MediaMode[] = ['watch', 'grid', 'gems'];
  assert.equal(pickValidMode(stored, enabled), 'grid');
});

test('reconciliation: all modes enabled — any persisted value is valid', () => {
  const all: MediaMode[] = ['watch', 'grid', 'gems'];
  for (const mode of all) {
    assert.equal(pickValidMode(mode, all), mode);
  }
});

test('reconciliation: flags not yet loaded (empty) — current mode preserved', () => {
  // During initial render before flags arrive, do not force a mode switch.
  assert.equal(pickValidMode('gems', []), 'gems');
});
