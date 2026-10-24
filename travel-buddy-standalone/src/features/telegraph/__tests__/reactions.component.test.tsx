/**
 * census-telegraph T370 (lane TELEGRAPH batch 3) — reactions, client side.
 *
 * Pins:
 *   - the chips draw exactly the server's aggregate (emoji, count, the viewer's own marked) and never who;
 *   - unreadable reactions (`null`) and no reactions draw nothing — "unreadable" is not "nobody";
 *   - tapping a chip toggles the viewer's own (add when not theirs, take back when it is);
 *   - the picker offers the bounded set and marks the viewer's own;
 *   - the command is the §13.1 bus's ADD_REACTION / REMOVE_REACTION, and a refusal is its sentence;
 *   - the wire is parsed strictly;
 *   - the thread screen offers reactions only through offersReactions (send allowed, affirmatively not
 *     E2EE, not degraded) and redraws from the server after every change.
 *
 * MUTANTS (tgprod/mutants-b3.txt): CR-R1 null drawn as none; CR-R2 a chip always adds; CR-R3 the
 * wrong command for a take-back; CR-R4 E2EE offered; CR-R5 no re-read after a change.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — lib/supabase builds a client at import time,
// which fails outside an Expo runtime. The API module reads only this name.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the API module reads one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));

import { ReactionChips, ReactionPicker } from '../reactions/ReactionChips.tsx';
import { parseReactions, REACTION_CHOICES, toggleReaction } from '../reactions/reactionsApi.ts';
import { offersReactions } from '../conversation/conversationProjection.ts';

const ready = (over: Record<string, unknown> = {}) => ({ status: 'ready' as const, canSendMessage: true, degraded: false, memberCount: 2, isE2ee: false, ...over });

describe('ReactionChips', () => {
  it('draws the server aggregate, the viewer\'s own marked, and no names', async () => {
    await render(<ReactionChips reactions={[{ emoji: '👍', count: 2, mine: true }, { emoji: '❤️', count: 1, mine: false }]} onToggle={() => {}} />);
    expect(screen.getByTestId('telegraph-reaction-👍').props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('👍 2')).toBeTruthy();
    expect(screen.getByText('❤️ 1')).toBeTruthy();
  });

  it('null (unreadable) draws nothing', async () => {
    await render(<ReactionChips reactions={null} onToggle={() => {}} />);
    expect(screen.queryByTestId('telegraph-reactions')).toBeNull();
  });

  it('[] (nobody reacted) draws nothing either', async () => {
    await render(<ReactionChips reactions={[]} onToggle={() => {}} />);
    expect(screen.queryByTestId('telegraph-reactions')).toBeNull();
  });

  it('a tap toggles the viewer\'s own: add when it is not theirs, take back when it is', async () => {
    const onToggle = jest.fn();
    await render(<ReactionChips reactions={[{ emoji: '👍', count: 2, mine: true }, { emoji: '❤️', count: 1, mine: false }]} onToggle={onToggle} />);
    await fireEvent.press(screen.getByTestId('telegraph-reaction-👍'));
    await fireEvent.press(screen.getByTestId('telegraph-reaction-❤️'));
    expect(onToggle.mock.calls).toEqual([['👍', true], ['❤️', false]]);
  });

  it('without a handler the chips are drawn but cannot be pressed', async () => {
    await render(<ReactionChips reactions={[{ emoji: '👍', count: 1, mine: false }]} />);
    expect(screen.getByTestId('telegraph-reaction-👍').props.accessibilityState.disabled).toBe(true);
  });
});

describe('ReactionPicker', () => {
  it('offers the bounded set and marks the viewer\'s own', async () => {
    const onPick = jest.fn();
    await render(<ReactionPicker reactions={[{ emoji: '🙏', count: 1, mine: true }]} onPick={onPick} />);
    for (const e of REACTION_CHOICES) expect(screen.getByTestId(`telegraph-react-${e}`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('telegraph-react-🙏'));
    await fireEvent.press(screen.getByTestId('telegraph-react-👍'));
    expect(onPick.mock.calls).toEqual([['🙏', true], ['👍', false]]);
  });
});

describe('toggleReaction — the §13.1 command', () => {
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });
  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });

  it('adds with ADD_REACTION and takes back with REMOVE_REACTION, on the conversation', async () => {
    const calls: any[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, command: 'X', data: {} }) } as Response; }) as typeof fetch;
    expect(await toggleReaction('t-1', 'm-1', '👍', false)).toEqual({ ok: true });
    expect(await toggleReaction('t-1', 'm-1', '👍', true)).toEqual({ ok: true });
    expect(calls.map((c) => [c.url, c.body.type, c.body.conversationId, c.body.params])).toEqual([
      ['https://api.test/api/telegraph/commands', 'ADD_REACTION', 't-1', { messageId: 'm-1', emoji: '👍' }],
      ['https://api.test/api/telegraph/commands', 'REMOVE_REACTION', 't-1', { messageId: 'm-1', emoji: '👍' }],
    ]);
  });

  it('a refusal (200 { ok: false }) is not a success', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, command: 'ADD_REACTION', reason: 'TELEGRAPH_AUTH_BLOCKED' }) }) as Response) as typeof fetch;
    const r = await toggleReaction('t-1', 'm-1', '👍', false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TELEGRAPH_AUTH_BLOCKED');
  });

  it('the wire is parsed strictly', () => {
    expect(parseReactions([{ emoji: '👍', count: 1, mine: false }])).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect(parseReactions(null)).toBeNull();
    expect(parseReactions(undefined)).toBeNull();
    expect(parseReactions([{ emoji: '👍', count: 0, mine: false }])).toBeNull();
    expect(parseReactions([{ emoji: '👍', count: 1 }])).toBeNull();
  });
});

describe('where reactions are offered', () => {
  it('send allowed, affirmatively not E2EE, not degraded — nothing else', () => {
    expect(offersReactions(ready())).toBe(true);
    expect(offersReactions(ready({ isE2ee: true }))).toBe(false);
    expect(offersReactions(ready({ isE2ee: null }))).toBe(false);
    expect(offersReactions(ready({ degraded: true }))).toBe(false);
    expect(offersReactions(ready({ canSendMessage: false }))).toBe(false);
    expect(offersReactions({ status: 'loading' })).toBe(false);
  });

  const src = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('the thread screen gates both entries on offersReactions and redraws from the server after a change', () => {
    expect(src).toMatch(/onToggleReaction=\{offersReactions\(conversationProjection\) && !safetyQuiet && dataSaver\.mayLoad\('reactions'\) \?/);
    expect(src).toMatch(/onReact=\{offersReactions\(conversationProjection\) && !safetyQuiet && dataSaver\.mayLoad\('reactions'\) \?/);
    expect(src).toMatch(/const r = await toggleReaction\(id, msg\.id, emoji, mineR\); if \(r\.ok\) void reload\(\); else Alert\.alert\('Reaction not changed', r\.message\);/);
    expect(src).toMatch(/\{onToggleReaction \? <ReactionChips reactions=\{parseReactions\(item\.reactions\)\}/);
  });
});
