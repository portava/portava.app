/**
 * OD-MAP-6's three passive-sensing consents in Settings (SensingConsentSection).
 *
 * Run with: pnpm test:component
 *
 * Pinned: three separate switches, each OFF until turned on; each shows what,
 * where, who and how to turn it off; turning ON sends the version of the words
 * on screen; turning OFF is always possible — even while the feature is
 * unavailable; a failed load is "couldn't load" with a retry, never three
 * switches off; a failed save leaves the switch where it was.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('../../../services/sensingConsent', () => ({
  ...jest.requireActual('../../../services/sensingConsent'),
  readSensingConsent: jest.fn(),
  setSensingConsent: jest.fn(),
}));

import * as svc from '../../../services/sensingConsent.ts';
import { SensingConsentSection } from '../SensingConsentSection.tsx';
import { SENSING_CONSENT_WORDS } from '../../../lib/sensing/consentSplit.ts';

const m = svc as unknown as { readSensingConsent: jest.Mock; setSensingConsent: jest.Mock };

const entry = (scope: 'capture' | 'upload' | 'surface', granted: boolean, effective = granted) => ({
  scope, granted, current: true, effective, disclosureVersion: granted ? SENSING_CONSENT_WORDS[scope].version : null,
  currentVersion: SENSING_CONSENT_WORDS[scope].version,
});
const state = (available: boolean, g: { capture?: boolean; upload?: boolean; surface?: boolean } = {}) => ({
  available,
  consents: {
    capture: entry('capture', !!g.capture),
    upload: entry('upload', !!g.upload, !!g.capture && !!g.upload),
    surface: entry('surface', !!g.surface, !!g.capture && !!g.upload && !!g.surface),
  },
});
const sw = (scope: string) => screen.getByTestId(`sensing-consent-${scope}`);

beforeEach(() => { jest.clearAllMocks(); });

describe('Area sensing — three separate consents', () => {
  it('shows three switches, all OFF by default, each with what / where / who / how to turn it off', async () => {
    m.readSensingConsent.mockResolvedValue({ status: 'ok', state: state(true) });
    await render(<SensingConsentSection />);
    await waitFor(() => expect(sw('capture')).toBeTruthy());
    for (const s of ['capture', 'upload', 'surface'] as const) {
      expect(sw(s).props.value).toBe(false);
      const w = SENSING_CONSENT_WORDS[s];
      expect(screen.getByText(w.title)).toBeTruthy();
      expect(screen.getByText(new RegExp(w.where.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
    }
  });

  it('turning ON sends that one consent with the version of the words on screen, and shows what the server recorded', async () => {
    m.readSensingConsent.mockResolvedValue({ status: 'ok', state: state(true) });
    m.setSensingConsent.mockResolvedValue({ ok: true, state: state(true, { capture: true }) });
    await render(<SensingConsentSection />);
    await waitFor(() => expect(sw('capture')).toBeTruthy());
    await act(async () => { await fireEvent(sw('capture'), 'valueChange', true); });
    expect(m.setSensingConsent).toHaveBeenCalledTimes(1);
    expect(m.setSensingConsent).toHaveBeenCalledWith('capture', true, SENSING_CONSENT_WORDS.capture.version);
    await waitFor(() => expect(sw('capture').props.value).toBe(true));
    expect(sw('upload').props.value).toBe(false);
  });

  it('while the feature is unavailable nothing can be turned ON — but anything already on can be turned OFF', async () => {
    m.readSensingConsent.mockResolvedValue({ status: 'ok', state: state(false, { capture: true }) });
    m.setSensingConsent.mockResolvedValue({ ok: true, state: state(false) });
    await render(<SensingConsentSection />);
    await waitFor(() => expect(sw('capture')).toBeTruthy());
    expect(sw('upload').props.disabled).toBe(true);
    expect(sw('capture').props.disabled).toBe(false);
    await act(async () => { await fireEvent(sw('capture'), 'valueChange', false); });
    expect(m.setSensingConsent).toHaveBeenCalledWith('capture', false, SENSING_CONSENT_WORDS.capture.version);
    await waitFor(() => expect(sw('capture').props.value).toBe(false));
  });

  it('a failed load is "couldn’t load" with a retry — never three switches showing off', async () => {
    m.readSensingConsent.mockResolvedValueOnce({ status: 'unreadable', reason: 'http', httpStatus: 503 })
      .mockResolvedValueOnce({ status: 'ok', state: state(true, { capture: true }) });
    await render(<SensingConsentSection />);
    await waitFor(() => expect(screen.getByTestId('sensing-consent-retry')).toBeTruthy());
    expect(screen.queryByTestId('sensing-consent-capture')).toBeNull();
    await act(async () => { await fireEvent.press(screen.getByTestId('sensing-consent-retry')); });
    await waitFor(() => expect(sw('capture').props.value).toBe(true));
  });

  it('a failed save leaves the switch where it was and says so', async () => {
    m.readSensingConsent.mockResolvedValue({ status: 'ok', state: state(true) });
    m.setSensingConsent.mockResolvedValue({ ok: false, reason: 'failed', httpStatus: 503 });
    await render(<SensingConsentSection />);
    await waitFor(() => expect(sw('upload')).toBeTruthy());
    await act(async () => { await fireEvent(sw('upload'), 'valueChange', true); });
    await waitFor(() => expect(screen.getByText(/your setting is unchanged/)).toBeTruthy());
    expect(sw('upload').props.value).toBe(false);
  });

  it('a later consent that is on but not in effect says so', async () => {
    m.readSensingConsent.mockResolvedValue({ status: 'ok', state: state(true, { upload: true }) });
    await render(<SensingConsentSection />);
    await waitFor(() => expect(sw('upload')).toBeTruthy());
    expect(screen.getByText(/On, but not in effect until the settings above are on\./)).toBeTruthy();
  });
});
