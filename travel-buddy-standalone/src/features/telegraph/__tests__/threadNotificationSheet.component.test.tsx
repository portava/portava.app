/**
 * census-telegraph T398 — the per-thread notification choice, client side.
 *
 * Pins: only the choices the SERVER says it can store are offered; a choice is
 * sent once and the sheet then shows what the server READ BACK; a refused save
 * says so and changes nothing; a failed read offers no choices at all; the
 * safety line is always there. And the thread screen mounts the sheet from a
 * long-press on its mute icon (source-level: the screen does not mount under
 * jest-expo).
 *
 * SHOWN RED (T2 lane report): rendering the four levels regardless of
 * `levelsAvailable` turns the flag-off case red; setting the shown level from
 * the REQUEST instead of the answer turns the read-back case red.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: the real module reaches lib/supabase, which builds a client at import
// time. The sheet under test is REAL; only the two network calls are stubbed.
jest.mock('../settings/threadNotificationApi.ts', () => {
  const actual = jest.requireActual('../settings/threadNotificationApi.ts');
  return { ...actual, fetchThreadNotificationPolicy: jest.fn(), setThreadNotificationPolicy: jest.fn() };
});

import { ThreadNotificationSheet } from '../settings/ThreadNotificationSheet.tsx';
import {
  SAFETY_COPY,
  fetchThreadNotificationPolicy,
  setThreadNotificationPolicy,
  type ThreadNotificationPolicy,
} from '../settings/threadNotificationApi.ts';

const mockedFetch = fetchThreadNotificationPolicy as jest.MockedFunction<typeof fetchThreadNotificationPolicy>;
const mockedSet = setThreadNotificationPolicy as jest.MockedFunction<typeof setThreadNotificationPolicy>;
const T = 't-1';

function policy(over: Partial<ThreadNotificationPolicy> = {}): ThreadNotificationPolicy {
  return {
    threadId: T, level: 'ALL', mutedUntil: null, temporaryMuteActive: false,
    levelsAvailable: ['ALL', 'MUTED'], temporaryMuteAvailable: false, temporaryMuteMinutes: [],
    safetyAlwaysDelivers: true, ...over,
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockedSet.mockReset();
});

describe('ThreadNotificationSheet', () => {
  it('flag off: offers only All and Muted, no temporary mute, and the safety line', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: policy() });
    await render(<ThreadNotificationSheet visible threadId={T} onClose={() => {}} />);
    expect(await screen.findByTestId('thread-notification-level-ALL')).toBeTruthy();
    expect(screen.getByTestId('thread-notification-level-MUTED')).toBeTruthy();
    expect(screen.queryByTestId('thread-notification-level-MENTIONS')).toBeNull();
    expect(screen.queryByTestId('thread-notification-level-IMPORTANT')).toBeNull();
    expect(screen.queryByTestId('thread-notification-mute-60')).toBeNull();
    expect(screen.getByText(SAFETY_COPY)).toBeTruthy();
  });

  it('flag on: all four levels and the temporary mutes the server lists', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: policy({
      levelsAvailable: ['ALL', 'MENTIONS', 'IMPORTANT', 'MUTED'], temporaryMuteAvailable: true, temporaryMuteMinutes: [15, 60],
    }) });
    await render(<ThreadNotificationSheet visible threadId={T} onClose={() => {}} />);
    expect(await screen.findByTestId('thread-notification-level-MENTIONS')).toBeTruthy();
    expect(screen.getByTestId('thread-notification-level-IMPORTANT')).toBeTruthy();
    expect(screen.getByTestId('thread-notification-mute-60')).toBeTruthy();
    expect(screen.queryByTestId('thread-notification-mute-480')).toBeNull();
  });

  it('a choice is sent once, and the sheet shows what the server READ BACK', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: policy() });
    // The server answers ALL although MUTED was asked: the sheet must show ALL.
    mockedSet.mockResolvedValue({ ok: true, data: policy({ level: 'ALL' }) });
    const onChanged = jest.fn();
    await render(<ThreadNotificationSheet visible threadId={T} onClose={() => {}} onChanged={onChanged} />);
    await fireEvent.press(await screen.findByTestId('thread-notification-level-MUTED'));
    expect(mockedSet).toHaveBeenCalledTimes(1);
    expect(mockedSet).toHaveBeenCalledWith(T, 'MUTED', null);
    expect(await screen.findByText('All activity ✓')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ level: 'ALL' }));
  });

  it('a refused save says so and changes nothing on screen', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: policy() });
    mockedSet.mockResolvedValue({ ok: false, error: 'feature_disabled', message: 'Only All and Muted are available.' });
    const onChanged = jest.fn();
    await render(<ThreadNotificationSheet visible threadId={T} onClose={() => {}} onChanged={onChanged} />);
    await fireEvent.press(await screen.findByTestId('thread-notification-level-MUTED'));
    expect(await screen.findByTestId('thread-notification-save-error')).toBeTruthy();
    expect(screen.getByText('All activity ✓')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a failed read offers NO choices — only the reason and Try again', async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: 'degraded_unavailable', message: 'We could not read this setting.' });
    await render(<ThreadNotificationSheet visible threadId={T} onClose={() => {}} />);
    expect(await screen.findByTestId('thread-notification-error')).toBeTruthy();
    expect(screen.queryByTestId('thread-notification-level-ALL')).toBeNull();
    expect(screen.getByText(SAFETY_COPY)).toBeTruthy();
  });
});

describe('the thread screen opens it', () => {
  const src = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('from a long-press on the mute icon, and mirrors the stored level on the icon', () => {
    expect(src).toMatch(/onLongPress=\{\(\) => setShowNotificationSheet\(true\)\}/);
    expect(src).toMatch(/<ThreadNotificationSheet visible=\{showNotificationSheet\} threadId=\{id \?\? null\}/);
    expect(src).toMatch(/onChanged=\{\(p\) => setThreadIsMuted\(p\.level === 'MUTED'\)\}/);
  });
});
