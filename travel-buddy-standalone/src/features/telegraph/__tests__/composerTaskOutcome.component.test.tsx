/**
 * census-input-intelligence G320 — `downstream_task_completed` from the Telegraph
 * composer: the suggestion it ACCEPTED is reported when the send it served
 * answers. Driven through the REAL reporter (`reportServedTask` →
 * `reportInputTaskOutcome`), the REAL consent gate and a telemetry sink spy, as
 * the trip and event suites are.
 *
 *   O1–O7  the composer's rules: a New Telegraph pick is held for its thread and
 *          reported on that thread's send (credit on success only; a refused
 *          send keeps the hold for the retry; another thread or an old hold
 *          reports nothing); a "meet at" pre-filled location send reports the
 *          event with no credit; nothing at all without consent.
 *   N1     the real New Telegraph screen holds the pick it opened.
 *   W1     the thread screen reports on every send path, and only a sheet the
 *          bar pre-filled counts as served by it.
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  applyOutcomeConsent,
  beginOutcomeAccount,
  setOutcomePoster,
  type TaskOutcomeBody,
} from '../../../platform/input-assistance/services/outcomeLearning.ts';
import { resetTelemetrySink, setTelemetrySink, type InputTelemetryEvent } from '../../../platform/input-assistance/services/inputTelemetry.ts';
import {
  HOLD_MS,
  _resetComposerOutcomesForTests,
  holdRecipientPick,
  meetAtServed,
  recipientServed,
  reportMeetAtSend,
  reportThreadSend,
} from '../composer/composerTaskOutcome.ts';

const mockReplace = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigation container.
jest.mock('expo-router', () => ({
  router: { replace: (...a: unknown[]) => mockReplace(...a), push: jest.fn(), back: jest.fn() },
}));
// NOTE: intentionally exhaustive — the screen reads insets; no native provider here.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
const mockOpenDirect = jest.fn();
jest.mock('../../../services/messaging', () => ({
  ...jest.requireActual('../../../services/messaging'),
  openDirectThread: (...a: unknown[]) => mockOpenDirect(...a),
}));
const mockRecordPick = jest.fn();
// NOTE: intentionally exhaustive — the recipient hook calls the gateway; here it
// answers one person, as the gateway would.
jest.mock('../../../hooks/useTelegraphRecipients', () => ({
  useTelegraphRecipients: () => ({
    recipients: [{ userId: 'u-ana', name: 'Ana', handle: 'ana', avatarUrl: null, reason: 'Recent', subtitle: null }],
    loading: false,
    unavailable: false,
    recordPick: (...a: unknown[]) => mockRecordPick(...a),
  }),
}));

const THREAD = 'dddddddd-0000-4000-8000-00000000000d';
let events: InputTelemetryEvent[] = [];
let posts: TaskOutcomeBody[] = [];
const outcomes = () => events.filter((e) => e.name === 'downstream_task_completed');

function consent(granted: boolean) {
  beginOutcomeAccount('user-1');
  if (granted) applyOutcomeConsent('user-1', true);
}

beforeEach(() => {
  events = [];
  posts = [];
  _resetComposerOutcomesForTests();
  setTelemetrySink((e) => { events.push(e); });
  setOutcomePoster(async (b) => { posts.push(b); return true; });
  mockReplace.mockReset();
  mockOpenDirect.mockReset();
});
afterEach(() => {
  resetTelemetrySink();
  setOutcomePoster(null);
  beginOutcomeAccount(null);
});

describe('G320 — the composer\'s outcome rules', () => {
  it('O1 the recipient pick credits the person; the "meet at" field credits nothing', () => {
    expect(recipientServed('u-ana')).toEqual({ field: { fieldId: 'telegraph.recipient', context: 'telegraph_recipient' }, entities: [{ entityType: 'user', entityId: 'u-ana' }] });
    expect(recipientServed('  ')).toBeNull();
    expect(meetAtServed()).toEqual({ field: { fieldId: 'telegraph.message', context: 'telegraph_message' }, entities: [] });
  });

  it('O2 a held pick is reported once, on its thread\'s successful send, with the credit', () => {
    consent(true);
    holdRecipientPick(THREAD, recipientServed('u-ana'), 1_000);
    expect(reportThreadSend(THREAD, true, 2_000)).toBe(1);
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({ fieldId: 'telegraph.recipient', context: 'telegraph_recipient' });
    expect(JSON.stringify(outcomes()[0])).toContain('message_sent');
    expect(posts).toEqual([{ context: 'telegraph_recipient', fieldId: 'telegraph.recipient', task: 'message_sent', ok: true, entities: [{ entityType: 'user', entityId: 'u-ana' }] }]);
    expect(reportThreadSend(THREAD, true, 3_000)).toBe(0); // the hold ended with the task
    expect(outcomes()).toHaveLength(1);
  });

  it('O3 a refused send reports ok:false and credits nothing; the retry\'s success reports ok:true', () => {
    consent(true);
    holdRecipientPick(THREAD, recipientServed('u-ana'), 1_000);
    expect(reportThreadSend(THREAD, false, 2_000)).toBe(1);
    expect(posts).toEqual([]);
    expect(reportThreadSend(THREAD, true, 3_000)).toBe(1);
    expect(outcomes()).toHaveLength(2);
    expect(posts).toHaveLength(1);
  });

  it('O4 without consent: nothing is emitted and nothing is posted', () => {
    consent(false);
    holdRecipientPick(THREAD, recipientServed('u-ana'), 1_000);
    expect(reportThreadSend(THREAD, true, 2_000)).toBe(0);
    expect(reportMeetAtSend(true)).toBe(0);
    expect(events).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('O5 another thread\'s send, or a send after the hold expired, reports nothing', () => {
    consent(true);
    holdRecipientPick(THREAD, recipientServed('u-ana'), 1_000);
    expect(reportThreadSend('another-thread', true, 2_000)).toBe(0);
    expect(reportThreadSend(THREAD, true, 1_000 + HOLD_MS + 1)).toBe(0);
    expect(reportThreadSend(THREAD, true, 1_000 + HOLD_MS + 2)).toBe(0); // and it is gone
    expect(outcomes()).toEqual([]);
  });

  it('O6 a "meet at" pre-filled location send reports the event and credits nothing', () => {
    consent(true);
    expect(reportMeetAtSend(true)).toBe(1);
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({ fieldId: 'telegraph.message', context: 'telegraph_message' });
    expect(posts).toEqual([]);
  });

  it('O7 nothing held, nothing reported (an ordinary send)', () => {
    consent(true);
    expect(reportThreadSend(THREAD, true, 1)).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('G320 — the real New Telegraph screen', () => {
  it('N1 picking a person holds the pick for the thread it opened; that thread\'s first send reports it', async () => {
    consent(true);
    mockOpenDirect.mockResolvedValue({ ok: true, data: { threadId: THREAD } });
    const NewTelegraphScreen = require('../../../../app/telegraph/new.tsx').default;
    await render(<NewTelegraphScreen />);
    await fireEvent.press(screen.getByLabelText('Message Ana'));
    expect(mockOpenDirect).toHaveBeenCalledWith('u-ana');
    expect(mockReplace).toHaveBeenCalled();
    expect(reportThreadSend(THREAD, true)).toBe(1);
    expect(posts).toEqual([{ context: 'telegraph_recipient', fieldId: 'telegraph.recipient', task: 'message_sent', ok: true, entities: [{ entityType: 'user', entityId: 'u-ana' }] }]);
  });

  it('N2 a pick that could not open a thread holds nothing', async () => {
    consent(true);
    mockOpenDirect.mockResolvedValue({ ok: false, data: null });
    const NewTelegraphScreen = require('../../../../app/telegraph/new.tsx').default;
    await render(<NewTelegraphScreen />);
    await fireEvent.press(screen.getByLabelText('Message Ana'));
    expect(reportThreadSend(THREAD, true)).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('G320 — the thread screen reports on every send path', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('W1 text, media and typed sends report a held pick; only a bar-pre-filled location sheet reports the "meet at" field', () => {
    expect(src).toMatch(/if \(!res\?\.ok\) setSendFailed\(true\); reportThreadSend\(id, !!res\?\.ok\);/); // text
    expect(src).toMatch(/reportThreadSend\(id, res\.ok\); if \(res\.ok\) \{/); // media
    expect(src).toMatch(/const res = await sendTypedMessage\(id, kind, payload\); if \(servedByMeetAt\) reportMeetAtSend\(res\.ok\); reportThreadSend\(id, res\.ok\);/); // typed
    expect(src).toMatch(/const servedByMeetAt = locationDraft !== null;/);
    // locationDraft has exactly one non-null writer: the bar's pick.
    expect(src.match(/setLocationDraft\((?!null\))/g)).toEqual(['setLocationDraft(']);
    expect(src).toMatch(/onPick=\{\(d\) => \{ setLocationDraft\(d\);/);
  });
});
