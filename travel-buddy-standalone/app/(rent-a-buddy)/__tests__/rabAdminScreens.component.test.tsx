/**
 * Rent-a-Buddy admin screens added in testing mode (lane tm-rab; PLAT-F49,
 * PLAT-F55, PLAT-F56).
 *
 *   A1  launch controls: a failed read is an error, never "No launch controls yet";
 *   A2  launch controls: flipping a switch PATCHes the route's camelCase field;
 *   A3  review moderation: approve calls the approve route and re-reads;
 *   A4  risk review: a verification decision sends ONLY the fields the admin
 *       chose (the list carries no current verification, so defaulting the
 *       others would silently revoke them);
 *   A5  support: status + notes go to updateSupportReport;
 *   A6  "admin only" is its own state, not an empty queue.
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — navigation is not under test.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — the role redirect is covered by useRequireAdmin's own tests.
jest.mock('../../../src/hooks/useRequireAdmin', () => ({ useRequireAdmin: () => false }));

const mockLC = jest.fn();
const mockLCUpdate = jest.fn();
const mockLCCreate = jest.fn();
const mockReviews = jest.fn();
const mockApprove = jest.fn();
const mockReject = jest.fn();
const mockRisk = jest.fn();
const mockRiskSet = jest.fn();
const mockVerify = jest.fn();
const mockSupport = jest.fn();
const mockSupportUpdate = jest.fn();
jest.mock('../../../src/services/rentABuddyAdmin', () => ({
  ...jest.requireActual('../../../src/services/rentABuddyAdmin'),
  getLaunchControls: (...a: unknown[]) => mockLC(...a),
  updateLaunchControl: (...a: unknown[]) => mockLCUpdate(...a),
  createLaunchControl: (...a: unknown[]) => mockLCCreate(...a),
  listAdminReviews: (...a: unknown[]) => mockReviews(...a),
  approveReview: (...a: unknown[]) => mockApprove(...a),
  rejectReview: (...a: unknown[]) => mockReject(...a),
  getAdminRiskReview: (...a: unknown[]) => mockRisk(...a),
  updateRiskStatus: (...a: unknown[]) => mockRiskSet(...a),
  updateUserVerification: (...a: unknown[]) => mockVerify(...a),
  getAdminSupportReports: (...a: unknown[]) => mockSupport(...a),
  updateSupportReport: (...a: unknown[]) => mockSupportUpdate(...a),
}));

import AdminLaunchControls from '../admin/launch-controls';
import AdminReviews from '../admin/reviews';
import AdminRiskReview from '../admin/risk';
import AdminSupportReports from '../admin/support';

const LC = {
  id: 'lc1', country_code: 'PT', city: 'Lisbon', category: null, enabled: true, waitlist_only: false,
  min_age: 18, nightlife_min_age: 21, require_id_verification: true, require_phone_verification: false,
  full_payment_required: false, min_deposit_pct: 30, notes: null, updated_at: '2026-09-29T10:00:00Z',
};

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  [mockLC, mockLCUpdate, mockLCCreate, mockReviews, mockApprove, mockReject, mockRisk, mockRiskSet, mockVerify, mockSupport, mockSupportUpdate]
    .forEach((m) => m.mockReset());
});
afterEach(() => { jest.restoreAllMocks(); });

describe('launch controls', () => {
  it('A1 a failed read is an error, never the empty state', async () => {
    mockLC.mockResolvedValue({ ok: false, error: 'boom' });
    const { findByText, queryByText } = await render(<AdminLaunchControls />);
    expect(await findByText("Couldn't load this list", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('No launch controls yet')).toBeNull();
  });

  it('A2 a switch PATCHes the camelCase field and re-reads', async () => {
    mockLC.mockResolvedValue({ ok: true, data: [LC] });
    mockLCUpdate.mockResolvedValue({ ok: true });
    const { findByTestId } = await render(<AdminLaunchControls />);
    await fireEvent(await findByTestId('lc-lc1-enabled', {}, { timeout: 5000 }), 'valueChange', false);
    await waitFor(() => expect(mockLCUpdate).toHaveBeenCalledWith('lc1', { enabled: false }));
    await waitFor(() => expect(mockLC).toHaveBeenCalledTimes(2));
  });

  it('A2 a policy switch sends the route\'s camelCase name, not the row column', async () => {
    mockLC.mockResolvedValue({ ok: true, data: [LC] });
    mockLCUpdate.mockResolvedValue({ ok: true });
    const { findByTestId } = await render(<AdminLaunchControls />);
    await fireEvent(await findByTestId('lc-lc1-requirePhoneVerification', {}, { timeout: 5000 }), 'valueChange', true);
    await waitFor(() => expect(mockLCUpdate).toHaveBeenCalledWith('lc1', { requirePhoneVerification: true }));
  });

  it('A2 the age stepper PATCHes minAge', async () => {
    mockLC.mockResolvedValue({ ok: true, data: [LC] });
    mockLCUpdate.mockResolvedValue({ ok: true });
    const { findByTestId } = await render(<AdminLaunchControls />);
    await fireEvent.press(await findByTestId('lc-lc1-minAge-up', {}, { timeout: 5000 }));
    await waitFor(() => expect(mockLCUpdate).toHaveBeenCalledWith('lc1', { minAge: 19 }));
  });

  it('A6 admin only is its own state', async () => {
    mockLC.mockResolvedValue({ ok: false, error: 'forbidden' });
    const { findByText } = await render(<AdminLaunchControls />);
    expect(await findByText('Admin only', {}, { timeout: 5000 })).toBeTruthy();
  });

  // Payments PAY-T12 — the commission is configurable by product and market
  // (owner ruling 2026-10-04), and a launch control is a market and a product.
  it('A7 with no override the card says what applies instead, and "Set" PATCHes platformFeePercent', async () => {
    mockLC.mockResolvedValue({ ok: true, data: [LC] });
    mockLCUpdate.mockResolvedValue({ ok: true });
    const { findByTestId, getByText, queryByTestId } = await render(<AdminLaunchControls />);
    await fireEvent.press(await findByTestId('lc-lc1-fee-set', {}, { timeout: 5000 }));
    expect(getByText(/No override here: the fee schedule for the buddy's level applies, then the 10% default\./)).toBeTruthy();
    expect(queryByTestId('lc-lc1-fee')).toBeNull();
    await waitFor(() => expect(mockLCUpdate).toHaveBeenCalledWith('lc1', { platformFeePercent: 10 }));
    await waitFor(() => expect(mockLC).toHaveBeenCalledTimes(2));
  });

  it('A7 an override is shown as stored; the steppers PATCH the next whole percent and Clear PATCHes null', async () => {
    mockLC.mockResolvedValue({ ok: true, data: [{ ...LC, platform_fee_percent: 8 }] });
    mockLCUpdate.mockResolvedValue({ ok: true });
    const { findByTestId, getByTestId, getByText } = await render(<AdminLaunchControls />);
    expect((await findByTestId('lc-lc1-fee', {}, { timeout: 5000 })).props.children).toEqual([8, '%']);
    expect(getByText(/priced at 8% of the service price.*Tips carry no commission\./)).toBeTruthy();

    await fireEvent.press(getByTestId('lc-lc1-fee-up'));
    await waitFor(() => expect(mockLCUpdate).toHaveBeenCalledWith('lc1', { platformFeePercent: 9 }));
    await waitFor(() => expect(mockLC).toHaveBeenCalledTimes(2));
    // The card is locked while a change is in flight; wait for it to finish.
    await waitFor(() => expect(getByTestId('lc-lc1-fee-clear').props.accessibilityState?.disabled).toBeFalsy());

    await fireEvent.press(getByTestId('lc-lc1-fee-clear'));
    await waitFor(() => expect(mockLCUpdate).toHaveBeenCalledWith('lc1', { platformFeePercent: null }));
  });

  it('A7 a commission change the server refuses is reported, not shown as saved', async () => {
    mockLC.mockResolvedValue({ ok: true, data: [LC] });
    mockLCUpdate.mockResolvedValue({ ok: false, error: 'platformFeePercent must be a whole number from 0 to 100, or null to clear the override.' });
    const { findByTestId } = await render(<AdminLaunchControls />);
    await fireEvent.press(await findByTestId('lc-lc1-fee-set', {}, { timeout: 5000 }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("That didn't save", expect.stringMatching(/whole number from 0 to 100/)));
    expect(mockLC).toHaveBeenCalledTimes(1);
  });
});

describe('review moderation', () => {
  it('A3 approve calls the route and re-reads', async () => {
    mockReviews.mockResolvedValue({ ok: true, data: { reviews: [{
      id: 'rv1', booking_id: 'bk-12345678', reviewer_id: 't', reviewee_id: 'b', role: 'traveler', rating: 5,
      body: 'Great guide', safety_score: 5, communication_score: 5, punctuality_score: 4,
      moderation_status: 'pending_moderation', is_public: false, created_at: '2026-09-29T10:00:00Z',
    }], total: 1 } });
    mockApprove.mockResolvedValue({ ok: true });
    const { findByTestId, getByText } = await render(<AdminReviews />);
    await fireEvent.press(await findByTestId('review-approve-rv1', {}, { timeout: 5000 }));
    expect(getByText('Great guide')).toBeTruthy();
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('rv1'));
    await waitFor(() => expect(mockReviews).toHaveBeenCalledTimes(2));
  });

  it('a failed read is an error, never "Nothing waiting"', async () => {
    mockReviews.mockResolvedValue({ ok: false, error: 'boom' });
    const { findByText, queryByText } = await render(<AdminReviews />);
    expect(await findByText("Couldn't load this list", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('Nothing waiting for moderation')).toBeNull();
  });
});

describe('risk review', () => {
  it('A4 verification sends only the fields the admin chose', async () => {
    mockRisk.mockResolvedValue({ ok: true, data: [{
      id: 'bp1', user_id: 'u1', display_name: 'Ana', city: 'Lisbon', risk_review_status: 'watch',
      risk_review_note: 'Two late cancellations', nightlife_admin_approved: false,
    }] });
    mockVerify.mockResolvedValue({ ok: true });
    const { findByTestId, getByTestId, queryByTestId } = await render(<AdminRiskReview />);
    await fireEvent.press(await findByTestId('risk-verify-bp1', {}, { timeout: 5000 }));
    await fireEvent.press(await findByTestId('verify-id-yes', {}, { timeout: 5000 }));
    await fireEvent.changeText(getByTestId('risk-note'), 'Checked passport in person');
    await waitFor(() => expect(getByTestId('risk-save').props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(getByTestId('risk-save'));
    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('u1', { idVerified: true, note: 'Checked passport in person' }));
    // Let the save finish (sheet closes, list re-read) inside this test.
    await waitFor(() => expect(mockRisk).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryByTestId('risk-save')).toBeNull());
  });

  it('risk status goes to updateRiskStatus with the note', async () => {
    mockRisk.mockResolvedValue({ ok: true, data: [{
      id: 'bp1', user_id: 'u1', display_name: 'Ana', city: 'Lisbon', risk_review_status: 'watch',
      risk_review_note: null, nightlife_admin_approved: false,
    }] });
    mockRiskSet.mockResolvedValue({ ok: true });
    const { findByTestId, getByTestId, queryByTestId } = await render(<AdminRiskReview />);
    await fireEvent.press(await findByTestId('risk-set-bp1', {}, { timeout: 5000 }));
    await fireEvent.press(await findByTestId('risk-status-limited', {}, { timeout: 5000 }));
    await fireEvent.changeText(getByTestId('risk-note'), 'Repeat no-shows');
    await waitFor(() => expect(getByTestId('risk-save').props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(getByTestId('risk-save'));
    await waitFor(() => expect(mockRiskSet).toHaveBeenCalledWith('u1', 'limited', 'Repeat no-shows'));
    await waitFor(() => expect(mockRisk).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryByTestId('risk-save')).toBeNull());
  });
});

describe('support reports', () => {
  it('A5 status and notes go to updateSupportReport', async () => {
    mockSupport.mockResolvedValue({ ok: true, data: [{
      id: 'sr1', booking_id: 'bk-12345678', reporter_id: 'u', category: 'no_show', details: 'Buddy never came',
      status: 'open', admin_notes: null, template_id: null, created_at: '2026-09-29T10:00:00Z',
    }] });
    mockSupportUpdate.mockResolvedValue({ ok: true });
    const { findByTestId, getByTestId } = await render(<AdminSupportReports />);
    await fireEvent.press(await findByTestId('support-update-sr1', {}, { timeout: 5000 }));
    await fireEvent.press(await findByTestId('support-status-resolved', {}, { timeout: 5000 }));
    await fireEvent.changeText(getByTestId('support-notes'), 'Refund not applicable; buddy warned');
    await waitFor(() => expect(getByTestId('support-notes').props.value).toBe('Refund not applicable; buddy warned'));
    await fireEvent.press(getByTestId('support-save'));
    await waitFor(() => expect(mockSupportUpdate).toHaveBeenCalledWith('sr1', { status: 'resolved', adminNotes: 'Refund not applicable; buddy warned' }));
    await waitFor(() => expect(mockSupport).toHaveBeenCalledTimes(2));
  });
});
