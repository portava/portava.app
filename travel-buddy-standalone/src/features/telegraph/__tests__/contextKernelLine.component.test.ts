/**
 * census-telegraph T439 (lane TELEGRAPH batch 3) — the conversation screen reads the Context Kernel.
 *
 * Pins:
 *   - only REVEALED inputs speak: a withheld input contributes nothing, whatever its value holds;
 *   - Time: "Happening now" while a shared plan is on, else when the next one starts;
 *   - Proximity: the coarse bucket, in a direct conversation only, and only the coarse ones;
 *   - Relationship: the in-force origin that explains the two of you, most specific first;
 *   - an unreadable or malformed kernel draws nothing (the header says what it said before);
 *   - the thread screen fetches it once per conversation and appends the line to the header subtitle.
 *
 * MUTANTS (tgprod/mutants-b3.txt): CK1 a withheld input read; CK2 proximity drawn in a group;
 * CK3 a malformed answer guessed into a line; CK4 the screen never reads the kernel.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: intentionally exhaustive — lib/supabase builds a client at import time, which fails outside an
// Expo runtime. The module reads only this name.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the module reads one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));

import { kernelContextLine, parseContextKernel } from '../contextKernel/contextKernel.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const on = <T,>(value: T) => ({ revealed: true, reason: null, detail: null, value });
const off = <T,>(value: T | null = null) => ({ revealed: false, reason: 'KERNEL_INPUT_OFF', detail: null, value });

function wire(over: Record<string, unknown> = {}, type = 'direct') {
  return {
    conversationId: 'c-1',
    conversationType: type,
    inputs: {
      relationship: off(),
      time: on({ now: '2026-10-24T12:00:00.000Z', frame: 'UTC', band: null, nextStartsAt: null }),
      proximity: off(),
      intent: off(),
      sharedObjects: off(),
      ...over,
    },
    offeredActions: [],
    degraded: false,
  };
}
const line = (w: unknown) => kernelContextLine(parseContextKernel(w), NOW);

describe('kernelContextLine', () => {
  it('nothing revealed → nothing drawn', () => {
    expect(line(wire())).toBeNull();
  });

  it('Time: happening now, or when the next starts', () => {
    expect(line(wire({ time: on({ now: '', frame: 'UTC', band: 'HAPPENING_NOW', nextStartsAt: null }) }))).toBe('Happening now');
    expect(line(wire({ time: on({ now: '', frame: 'UTC', band: 'UPCOMING', nextStartsAt: '2026-10-24T14:00:00.000Z' }) }))).toBe('Next: in 2 h');
    expect(line(wire({ time: on({ now: '', frame: 'UTC', band: 'UPCOMING', nextStartsAt: '2026-10-24T12:20:00.000Z' }) }))).toBe('Next: in 20 min');
    expect(line(wire({ time: on({ now: '', frame: 'UTC', band: null, nextStartsAt: '2026-10-24T11:00:00.000Z' }) }))).toBeNull();
  });

  it('Proximity: a coarse bucket, in a direct conversation only', () => {
    const p = on({ people: [{ userId: 'u-2', bucket: 'nearby', travel: 'walk', freshness: 'fresh' }] });
    expect(line(wire({ proximity: p }))).toBe('Nearby');
    expect(line(wire({ proximity: p }, 'group'))).toBeNull();
    expect(line(wire({ proximity: on({ people: [{ userId: 'u-2', bucket: 'far' }] }) }))).toBeNull();
  });

  it('Relationship: the most specific in-force origin', () => {
    expect(line(wire({ relationship: on({ state: 'ACTIVE', origins: ['MUTUAL_FOLLOW', 'CREW'], expiredOrigins: [] }) }))).toBe('Trip crew');
    expect(line(wire({ relationship: on({ state: 'ACTIVE', origins: ['FOLLOW'], expiredOrigins: [] }) }))).toBeNull();
  });

  it('a WITHHELD input says nothing, whatever its value holds', () => {
    expect(line(wire({
      time: off({ now: '', frame: 'UTC', band: 'HAPPENING_NOW', nextStartsAt: null }),
      proximity: off({ people: [{ userId: 'u-2', bucket: 'same_area' }] }),
      relationship: off({ state: 'ACTIVE', origins: ['CREW'], expiredOrigins: [] }),
    }))).toBeNull();
  });

  it('the parts join in order', () => {
    expect(line(wire({
      time: on({ now: '', frame: 'UTC', band: 'HAPPENING_NOW', nextStartsAt: null }),
      proximity: on({ people: [{ userId: 'u-2', bucket: 'same_city' }] }),
      relationship: on({ state: 'TEMPORARY', origins: ['TRIP'], expiredOrigins: [] }),
    }))).toBe('Happening now · Same city · Same trip');
  });

  it('an unreadable or malformed kernel draws nothing', () => {
    expect(kernelContextLine(null, NOW)).toBeNull();
    expect(parseContextKernel({})).toBeNull();
    expect(parseContextKernel({ inputs: { time: { revealed: 'yes' } } })).toBeNull();
    expect(parseContextKernel('nope')).toBeNull();
    expect(parseContextKernel({ inputs: { time: on({ now: '', frame: 'UTC', band: 'HAPPENING_NOW', nextStartsAt: null }) } })).toBeNull(); // an answer missing inputs is not a kernel answer
  });
});

describe('the thread screen', () => {
  const src = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('reads the kernel once per conversation and appends its line to the header subtitle', () => {
    expect(src).toMatch(/const kernelLine = useContextKernelLine\(id \?\? null\);/);
    expect(src).toMatch(/\{subtitle\}\{kernelLine \? `\$\{subtitle \? ' · ' : ''\}\$\{kernelLine\}` : ''\}/);
  });
});
