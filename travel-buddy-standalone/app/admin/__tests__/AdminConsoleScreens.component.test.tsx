/**
 * Testing-mode admin console screens (WP-21) — rendered behaviour.
 *
 * Run with: pnpm test:component
 *
 * The rule every screen here is held to: a queue that FAILED to load renders
 * as an error with a retry (announced as an alert), and only a queue that
 * loaded with nothing in it renders as empty. A decision leaves its row only
 * after the server confirmed it; a refusal stays on the row with its reason.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../src/hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../../src/hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));

jest.mock('../../../src/services/adminConsole', () => ({
  ...jest.requireActual('../../../src/services/adminConsole'),
  listPendingGems: jest.fn(),
  listReportedGems: jest.fn(),
  verifyGem: jest.fn(),
  resolveGemReports: jest.fn(),
  listGuideApplications: jest.fn(),
  setGuideStatus: jest.fn(),
  listLiveScopes: jest.fn(),
  promoteLiveScope: jest.fn(),
  withdrawLiveScope: jest.fn(),
  listUserStamps: jest.fn(),
  awardStamp: jest.fn(),
  revokeUserStamp: jest.fn(),
  restoreUserStamp: jest.fn(),
  listAirportProfiles: jest.fn(),
  listCautionZones: jest.fn(),
  upsertAirportProfile: jest.fn(),
  createCautionZone: jest.fn(),
}));

jest.mock('../../../src/services/adminUsers', () => ({
  ...jest.requireActual('../../../src/services/adminUsers'),
  lookupUser: jest.fn(),
}));

import * as svc from '../../../src/services/adminConsole';
import { lookupUser } from '../../../src/services/adminUsers';
import AdminHiddenGemsScreen from '../hidden-gems';
import AdminLocalGuidesScreen from '../local-guides';
import AdminLiveScopesScreen from '../live-scopes';
import AdminUserStampsScreen from '../user-stamps';
import AdminAirportsScreen from '../airports';
import AdminConsoleScreen from '../console';

const m = svc as unknown as Record<string, jest.Mock>;

const GEM = { id: 'g1', name: 'Quiet courtyard', category: 'garden', city: 'Lisbon', country: 'PT', sensitivity_level: null, submitted_by: 'u9', created_at: '2026-09-01T00:00:00.000Z' };
const GUIDE = { user_id: 'u-guide', guide_level: 0, city_expertise: ['Lisbon'], contribution_count: 2, status: 'applicant', created_at: '2026-09-01T00:00:00.000Z' };
const UID = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAMP = { id: 's1', user_id: UID, stamp_definition_id: 'd1', earned_at: '2026-09-01T00:00:00.000Z', city: 'Lisbon', country: 'PT', source_type: 'admin', is_revoked: false, revoked_at: null, revoked_reason: null, stamp_definitions: { slug: 'lisbon', name: 'Lisbon', stamp_type: 'city' } };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Hidden gem review (PLAT-F39)', () => {
  it('a failed queue read is an announced error with a retry — not "no gems"', async () => {
    m.listPendingGems.mockResolvedValueOnce({ ok: false, error: 'HTTP 500' }).mockResolvedValueOnce({ ok: true, data: [] });
    await render(<AdminHiddenGemsScreen />);
    const err = await screen.findByTestId('gems-error');
    expect(err.props.accessibilityRole).toBe('alert');
    expect(screen.queryByTestId('gems-empty')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Try again'));
    await screen.findByTestId('gems-empty');
    expect(m.listPendingGems).toHaveBeenCalledTimes(2);
  });

  it('approve removes the row only after the server recorded it', async () => {
    m.listPendingGems.mockResolvedValue({ ok: true, data: [GEM] });
    m.verifyGem.mockResolvedValue({ ok: true, data: { ok: true } });
    await render(<AdminHiddenGemsScreen />);
    await fireEvent.press(await screen.findByTestId('gem-approve-g1'));
    await waitFor(() => expect(screen.queryByTestId('gem-pending-g1')).toBeNull());
    expect(m.verifyGem).toHaveBeenCalledWith('g1', 'approved', undefined);
  });

  it('a refused approval stays on the row with its reason', async () => {
    m.listPendingGems.mockResolvedValue({ ok: true, data: [GEM] });
    m.verifyGem.mockResolvedValue({ ok: false, error: 'Gem not found' });
    await render(<AdminHiddenGemsScreen />);
    await fireEvent.press(await screen.findByTestId('gem-reject-g1'));
    await screen.findByText('Not recorded: Gem not found');
    expect(screen.getByTestId('gem-pending-g1')).toBeTruthy();
    expect(m.verifyGem).toHaveBeenCalledWith('g1', 'rejected', undefined);
  });

  it('the Reported tab reads its own queue and resolves reports', async () => {
    m.listPendingGems.mockResolvedValue({ ok: true, data: [] });
    m.listReportedGems.mockResolvedValue({ ok: true, data: [{ id: 'g2', name: 'Loud bar', category: null, city: 'Porto', country: 'PT', report_count: 3, status: 'active', updated_at: '2026-09-02T00:00:00.000Z' }] });
    m.resolveGemReports.mockResolvedValue({ ok: true, data: { ok: true } });
    await render(<AdminHiddenGemsScreen />);
    await fireEvent.press(await screen.findByTestId('gems-tab-reported'));
    await fireEvent.press(await screen.findByTestId('gem-dismiss-g2'));
    await waitFor(() => expect(screen.queryByTestId('gem-reported-g2')).toBeNull());
    expect(m.resolveGemReports).toHaveBeenCalledWith('g2', 'dismissed');
  });
});

describe('Local guides (PLAT-F38)', () => {
  it('a failed read is an error, not "no applications"', async () => {
    m.listGuideApplications.mockResolvedValue({ ok: false, error: 'HTTP 503' });
    await render(<AdminLocalGuidesScreen />);
    await screen.findByTestId('guides-error');
    expect(screen.queryByTestId('guides-empty')).toBeNull();
  });

  it('approve sets the applicant active and the row leaves on success', async () => {
    m.listGuideApplications.mockResolvedValue({ ok: true, data: [GUIDE] });
    m.setGuideStatus.mockResolvedValue({ ok: true, data: { ok: true } });
    await render(<AdminLocalGuidesScreen />);
    await fireEvent.press(await screen.findByTestId('guide-approve-u-guide'));
    await screen.findByTestId('guides-done');
    expect(screen.queryByTestId('guide-u-guide')).toBeNull();
    expect(m.setGuideStatus).toHaveBeenCalledWith('u-guide', 'active');
  });

  it('a refusal keeps the row', async () => {
    m.listGuideApplications.mockResolvedValue({ ok: true, data: [GUIDE] });
    m.setGuideStatus.mockResolvedValue({ ok: false, error: 'This user has no local guide profile' });
    await render(<AdminLocalGuidesScreen />);
    await fireEvent.press(await screen.findByTestId('guide-decline-u-guide'));
    await screen.findByText('Not changed: This user has no local guide profile');
    expect(screen.getByTestId('guide-u-guide')).toBeTruthy();
    expect(m.setGuideStatus).toHaveBeenCalledWith('u-guide', 'demoted');
  });
});

describe('Live-label scopes (SEN-F06)', () => {
  it('a closed admin surface is shown as the server said it, never as "no scopes"', async () => {
    m.listLiveScopes.mockResolvedValue({ ok: false, error: 'intel_live_scope_admin_surface_enabled is off; the intel live-scope admin surface is closed' });
    await render(<AdminLiveScopesScreen />);
    await screen.findByText(/admin surface is closed/);
    expect(screen.queryByTestId('scopes-empty')).toBeNull();
  });

  it('the form refuses a promotion without a reason before any request', async () => {
    m.listLiveScopes.mockResolvedValue({ ok: true, data: [] });
    await render(<AdminLiveScopesScreen />);
    await screen.findByTestId('scopes-empty');
    await fireEvent.changeText(screen.getByTestId('promote-claim'), 'crowd_level');
    await fireEvent.press(screen.getByTestId('promote-submit'));
    await screen.findByTestId('promote-error');
    expect(m.promoteLiveScope).not.toHaveBeenCalled();
  });

  it('a valid promotion is sent and the list re-read', async () => {
    m.listLiveScopes.mockResolvedValue({ ok: true, data: [] });
    m.promoteLiveScope.mockResolvedValue({ ok: true, data: { scopeKey: '|crowd_level', action: 'promoted', expiresAt: '2026-10-13T00:00:00.000Z' } });
    await render(<AdminLiveScopesScreen />);
    await screen.findByTestId('scopes-empty');
    await fireEvent.changeText(screen.getByTestId('promote-claim'), 'crowd_level');
    await fireEvent.changeText(screen.getByTestId('promote-reasoning'), 'test city');
    await fireEvent.press(screen.getByTestId('promote-submit'));
    await screen.findByTestId('scopes-notice');
    const body = m.promoteLiveScope.mock.calls[0][0];
    expect(body.zoneId).toBeNull();
    expect(body.claimType).toBe('crowd_level');
    expect(m.listLiveScopes).toHaveBeenCalledTimes(2);
  });

  it('withdraw needs a reason', async () => {
    m.listLiveScopes.mockResolvedValue({ ok: true, data: [{ scope_key: 'z1|crowd_level', zone_id: 'z1', claim_type: 'crowd_level', promoted_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-10-01T00:00:00.000Z', withdrawn_at: null, withdrawn_reason: null, note: null, state: 'active' }] });
    await render(<AdminLiveScopesScreen />);
    await fireEvent.press(await screen.findByTestId('scope-withdraw-z1|crowd_level'));
    await screen.findByText('Give a reason to withdraw.');
    expect(m.withdrawLiveScope).not.toHaveBeenCalled();
  });
});

describe('User stamps (PASS-F23)', () => {
  it('a user id loads their stamps; revoke needs a reason, then re-reads', async () => {
    m.listUserStamps.mockResolvedValue({ ok: true, data: { stamps: [STAMP], total: 1 } });
    m.revokeUserStamp.mockResolvedValue({ ok: true, data: { revoked: true, reason: 'revoked' } });
    await render(<AdminUserStampsScreen />);
    await fireEvent.changeText(screen.getByTestId('stamps-query'), UID);
    await fireEvent.press(screen.getByTestId('stamps-find'));
    await fireEvent.press(await screen.findByTestId('stamp-revoke-s1'));
    await screen.findByText('A reason is required for every stamp action.');
    expect(m.revokeUserStamp).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('stamps-reason'), 'test award');
    await fireEvent.press(screen.getByTestId('stamp-revoke-s1'));
    await screen.findByText('Revoked.');
    expect(m.revokeUserStamp).toHaveBeenCalledWith('s1', 'test award');
    expect(m.listUserStamps).toHaveBeenCalledTimes(2);
    expect(lookupUser).not.toHaveBeenCalled();
  });

  it('a @handle is looked up first; a failed stamp read is an error, not "no stamps"', async () => {
    (lookupUser as jest.Mock).mockResolvedValue({ ok: true, data: { profile: { id: UID, handle: 'maria', display_name: null } } });
    m.listUserStamps.mockResolvedValue({ ok: false, error: 'HTTP 500' });
    await render(<AdminUserStampsScreen />);
    await fireEvent.changeText(screen.getByTestId('stamps-query'), '@maria');
    await fireEvent.press(screen.getByTestId('stamps-find'));
    await screen.findByTestId('stamps-error');
    expect(screen.queryByTestId('stamps-empty')).toBeNull();
    expect(lookupUser).toHaveBeenCalledWith({ handle: 'maria' });
    expect(m.listUserStamps).toHaveBeenCalledWith(UID);
  });

  it('an award the engine declines is shown as not awarded', async () => {
    m.listUserStamps.mockResolvedValue({ ok: true, data: { stamps: [], total: 0 } });
    m.awardStamp.mockResolvedValue({ ok: true, data: { awarded: false, reason: 'definition_not_found' } });
    await render(<AdminUserStampsScreen />);
    await fireEvent.changeText(screen.getByTestId('stamps-query'), UID);
    await fireEvent.press(screen.getByTestId('stamps-find'));
    await screen.findByTestId('stamps-empty');
    await fireEvent.changeText(screen.getByTestId('stamps-reason'), 'test');
    await fireEvent.changeText(screen.getByTestId('stamps-slug'), 'nope');
    await fireEvent.press(screen.getByTestId('stamps-award'));
    await screen.findByText('Not awarded: definition not found.');
  });
});

describe('Airports (LAY-F16)', () => {
  it('a failed profile read is an error with a retry, not "no airports"', async () => {
    m.listAirportProfiles.mockResolvedValue({ ok: false, error: 'Airport profiles could not be listed. Please try again.' });
    await render(<AdminAirportsScreen />);
    await screen.findByTestId('airports-error');
    expect(screen.queryByTestId('airports-empty')).toBeNull();
  });

  it('an empty table invites adding the test airport; the form validates before sending', async () => {
    m.listAirportProfiles.mockResolvedValue({ ok: true, data: [] });
    await render(<AdminAirportsScreen />);
    await screen.findByTestId('airports-empty');
    await fireEvent.changeText(screen.getByTestId('airport-iata'), 'LIS');
    await fireEvent.press(screen.getByTestId('airport-save'));
    await screen.findByTestId('airport-form-error');
    expect(m.upsertAirportProfile).not.toHaveBeenCalled();
  });

  it('selecting an airport reads its caution zones', async () => {
    m.listAirportProfiles.mockResolvedValue({ ok: true, data: [{ id: 'p1', iata_code: 'LIS', name: 'Lisbon', city: 'Lisbon', country: 'Portugal', country_code: 'PT', timezone: 'Europe/Lisbon', lat: 38.77, lng: -9.13, verified: true }] });
    m.listCautionZones.mockResolvedValue({ ok: true, data: [] });
    await render(<AdminAirportsScreen />);
    await fireEvent.press(await screen.findByTestId('airport-select-LIS'));
    await screen.findByTestId('zones-empty');
    expect(m.listCautionZones).toHaveBeenCalledWith('LIS');
  });
});

describe('Testing console hub', () => {
  it('lists the five screens and names the API-only surfaces', async () => {
    await render(<AdminConsoleScreen />);
    for (const id of ['hidden-gems', 'local-guides', 'live-scopes', 'user-stamps', 'airports']) {
      expect(screen.getByTestId(`console-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('console-api-only')).toBeTruthy();
  });
});
