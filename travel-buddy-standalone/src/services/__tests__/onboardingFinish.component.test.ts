/**
 * onboardingFinish.test.ts
 *
 * Unit tests for runOnboardingFinish — the function that PATCHes the profile,
 * bumps the social-version counter (so mounted following-list hooks pick up the
 * server-side @Portava auto-follow immediately), and navigates to /(tabs).
 *
 * These are plain async unit tests — no React renderer, no press-budget limits.
 */

import { runOnboardingFinish } from '../onboardingFinish.ts';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — only updateMyProfile is relevant here;
// importing the full module would attempt Supabase connections at test time.
jest.mock('../profile', () => ({
  updateMyProfile: jest.fn(),
}));

// NOTE: intentionally exhaustive — bumpSocialVersion is the only export
// exercised; useSocialVersion hooks a module-level listener set that would
// persist side-effects across test files if the real module is imported.
jest.mock('../../hooks/useSocialVersion', () => ({
  bumpSocialVersion: jest.fn(),
}));

// ── Import mock references after jest.mock ────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateMyProfile }   = require('../profile.ts')   as { updateMyProfile: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { bumpSocialVersion } = require('../../hooks/useSocialVersion.ts') as { bumpSocialVersion: jest.Mock };

const mockUpdateMyProfile   = updateMyProfile;
const mockBumpSocialVersion = bumpSocialVersion;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('runOnboardingFinish', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls bumpSocialVersion then onComplete after a successful PATCH', async () => {
    mockUpdateMyProfile.mockResolvedValue({ ok: true, data: { displayName: 'Test' } });

    const onComplete = jest.fn();
    const onError    = jest.fn();

    await runOnboardingFinish({ patch: { onboardingComplete: true }, onComplete, onError });

    expect(mockUpdateMyProfile).toHaveBeenCalledWith({ onboardingComplete: true });
    expect(mockBumpSocialVersion).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('bumpSocialVersion is called BEFORE onComplete', async () => {
    mockUpdateMyProfile.mockResolvedValue({ ok: true, data: {} });

    const callOrder: string[] = [];
    mockBumpSocialVersion.mockImplementation(() => { callOrder.push('bump'); });
    const onComplete = jest.fn(() => { callOrder.push('navigate'); });

    await runOnboardingFinish({ patch: {}, onComplete, onError: jest.fn() });

    expect(callOrder).toEqual(['bump', 'navigate']);
  });

  it('does NOT call bumpSocialVersion and calls onError on a hard db_error', async () => {
    mockUpdateMyProfile.mockResolvedValue({
      ok: false, data: null, errorKind: 'db_error', message: 'Write failed',
    });

    const onComplete = jest.fn();
    const onError    = jest.fn();

    await runOnboardingFinish({ patch: {}, onComplete, onError });

    expect(mockBumpSocialVersion).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ ok: false, errorKind: 'db_error' });
  });

  it('does NOT call bumpSocialVersion on network_unreachable', async () => {
    mockUpdateMyProfile.mockResolvedValue({
      ok: false, data: null, errorKind: 'network_unreachable',
    });

    const onError = jest.fn();
    await runOnboardingFinish({ patch: {}, onComplete: jest.fn(), onError });

    expect(mockBumpSocialVersion).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('still calls bumpSocialVersion and onComplete when errorKind is config_error', async () => {
    // config_error is a soft error — treated as success for navigation purposes.
    mockUpdateMyProfile.mockResolvedValue({
      ok: false, data: null, errorKind: 'config_error',
    });

    const onComplete = jest.fn();
    await runOnboardingFinish({ patch: {}, onComplete, onError: jest.fn() });

    expect(mockBumpSocialVersion).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('still calls bumpSocialVersion and onComplete when errorKind is unauthenticated', async () => {
    mockUpdateMyProfile.mockResolvedValue({
      ok: false, data: null, errorKind: 'unauthenticated',
    });

    const onComplete = jest.fn();
    await runOnboardingFinish({ patch: {}, onComplete, onError: jest.fn() });

    expect(mockBumpSocialVersion).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
