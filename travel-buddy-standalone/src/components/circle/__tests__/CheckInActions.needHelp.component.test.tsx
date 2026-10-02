/**
 * Circle "I need help" → host alert — TM-social, MAP-F08.
 *
 * POST /circle/contexts/:type/:id/need-help had no caller: the button only
 * opened Safe Return. It now offers both, and says exactly what the server
 * does — ONE alert to the HOST, no location — never "your circle has been
 * notified". A refusal (429 / 403 / outage) is reported as "Alert not sent".
 * A host pressing it would alert only themselves, so a host is offered Safe
 * Return alone.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { CheckInActions } from '../CheckInActions.tsx';

jest.mock('../../../services/circle.ts', () => ({
  ...jest.requireActual('../../../services/circle.ts'),
  postCheckIn: jest.fn(),
  postNeedHelp: jest.fn(),
}));
const circle = require('../../../services/circle.ts');

type Btn = { text: string; onPress?: () => void };
function lastButtons(spy: jest.SpyInstance): Btn[] {
  const call = spy.mock.calls[spy.mock.calls.length - 1];
  return (call?.[2] ?? []) as Btn[];
}

jest.setTimeout(20000);

describe('CheckInActions — need help', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => { jest.clearAllMocks(); alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
  afterEach(() => alertSpy.mockRestore());

  async function mount(isHost = false) {
    const onNeedHelp = jest.fn(); const onHostAlerted = jest.fn();
    const utils = await render(
      <CheckInActions contextType="trip" contextId="trip-1" onCheckInComplete={() => {}} onNeedHelp={onNeedHelp} isHost={isHost} onHostAlerted={onHostAlerted} />,
    );
    await fireEvent.press(utils.getByTestId('circle-need-help'));
    return { ...utils, onNeedHelp, onHostAlerted };
  }

  it('a member is offered "Alert the host" and "Open Safe Return"', async () => {
    await mount();
    expect(lastButtons(alertSpy).map((b) => b.text)).toEqual(['Cancel', 'Alert the host', 'Open Safe Return']);
  });

  it('alerting the host calls the need-help route and says only what the server did', async () => {
    circle.postNeedHelp.mockResolvedValue({ ok: true, data: { acknowledged: true } });
    const { onHostAlerted } = await mount();
    await lastButtons(alertSpy).find((b) => b.text === 'Alert the host')!.onPress!();
    await new Promise((r) => setTimeout(r, 0));
    expect(circle.postNeedHelp).toHaveBeenCalledWith('trip', 'trip-1');
    expect(onHostAlerted).toHaveBeenCalledTimes(1);
    const [title, body] = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    expect(title).toBe('Alert sent to the host');
    expect(body).toMatch(/location was not shared/);
    expect(body).not.toMatch(/circle has been notified/i);
  });

  it.each([
    [429, /several alerts/],
    [403, /not a member/],
    [500, /could not be alerted/],
  ])('a %s refusal is "Alert not sent", never "sent"', async (status, copy) => {
    circle.postNeedHelp.mockResolvedValue({ ok: false, error: 'x', status });
    const { onHostAlerted } = await mount();
    await lastButtons(alertSpy).find((b) => b.text === 'Alert the host')!.onPress!();
    await new Promise((r) => setTimeout(r, 0));
    const [title, body] = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    expect(title).toBe('Alert not sent');
    expect(body).toMatch(copy);
    expect(onHostAlerted).not.toHaveBeenCalled();
  });

  it('a host is offered Safe Return only (a host alert would reach nobody else)', async () => {
    const { onNeedHelp } = await mount(true);
    const btns = lastButtons(alertSpy);
    expect(btns.map((b) => b.text)).toEqual(['Cancel', 'Open Safe Return']);
    btns[1].onPress!();
    expect(onNeedHelp).toHaveBeenCalledTimes(1);
    expect(circle.postNeedHelp).not.toHaveBeenCalled();
  });
});
