/**
 * census-telegraph T407 (lane TELEGRAPH batch 3) — the author's control over who may forward a message.
 *
 * Pins:
 *   - the four capabilities are offered in words that say what each does, the one in force marked;
 *   - a choice is sent once, and the sheet then shows what the server READ BACK;
 *   - a refusal is the server's sentence and the rule on screen does not change;
 *   - the request is strict: a malformed capability is never sent;
 *   - the thread screen offers it only on the caller's own, live message that is not a forward, whose
 *     capability the server served, through offersForward (forwarding on, affirmatively not E2EE).
 *
 * MUTANTS (tgprod/mutants-b3.txt): FR1 the sheet shows the request, not the read-back; FR2 a refusal
 * still changes the mark; FR3 offered on a forward; FR4 offered on someone else's message.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — lib/supabase builds a client at import time, which fails outside an
// Expo runtime. The sheet reads only this name.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the sheet reads one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));

import { FORWARDING_RULES, ForwardingRuleSheet, setForwardingRule } from '../forwarding/ForwardingRuleSheet.tsx';

const realFetch = global.fetch;
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });

function answering(status: number, body: unknown) {
  const calls: any[] = [];
  global.fetch = jest.fn(async (url: any, init: any) => { calls.push({ url, method: init.method, body: JSON.parse(init.body) }); return { ok: status < 300, status, json: async () => body } as Response; }) as typeof fetch;
  return calls;
}

describe('ForwardingRuleSheet', () => {
  it('offers the four rules in words, the one in force marked', async () => {
    await render(<ForwardingRuleSheet visible threadId="t-1" messageId="m-1" current="SOURCE_POLICY" onClose={() => {}} />);
    for (const r of FORWARDING_RULES) expect(screen.getByTestId(`forwarding-rule-${r.capability}`)).toBeTruthy();
    expect(screen.getByTestId('forwarding-rule-SOURCE_POLICY').props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('Nobody can forward it, including you.')).toBeTruthy();
  });

  it('sends the choice once, and shows what the server READ BACK', async () => {
    // Asked for NO_FORWARD; the server stored EXPIRES_WITH_SOURCE — the sheet must show what is stored.
    const calls = answering(200, { messageId: 'm-1', capability: 'EXPIRES_WITH_SOURCE' });
    const onSaved = jest.fn();
    await render(<ForwardingRuleSheet visible threadId="t-1" messageId="m-1" current="SOURCE_POLICY" onClose={() => {}} onSaved={onSaved} />);
    await fireEvent.press(screen.getByTestId('forwarding-rule-NO_FORWARD'));
    expect(calls).toEqual([{ url: 'https://api.test/api/threads/t-1/messages/m-1/content-capability', method: 'PUT', body: { capability: 'NO_FORWARD' } }]);
    expect((await screen.findByTestId('forwarding-rule-EXPIRES_WITH_SOURCE')).props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('forwarding-rule-NO_FORWARD').props.accessibilityState.selected).toBe(false);
    expect(onSaved).toHaveBeenCalledWith('EXPIRES_WITH_SOURCE');
  });

  it('a refusal is the server\'s sentence, and the mark does not move', async () => {
    answering(403, { error: 'forbidden', message: 'A forwarded message keeps the forwarding rule it was shared under.' });
    await render(<ForwardingRuleSheet visible threadId="t-1" messageId="m-1" current="ALLOW" onClose={() => {}} />);
    await fireEvent.press(screen.getByTestId('forwarding-rule-NO_FORWARD'));
    expect((await screen.findByTestId('forwarding-rule-error')).props.children).toBe('A forwarded message keeps the forwarding rule it was shared under.');
    expect(screen.getByTestId('forwarding-rule-ALLOW').props.accessibilityState.selected).toBe(true);
  });

  it('a malformed capability is never sent; a read-back that is not a capability is not a success', async () => {
    const calls = answering(200, { capability: 'EVERYONE' });
    expect((await setForwardingRule('t-1', 'm-1', 'EVERYONE' as any)).ok).toBe(false);
    expect(calls.length).toBe(0);
    expect((await setForwardingRule('t-1', 'm-1', 'ALLOW')).ok).toBe(false);
  });
});

describe('the thread screen', () => {
  const src = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('offers the rule only on the caller\'s own live message that is not a forward, with a served capability, through offersForward', () => {
    expect(src).toMatch(/\.\.\.\(onForwardingRule && mine && !message\.deleted && !\(message as any\)\.forwarded && isContentCapability\(\(message as any\)\.contentCapability\) \? \[\['forwarding-rule', 'Who can forward this'/);
    expect(src).toMatch(/onForwardingRule=\{offersForward\(flagEnabled\(FORWARDING_FLAG\), conversationProjection\) \?/);
    expect(src).toMatch(/<ForwardingRuleSheet visible=\{ruleMsg !== null\}/);
  });
});
