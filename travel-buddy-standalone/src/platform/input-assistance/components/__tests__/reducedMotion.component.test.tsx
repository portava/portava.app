/**
 * §46/§49 reduced motion (census G351) — the layer's one animation honours the
 * OS setting, and there is no second one.
 *
 * WHAT IS DRIVEN. The real `DisambiguationSheet`, with `AccessibilityInfo`
 * spied the way the Wall's reduced-motion tests spy it. The detector at the foot
 * reads the layer's component sources, so a new animation added later without
 * the hook turns this file red.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - DisambiguationSheet.tsx: `animationType={reduceMotion ? 'none' : 'slide'}`
 *     → `animationType="slide"` → "reduce motion ON: the sheet appears without
 *     sliding" red, and the detector red (an unguarded animationType).
 *   - reducedMotion.ts: drop the `reduceMotionChanged` subscription → "turning
 *     the setting on WHILE the sheet is mounted" red.
 *   - PasteReviewSheet.tsx: back to `animationType="slide"` → "the paste review
 *     sheet honours the same setting" red, and the detector red. (The detector
 *     found this second, unguarded animation on its first run.)
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { AccessibilityInfo } from 'react-native';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — the paste sheet's transport reaches the
// Supabase-backed token helper at load; `freshToken` is all it calls.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { DisambiguationSheet } from '../DisambiguationSheet.tsx';
import { PasteReviewSheet } from '../../paste/PasteReviewSheet.tsx';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const CANDIDATES: InputSuggestion[] = [
  { id: 'c1', type: 'disambiguation', context: 'city_picker', label: 'Paris', subtitle: 'France', source: 'canonical', policyVersion: 'v' },
  { id: 'c2', type: 'disambiguation', context: 'city_picker', label: 'Paris', subtitle: 'Texas, USA', source: 'canonical', policyVersion: 'v' },
];

let reduceSpy: jest.SpyInstance;
let listenerSpy: jest.SpyInstance;
let changed: ((v: boolean) => void) | null = null;

beforeEach(() => {
  changed = null;
  reduceSpy = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  listenerSpy = jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((event: string, cb: (v: boolean) => void) => {
    if (event === 'reduceMotionChanged') changed = cb;
    return { remove: () => {} };
  }) as never);
});

afterEach(async () => {
  await cleanup();
  reduceSpy.mockRestore();
  listenerSpy.mockRestore();
});

function Sheet() {
  return (
    <DisambiguationSheet
      visible
      query="paris"
      candidates={CANDIDATES}
      onSelect={() => {}}
      onSearchInstead={() => {}}
      onClose={() => {}}
    />
  );
}

test('G351: reduce motion ON — the sheet appears without sliding', async () => {
  reduceSpy.mockResolvedValue(true);
  const r = await render(<Sheet />);
  await waitFor(() => expect(r.getByTestId('ia-disambiguation-modal').props.animationType).toBe('none'));
});

test('G351: reduce motion OFF — the sheet keeps its slide (the control)', async () => {
  const r = await render(<Sheet />);
  await act(async () => { await Promise.resolve(); });
  expect(r.getByTestId('ia-disambiguation-modal').props.animationType).toBe('slide');
});

test('G351: turning the setting on WHILE the sheet is mounted stops the motion', async () => {
  const r = await render(<Sheet />);
  await act(async () => { await Promise.resolve(); });
  expect(r.getByTestId('ia-disambiguation-modal').props.animationType).toBe('slide');
  expect(changed).not.toBeNull();
  await act(async () => { changed?.(true); });
  expect(r.getByTestId('ia-disambiguation-modal').props.animationType).toBe('none');
});

test('G351: the paste review sheet honours the same setting', async () => {
  reduceSpy.mockResolvedValue(true);
  const r = await render(
    <PasteReviewSheet visible context="trip_destination" fieldId="test.paste" onClose={() => {}} onConfirm={async () => []} />,
  );
  await waitFor(() => expect(r.getByTestId('paste-review-modal').props.animationType).toBe('none'));
});

test('G351 detector: no other animation in the layer, and every animationType is guarded', () => {
  const root = path.resolve(__dirname, '..', '..');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'examples') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(root);
  expect(files.length).toBeGreaterThan(20);
  const offenders: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f);
    if (/\bAnimated\.|LayoutAnimation|react-native-reanimated|useNativeDriver/.test(src)) offenders.push(`${rel}: animation primitive`);
    for (const m of src.matchAll(/animationType=(\{[^}]*\}|"[^"]*")/g)) {
      if (!/reduceMotion \? 'none'/.test(m[1] ?? '')) offenders.push(`${rel}: unguarded ${m[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
