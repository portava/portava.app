/**
 * census-telegraph T417 — §30A.12 large-group controls, client side.
 *
 * Pins:
 *   - a HOST sees the four controls; a change is sent once and the sheet shows what the server READ BACK;
 *   - a refused save says so and nothing changes on screen;
 *   - a MEMBER is shown what is on and their own mute, and is offered no control to press;
 *   - a failed read shows no controls (an unreadable setting is not "no settings");
 *   - the wire is parsed strictly: an answer that is not controls is not guessed into defaults;
 *   - the thread screen offers the sheet only on a controlled conversation with the flag on, offers
 *     mute/remove on another member's message only to a host (and remove only in a `group`), and asks
 *     the server who is a host.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('../groups/groupControlsApi.ts', () => {
  const actual = jest.requireActual('../groups/groupControlsApi.ts');
  return { ...actual, fetchGroupControls: jest.fn(), setGroupControls: jest.fn() };
});

import { GroupControlsSheet, activeControlLines } from '../groups/GroupControlsSheet.tsx';
import { fetchGroupControls, parseControls, setGroupControls, type GroupControls } from '../groups/groupControlsApi.ts';

const mockedFetch = fetchGroupControls as jest.MockedFunction<typeof fetchGroupControls>;
const mockedSet = setGroupControls as jest.MockedFunction<typeof setGroupControls>;
const T = 'grp-1';
const OPEN: GroupControls = { slowModeSeconds: 0, postingPolicy: 'everyone', mediaPolicy: 'everyone', linkPolicy: 'everyone' };

beforeEach(() => {
  mockedFetch.mockReset();
  mockedSet.mockReset();
});

describe('GroupControlsSheet — a host', () => {
  it('shows the four controls; a change is sent once, and the sheet shows what the server READ BACK', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: { controls: OPEN, isHost: true, mutedUntil: null } });
    // Asked for 5 minutes; the server stored 1 minute — the sheet must show 1 minute.
    mockedSet.mockResolvedValue({ ok: true, data: { ...OPEN, slowModeSeconds: 60 } });
    await render(<GroupControlsSheet visible threadId={T} onClose={() => {}} />);
    expect(await screen.findByTestId('group-controls-host')).toBeTruthy();
    expect(screen.getByTestId('group-controls-linkPolicy-hosts_only')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('group-controls-slow-300'));
    expect(mockedSet).toHaveBeenCalledTimes(1);
    expect(mockedSet).toHaveBeenCalledWith(T, { slowModeSeconds: 300 });
    expect(await screen.findByText('1 min ✓')).toBeTruthy();
    expect(screen.queryByText('5 min ✓')).toBeNull();
  });

  it('a refused save says so, and nothing changes on screen', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: { controls: OPEN, isHost: true, mutedUntil: null } });
    mockedSet.mockResolvedValue({ ok: false, error: 'forbidden', message: 'Only a host can change this' });
    await render(<GroupControlsSheet visible threadId={T} onClose={() => {}} />);
    await fireEvent.press(await screen.findByTestId('group-controls-postingPolicy-hosts_only'));
    expect((await screen.findByTestId('group-controls-save-error')).props.children).toBe('Only a host can change this');
    expect(screen.getByTestId('group-controls-postingPolicy-everyone').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('group-controls-postingPolicy-hosts_only').props.accessibilityState.selected).toBe(false);
  });
});

describe('GroupControlsSheet — a member', () => {
  it('is told what is on and their own mute, and is offered nothing to press', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: { controls: { ...OPEN, slowModeSeconds: 60, linkPolicy: 'hosts_only' }, isHost: false, mutedUntil: 'indefinite' } });
    await render(<GroupControlsSheet visible threadId={T} onClose={() => {}} />);
    expect(await screen.findByTestId('group-controls-member')).toBeTruthy();
    expect(screen.getByText('Slow mode: one message every 1 min')).toBeTruthy();
    expect(screen.getByText('Only hosts send links')).toBeTruthy();
    expect(screen.getByTestId('group-controls-own-mute')).toBeTruthy();
    expect(screen.queryByTestId('group-controls-slow-0')).toBeNull();
    expect(screen.queryByTestId('group-controls-linkPolicy-everyone')).toBeNull();
  });

  it('with nothing on, says so in words', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: { controls: OPEN, isHost: false, mutedUntil: null } });
    await render(<GroupControlsSheet visible threadId={T} onClose={() => {}} />);
    expect(await screen.findByTestId('group-controls-none')).toBeTruthy();
  });
});

describe('GroupControlsSheet — a failed read', () => {
  it('shows the reason and Try again, and no controls at all', async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: 'degraded_unavailable', message: 'We could not read this conversation\'s settings right now.' });
    await render(<GroupControlsSheet visible threadId={T} onClose={() => {}} />);
    expect(await screen.findByTestId('group-controls-error')).toBeTruthy();
    expect(screen.queryByTestId('group-controls-host')).toBeNull();
    expect(screen.queryByTestId('group-controls-member')).toBeNull();
  });
});

describe('pure parts', () => {
  it('activeControlLines names exactly what is on', () => {
    expect(activeControlLines(OPEN)).toEqual([]);
    expect(activeControlLines({ ...OPEN, postingPolicy: 'hosts_only', mediaPolicy: 'hosts_only' })).toEqual(['Only hosts post', 'Only hosts send media']);
  });
  it('parseControls refuses anything that is not controls, never filling in defaults', () => {
    expect(parseControls(OPEN)).toEqual(OPEN);
    expect(parseControls(null)).toBeNull();
    expect(parseControls({ ...OPEN, postingPolicy: 'admins' })).toBeNull();
    expect(parseControls({ ...OPEN, slowModeSeconds: -1 })).toBeNull();
    expect(parseControls({ postingPolicy: 'everyone' })).toBeNull();
  });
});

describe('the thread screen', () => {
  const src = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('offers the sheet only on a controlled conversation with the flag on', () => {
    expect(src).toMatch(/\{GROUP_CONTROLLED_THREAD_TYPES\.includes\(threadType \?\? ''\) && flagEnabled\(GROUP_CONTROLS_FLAG\) \? \(<Pressable[^>]*testID="thread-group-controls"[^>]*onPress=\{\(\) => setShowGroupControls\(true\)\}/);
    expect(src).toMatch(/<GroupControlsSheet visible=\{showGroupControls\} threadId=\{id \?\? null\}/);
  });
  it('offers mute/remove only to a host the SERVER named, and remove only in a group', () => {
    expect(src).toMatch(/onModerate=\{groupHost && GROUP_CONTROLLED_THREAD_TYPES\.includes\(threadType \?\? ''\) && flagEnabled\(GROUP_CONTROLS_FLAG\) \?/);
    expect(src).toMatch(/canRemoveMember=\{threadType === 'group'\}/);
    expect(src).toMatch(/void fetchGroupControls\(id\)\.then\(\(r\) => \{ if \(live\) setGroupHost\(r\.ok && r\.data\.isHost\); \}\)/);
    expect(src).toMatch(/\.\.\.\(!mine && onModerate \? \[\['mute-member', 'Mute in this conversation', VolumeX\]\] : \[\]\), \.\.\.\(!mine && onModerate && canRemoveMember \? \[\['remove-member'/);
  });
});
