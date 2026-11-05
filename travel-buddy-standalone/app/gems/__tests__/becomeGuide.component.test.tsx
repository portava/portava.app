/**
 * Become a Local Guide — the app finally calls POST /hidden-gems/guides/apply.
 *
 * Run with: pnpm test:component
 *
 * Pinned: an active guide is told so instead of shown the form; the form needs
 * a city; it sends the parsed cities and the bio; the route's answer decides
 * what is shown (it is idempotent, so a second application gets the first
 * one back); a switched-off feature is not "try again".
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => ({ userId: 'me', isAuthed: true, loading: false }),
}));

const mockApply = jest.fn();
const mockGetGuide = jest.fn();
// NOTE: intentional stub — the real service does an authed fetch.
jest.mock('../../../src/services/hiddenGems', () => ({
  applyForGuide: (...a: unknown[]) => mockApply(...a),
  getGuideProfile: (...a: unknown[]) => mockGetGuide(...a),
}));

import BecomeGuideScreen from '../become-guide';

beforeEach(() => {
  mockApply.mockReset();
  mockGetGuide.mockReset();
  mockGetGuide.mockResolvedValue(null);
});

describe('Become a Local Guide', () => {
  it('an active guide is told so, not shown the form', async () => {
    mockGetGuide.mockResolvedValue({ status: 'active' });
    await render(<BecomeGuideScreen />);
    await screen.findByTestId('guide-apply-active');
    expect(screen.queryByLabelText('Send application')).toBeNull();
  });

  it('needs at least one city before it sends', async () => {
    await render(<BecomeGuideScreen />);
    const send = await screen.findByLabelText('Send application');
    expect(send.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(send);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('sends the cities and bio, and says the application is with a reviewer', async () => {
    mockApply.mockResolvedValue({ ok: true, guide: { status: 'applicant' } });
    await render(<BecomeGuideScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Cities you know well'), 'Cebu, manila, cebu');
    await fireEvent.changeText(screen.getByLabelText('About you'), '  Lived in Cebu for six years.  ');
    await fireEvent.press(screen.getByLabelText('Send application'));
    await screen.findByTestId('guide-apply-pending');
    expect(mockApply).toHaveBeenCalledWith('Lived in Cebu for six years.', ['Cebu', 'manila']);
  });

  it('an existing guide profile coming back from apply is what is shown', async () => {
    mockApply.mockResolvedValue({ ok: true, guide: { status: 'suspended' } });
    await render(<BecomeGuideScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Cities you know well'), 'Cebu');
    await fireEvent.press(screen.getByLabelText('Send application'));
    await screen.findByTestId('guide-apply-paused');
  });

  it('a switched-off feature is said plainly, with no retry wording', async () => {
    mockApply.mockRejectedValue(Object.assign(new Error('feature disabled'), { code: 'feature_disabled' }));
    await render(<BecomeGuideScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Cities you know well'), 'Cebu');
    await fireEvent.press(screen.getByLabelText('Send application'));
    await screen.findByText('Local Guide applications are not open right now.');
    expect(screen.queryByText(/try again/i)).toBeNull();
  });
});
