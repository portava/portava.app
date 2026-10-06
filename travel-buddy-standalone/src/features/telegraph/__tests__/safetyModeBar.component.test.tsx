/**
 * Telegraph §15.2 — census-telegraph T218: while the conversation's safety mode
 * is raised, the affordances §15.2 names are PROMOTED, in the order the server
 * served them, and entertainment is put out of the way.
 *
 * Asserted as what a person sees and what each control does, plus the refusal
 * side: NORMAL draws nothing, an affordance the screen cannot perform is not
 * drawn, an unknown id is not guessed at, a failed status post says so, and a
 * failed REFRESH does not take a raised bar down.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — expo-router's navigator is not mounted under jest;
// the test asserts WHERE the bar sends a person.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

// NOTE: intentional stub — kindsApi reaches lib/supabase at import time.
jest.mock('../kinds/kindsApi.ts', () => ({
  sendTypedMessage: jest.fn(async () => ({ ok: true, data: { id: 's1', msgType: 'safety', subtype: null } })),
}));

// NOTE: intentional stub — safetyModeApi reaches lib/supabase at import time.
// The mode predicates are the real ones; only the network read is replaced.
jest.mock('../safety/safetyModeApi.ts', () => {
  const actual = jest.requireActual('../safety/safetyModeApi.ts');
  return { ...actual, fetchSafetyMode: jest.fn() };
});

// NOTE: intentional stub — both sheets reach services that build a Supabase
// client at import time. Each stub renders whether the bar opened it.
jest.mock('../../../components/safeReturn/EmergencyHelpSheet.tsx', () => {
  const { View } = require('react-native');
  return { EmergencyHelpSheet: (p: { visible: boolean }) => (p.visible ? <View testID="emergency-help-sheet" /> : null) };
});
jest.mock('../../../components/safeReturn/SafeReturnSetupSheet.tsx', () => {
  const { View } = require('react-native');
  return { SafeReturnSetupSheet: (p: { visible: boolean }) => (p.visible ? <View testID="safe-return-sheet" /> : null) };
});

import { router } from 'expo-router';
import { SafetyModeBar, EMERGENCY_CONTACTS_ROUTE } from '../safety/SafetyModeBar.tsx';
import { fetchSafetyMode, type SafetyModeResponse } from '../safety/safetyModeApi.ts';
import { sendTypedMessage } from '../kinds/kindsApi.ts';

const mockedFetch = fetchSafetyMode as jest.MockedFunction<typeof fetchSafetyMode>;
const mockedSend = sendTypedMessage as jest.MockedFunction<typeof sendTypedMessage>;
const mockedPush = (router as unknown as { push: jest.Mock }).push;

const PROMOTED = ['TRUSTED_CONTACT', 'CURRENT_STATUS', 'OFFICIAL_HELP', 'ROUTE_OR_RETURN', 'CALL', 'BLOCK_OR_REPORT', 'LOCATION_SCOPE'];

function resp(over: Partial<SafetyModeResponse> = {}): SafetyModeResponse {
  return {
    threadId: 't1',
    generatedAt: 'x',
    mode: 'SAFETY_EVENT',
    since: 'x',
    raisedBy: 'u2',
    clearedAt: null,
    reason: 'Someone in this conversation said they need help.',
    affordances: { promoted: PROMOTED, deprioritized: ['ENTERTAINMENT'] },
    derivedFrom: 'THREAD_SAFETY_SIGNALS_ONLY',
    ...over,
  };
}

const handlers = () => ({ onCall: jest.fn(), onBlockOrReport: jest.fn(), onLocationScope: jest.fn() });

function renderedAffordanceOrder(): string[] {
  return screen
    .queryAllByTestId(/^telegraph-safety-affordance-/)
    .map((n: any) => String(n.props.testID).replace('telegraph-safety-affordance-', ''));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('NORMAL promotes nothing', () => {
  it('a calm conversation draws no bar, and the screen is told nothing is raised', async () => {
    const onModeChange = jest.fn();
    await render(<SafetyModeBar threadId="t1" initialResponse={resp({ mode: 'NORMAL', affordances: { promoted: [], deprioritized: [] } })} onModeChange={onModeChange} />);
    expect(screen.queryByTestId('telegraph-safety-mode-bar')).toBeNull();
    expect(onModeChange).toHaveBeenLastCalledWith({ raised: false, deprioritizeEntertainment: false });
  });
});

describe('a raised mode promotes §15.2’s affordances in the SERVED order', () => {
  it('all seven are drawn, top to bottom, exactly as the server listed them', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={resp()} {...handlers()} />);
    expect(screen.getByTestId('telegraph-safety-mode-bar')).toBeTruthy();
    expect(screen.getByText('Someone asked for help')).toBeTruthy();
    expect(renderedAffordanceOrder()).toEqual([
      'TRUSTED_CONTACT', 'CURRENT_STATUS-ok', 'CURRENT_STATUS-help', 'OFFICIAL_HELP', 'ROUTE_OR_RETURN', 'CALL', 'BLOCK_OR_REPORT', 'LOCATION_SCOPE',
    ]);
  });

  it('the order is the server’s, not a hard-coded one: a reversed list renders reversed', async () => {
    await render(
      <SafetyModeBar threadId="t1" initialResponse={resp({ affordances: { promoted: [...PROMOTED].reverse(), deprioritized: [] } })} {...handlers()} />,
    );
    expect(renderedAffordanceOrder()[0]).toBe('LOCATION_SCOPE');
    expect(renderedAffordanceOrder().slice(-1)[0]).toBe('TRUSTED_CONTACT');
  });

  it('an affordance id this build does not know is skipped, not guessed at', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={resp({ affordances: { promoted: ['TELEPORT', 'CALL'], deprioritized: [] } })} {...handlers()} />);
    expect(renderedAffordanceOrder()).toEqual(['CALL']);
  });

  it('a heads-up (SAFETY_ATTENTION) is worded as one, not as a call for help', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={resp({ mode: 'SAFETY_ATTENTION' })} />);
    expect(screen.getByText('Safety heads-up')).toBeTruthy();
  });
});

describe('each promoted control does what it says', () => {
  it('Call, Block or report and Share location call the screen; with no callback they are not drawn', async () => {
    const h = handlers();
    const { rerender } = await render(<SafetyModeBar threadId="t1" initialResponse={resp()} {...h} />);
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-CALL'));
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-BLOCK_OR_REPORT'));
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-LOCATION_SCOPE'));
    expect(h.onCall).toHaveBeenCalledTimes(1);
    expect(h.onBlockOrReport).toHaveBeenCalledTimes(1);
    expect(h.onLocationScope).toHaveBeenCalledTimes(1);

    await rerender(<SafetyModeBar threadId="t1" initialResponse={resp()} />);
    expect(screen.queryByTestId('telegraph-safety-affordance-CALL')).toBeNull();
    expect(screen.queryByTestId('telegraph-safety-affordance-BLOCK_OR_REPORT')).toBeNull();
    expect(screen.queryByTestId('telegraph-safety-affordance-LOCATION_SCOPE')).toBeNull();
  });

  it('Trusted contacts opens the emergency-contacts screen', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={resp()} />);
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-TRUSTED_CONTACT'));
    expect(mockedPush).toHaveBeenCalledWith(EMERGENCY_CONTACTS_ROUTE);
  });

  it('Emergency help opens the emergency sheet; Safe Return opens the setup sheet', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={resp()} />);
    expect(screen.queryByTestId('emergency-help-sheet')).toBeNull();
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-OFFICIAL_HELP'));
    expect(screen.getByTestId('emergency-help-sheet')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-ROUTE_OR_RETURN'));
    expect(screen.getByTestId('safe-return-sheet')).toBeTruthy();
  });

  it('“I’m OK” posts a SAFETY check-in; “I need help” posts need_help', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={resp()} />);
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-CURRENT_STATUS-ok'));
    expect(mockedSend).toHaveBeenLastCalledWith('t1', 'SAFETY', { kind: 'check_in', label: "I'm OK" });
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-CURRENT_STATUS-help'));
    expect(mockedSend).toHaveBeenLastCalledWith('t1', 'SAFETY', { kind: 'need_help', label: 'I need help' });
  });

  it('a status that could not be sent SAYS so', async () => {
    mockedSend.mockResolvedValueOnce({ ok: false, error: 'forbidden', message: 'Messaging is paused.' } as any);
    await render(<SafetyModeBar threadId="t1" initialResponse={resp()} />);
    await fireEvent.press(screen.getByTestId('telegraph-safety-affordance-CURRENT_STATUS-ok'));
    expect(screen.getByTestId('telegraph-safety-status-error')).toBeTruthy();
    expect(screen.getByText('Messaging is paused.')).toBeTruthy();
  });
});

describe('entertainment is put away — from the served list, not assumed', () => {
  it('the screen is told to de-prioritize entertainment when the server says so', async () => {
    const onModeChange = jest.fn();
    await render(<SafetyModeBar threadId="t1" initialResponse={resp()} onModeChange={onModeChange} />);
    expect(onModeChange).toHaveBeenLastCalledWith({ raised: true, deprioritizeEntertainment: true });
  });

  it('a raised mode whose list de-prioritizes nothing does not ask for it', async () => {
    const onModeChange = jest.fn();
    await render(<SafetyModeBar threadId="t1" initialResponse={resp({ affordances: { promoted: PROMOTED, deprioritized: [] } })} onModeChange={onModeChange} />);
    expect(onModeChange).toHaveBeenLastCalledWith({ raised: true, deprioritizeEntertainment: false });
  });
});

describe('a failed read is not a calm conversation', () => {
  it('a first read that fails draws nothing — nothing was measured', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: false, error: 'network' });
    await render(<SafetyModeBar threadId="t1" refreshKey="m1" />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('telegraph-safety-mode-bar')).toBeNull();
  });

  it('a REFRESH that fails keeps the raised bar; only a successful NORMAL takes it down', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, data: resp() });
    const { rerender } = await render(<SafetyModeBar threadId="t1" refreshKey="m1" />);
    expect(await screen.findByTestId('telegraph-safety-mode-bar')).toBeTruthy();

    mockedFetch.mockResolvedValueOnce({ ok: false, error: 'network' });
    await rerender(<SafetyModeBar threadId="t1" refreshKey="m2" />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('telegraph-safety-mode-bar')).toBeTruthy();

    mockedFetch.mockResolvedValueOnce({ ok: true, data: resp({ mode: 'NORMAL', affordances: { promoted: [], deprioritized: [] } }) });
    await rerender(<SafetyModeBar threadId="t1" refreshKey="m3" />);
    await waitFor(() => expect(screen.queryByTestId('telegraph-safety-mode-bar')).toBeNull());
  });
});

describe('the conversation screen mounts the bar above the rail and wires it', () => {
  // Source-level: app/messages/[id].tsx cannot be mounted under jest-expo (§41.7).
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const dm: string = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  const line = dm.split('\n').find((l) => l.includes('<SafetyModeBar ')) ?? '';

  it('passes call, block/report, location and the rail collapse, and sits before the rail', () => {
    expect(line).toContain("onCall={canShowCallButtons ? () => { void startThreadCall('voice'); } : undefined}");
    expect(line).toContain('onBlockOrReport={() => setShowSafetySheet(true)}');
    expect(line).toContain("onLocationScope={() => setTypedCompose('LOCATION')}");
    // Verifier F3: the rail is coordination context, not entertainment — it is never
    // collapsed for safety. What is held away, for the whole of the raised mode, is
    // the unsolicited AI suggestion tray.
    expect(line).toContain('onModeChange={(s) => setSafetyQuiet(s.deprioritizeEntertainment)}');
    expect(line).not.toContain('setRailCollapsed');
    expect(dm).toContain("{id && !hideAiSuggestions && !safetyQuiet && dataSaver.mayLoad('ai') && (");
    expect(line.indexOf('<SafetyModeBar ')).toBeLessThan(line.indexOf('<SharedContextRail '));
  });
});
