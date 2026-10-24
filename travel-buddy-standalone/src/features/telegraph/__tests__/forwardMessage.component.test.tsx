/**
 * census-telegraph T406 — "Forward" from a message's action sheet, client side.
 *
 * Pins:
 *   - the sheet tells the person what the new audience will and will not see, before they pick;
 *   - it lists the caller's OTHER live conversations (never the source, never an archived one);
 *   - a failed list read offers nothing and says so (never "you have no other conversations");
 *   - picking one forwards exactly that message into exactly that conversation, once;
 *   - "Forwarded" is said only after the server answered; a refusal is the server's sentence;
 *   - the thread screen offers Forward only with the flag on and a conversation affirmatively not E2EE,
 *     and the sheet forwards the message the action sheet was opened on.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('../../../services/messaging.ts', () => ({ ...jest.requireActual('../../../services/messaging.ts'), getMyThreads: jest.fn() }));
jest.mock('../forwarding/forwardApi.ts', () => {
  const actual = jest.requireActual('../forwarding/forwardApi.ts');
  return { ...actual, forwardMessage: jest.fn() };
});

import { ForwardSheet, FORWARD_AUDIENCE_COPY, threadLabel } from '../forwarding/ForwardSheet.tsx';
import { forwardMessage, forwardTargets } from '../forwarding/forwardApi.ts';
import { getMyThreads } from '../../../services/messaging.ts';
import { offersForward } from '../conversation/conversationProjection.ts';

const mockedThreads = getMyThreads as jest.MockedFunction<typeof getMyThreads>;
const mockedForward = forwardMessage as jest.MockedFunction<typeof forwardMessage>;

const SRC = 'th-src';
const MSG = 'msg-1';
function thread(id: string, over: Record<string, unknown> = {}): any {
  return { id, threadType: 'direct', tripId: null, circleOwnerId: null, title: null, status: 'active', lastMessageAt: null, createdAt: '', mutedAt: null, archivedAt: null, otherMembers: [{ id: `${id}-o`, handle: id, name: `Name ${id}`, avatarUrl: null }], lastMessagePreview: null, ...over };
}

beforeEach(() => {
  mockedThreads.mockReset();
  mockedForward.mockReset();
  mockedThreads.mockResolvedValue({ ok: true, data: { threads: [thread(SRC), thread('th-a'), thread('th-b', { archivedAt: '2026-10-01T00:00:00Z' })] } } as any);
});

describe('ForwardSheet', () => {
  it('says what the new audience sees, and lists only the OTHER live conversations', async () => {
    await render(<ForwardSheet visible sourceThreadId={SRC} sourceMessageId={MSG} onClose={() => {}} />);
    expect(screen.getByTestId('forward-audience-copy').props.children).toBe(FORWARD_AUDIENCE_COPY);
    expect(await screen.findByTestId('forward-target-th-a')).toBeTruthy();
    expect(screen.queryByTestId(`forward-target-${SRC}`)).toBeNull();
    expect(screen.queryByTestId('forward-target-th-b')).toBeNull();
  });

  it('forwards exactly that message into exactly that conversation, once, and only then says Forwarded', async () => {
    mockedForward.mockResolvedValue({ ok: true, messageId: 'copy-1', provenance: 'FORWARDED' });
    const onForwarded = jest.fn();
    await render(<ForwardSheet visible sourceThreadId={SRC} sourceMessageId={MSG} onClose={() => {}} onForwarded={onForwarded} />);
    expect(screen.queryByTestId('forward-done')).toBeNull();
    await fireEvent.press(await screen.findByTestId('forward-target-th-a'));
    expect(mockedForward).toHaveBeenCalledTimes(1);
    expect(mockedForward).toHaveBeenCalledWith('th-a', MSG);
    expect(await screen.findByTestId('forward-done')).toBeTruthy();
    expect(onForwarded).toHaveBeenCalledWith('th-a');
  });

  it('a refusal is the server sentence, and nothing says Forwarded', async () => {
    mockedForward.mockResolvedValue({ ok: false, error: 'forbidden', message: "This message can't be forwarded." });
    await render(<ForwardSheet visible sourceThreadId={SRC} sourceMessageId={MSG} onClose={() => {}} />);
    await fireEvent.press(await screen.findByTestId('forward-target-th-a'));
    expect((await screen.findByTestId('forward-error')).props.children).toBe("This message can't be forwarded.");
    expect(screen.queryByTestId('forward-done')).toBeNull();
  });

  it('a failed list read offers nothing and says so — it is not "no other conversations"', async () => {
    mockedThreads.mockResolvedValue({ ok: false, data: null, errorKind: 'db_error' } as any);
    await render(<ForwardSheet visible sourceThreadId={SRC} sourceMessageId={MSG} onClose={() => {}} />);
    expect(await screen.findByTestId('forward-list-error')).toBeTruthy();
    expect(screen.queryByTestId('forward-none')).toBeNull();
    expect(screen.queryByTestId('forward-target-th-a')).toBeNull();
  });
});

describe('pure parts', () => {
  it('forwardTargets drops the source and anything not live', () => {
    const out = forwardTargets([thread(SRC), thread('a'), thread('b', { status: 'archived' }), thread('c', { archivedAt: 'x' })], SRC);
    expect(out.map((t: any) => t.id)).toEqual(['a']);
  });
  it('threadLabel: the title, else the other people, else a plain word', () => {
    expect(threadLabel(thread('x', { title: ' Crew ' }))).toBe('Crew');
    expect(threadLabel(thread('y'))).toBe('Name y');
    expect(threadLabel(thread('z', { otherMembers: [] }))).toBe('Conversation');
  });
  it('offersForward: flag on AND affirmatively not E2EE AND not degraded', () => {
    const ready = (isE2ee: boolean | null, degraded = false) => ({ status: 'ready' as const, canSendMessage: true, degraded, memberCount: 2, isE2ee });
    expect(offersForward(true, ready(false))).toBe(true);
    expect(offersForward(false, ready(false))).toBe(false);
    expect(offersForward(true, ready(true))).toBe(false);
    expect(offersForward(true, ready(null))).toBe(false);
    expect(offersForward(true, ready(false, true))).toBe(false);
    expect(offersForward(true, { status: 'loading' })).toBe(false);
  });
});

describe('the thread screen', () => {
  const src = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('offers Forward only through offersForward(flag, projection) and forwards the opened message', () => {
    expect(src).toMatch(/onForward=\{offersForward\(flagEnabled\(FORWARDING_FLAG\), conversationProjection\) \? \(m\) => \{ setActionMsg\(null\); setForwardMsgId\(m\.id\); \} : undefined\}/);
    expect(src).toMatch(/\.\.\.\(onForward && !message\.deleted \? \[\['forward', 'Forward', ArrowRight\]\] : \[\]\)/);
    expect(src).toMatch(/else if \(key === 'forward'\) onForward\?\.\(message\);/);
    expect(src).toMatch(/<ForwardSheet visible=\{forwardMsgId !== null\} sourceThreadId=\{id \?\? null\} sourceMessageId=\{forwardMsgId\}/);
  });
});
