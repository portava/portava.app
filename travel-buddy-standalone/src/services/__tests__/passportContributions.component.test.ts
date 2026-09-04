/**
 * Unit tests for passportContributions — the §20 reputation client + pure
 * derivation (TABLE 21).
 *
 * The load-bearing contract points:
 *   1. normalizeContributions is a closed ALLOW-LIST — paid/purchased counts,
 *      rejected reports, moderation notes, flags and safety history are dropped
 *      by construction (spec §20: paid never boosts confidence; no private
 *      moderation data).
 *   2. hasContributionSignal gates rendering to real positive signal.
 *   3. contributionsFromCredentials only fires on contribution-relevant keys —
 *      a generic credential list never synthesizes a phantom card.
 *   4. getPassportContributions maps ok / not-present / failure correctly.
 */
import {
  normalizeContributions,
  hasContributionSignal,
  contributionsFromCredentials,
  getPassportContributions,
  CONTRIBUTION_FIELDS,
  _setTestAuthToken,
  type ContributionProjection,
} from '../passportContributions.ts';

// NOTE: intentionally exhaustive — apiToken imports the Supabase client at module
// load; the auth path is bypassed here via _setTestAuthToken, so freshToken is
// never actually called.
jest.mock('../apiToken', () => ({
  freshToken: jest.fn(async () => null),
}));

describe('normalizeContributions — closed allow-list', () => {
  it('reads only the six TABLE-21 fields (snake or camel case)', () => {
    const c = normalizeContributions({
      contributor_level: 'Local Expert',
      accepted_reports: 12,
      confirmations: 7,
      hidden_gems: 3,
      top_expertise: ['Food', 'Nightlife', 'Food'],
    });
    expect(c).toEqual<ContributionProjection>({
      level: 'Local Expert',
      acceptedReports: 12,
      confirmations: 7,
      hiddenGems: 3,
      topExpertise: ['Food', 'Nightlife'], // de-duplicated
    });
    expect(Object.keys(c).sort()).toEqual([...CONTRIBUTION_FIELDS].sort());
  });

  it('drops paid / moderation / rejection / safety fields entirely', () => {
    const c = normalizeContributions({
      level: 'Contributor',
      acceptedReports: 5,
      // ── none of the following may survive ──
      paidContributions: 99,
      purchasedBoosts: 4,
      rejectedReports: 8,
      reportCount: 6, // moderation reports AGAINST the user
      moderationNotes: 'warned for spam',
      flags: ['harassment'],
      safetyHistory: ['banned once'],
    });

    const serialised = JSON.stringify(c);
    expect(serialised).not.toMatch(/paid/i);
    expect(serialised).not.toMatch(/purchas/i);
    expect(serialised).not.toMatch(/reject/i);
    expect(serialised).not.toMatch(/moderation/i);
    expect(serialised).not.toMatch(/spam/i);
    expect(serialised).not.toMatch(/banned/i);
    expect(serialised).not.toMatch(/harassment/i);
    // Only the whitelisted keys exist.
    expect(Object.keys(c).sort()).toEqual([...CONTRIBUTION_FIELDS].sort());
    expect(c.acceptedReports).toBe(5);
  });

  it('coerces bad counts to null and non-array expertise to []', () => {
    const c = normalizeContributions({
      level: '',
      acceptedReports: -3,
      confirmations: 'lots',
      hiddenGems: Number.NaN,
      topExpertise: 'Food',
    });
    expect(c).toEqual<ContributionProjection>({
      level: null,
      acceptedReports: null,
      confirmations: null,
      hiddenGems: null,
      topExpertise: [],
    });
  });
});

describe('hasContributionSignal', () => {
  const base: ContributionProjection = {
    level: null,
    acceptedReports: null,
    confirmations: null,
    hiddenGems: null,
    topExpertise: [],
  };

  it('is false for null / all-empty', () => {
    expect(hasContributionSignal(null)).toBe(false);
    expect(hasContributionSignal(base)).toBe(false);
    expect(hasContributionSignal({ ...base, acceptedReports: 0 })).toBe(false);
  });

  it('is true when any positive signal exists', () => {
    expect(hasContributionSignal({ ...base, level: 'Explorer' })).toBe(true);
    expect(hasContributionSignal({ ...base, acceptedReports: 1 })).toBe(true);
    expect(hasContributionSignal({ ...base, hiddenGems: 2 })).toBe(true);
    expect(hasContributionSignal({ ...base, topExpertise: ['Food'] })).toBe(true);
  });
});

describe('contributionsFromCredentials — projection fallback', () => {
  it('returns null for a generic credential list (no phantom card)', () => {
    expect(
      contributionsFromCredentials([
        { key: 'identity', label: 'Identity Verified' },
        { key: 'established', label: 'Established Account' },
        { key: 'trip_experience', label: 'Trip Experience', detail: '8 trips' },
      ]),
    ).toBeNull();
    expect(contributionsFromCredentials(null)).toBeNull();
    expect(contributionsFromCredentials(undefined)).toBeNull();
  });

  it('derives level + expertise from contribution-relevant credentials', () => {
    const c = contributionsFromCredentials([
      { key: 'live_intel', label: 'Trusted Contributor' },
      { key: 'expertise_food', label: 'Food' },
      { key: 'expertise_nightlife', label: 'Nightlife' },
      { key: 'identity', label: 'Identity Verified' },
    ]);
    expect(c).not.toBeNull();
    expect(c?.level).toBe('Trusted Contributor');
    expect(c?.topExpertise).toEqual(['Food', 'Nightlife']);
    // Counts are unavailable from credentials — never invented.
    expect(c?.acceptedReports).toBeNull();
    expect(c?.confirmations).toBeNull();
    expect(c?.hiddenGems).toBeNull();
  });
});

describe('getPassportContributions', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    _setTestAuthToken(null);
    global.fetch = realFetch;
  });

  it('normalises the reputation payload on success', async () => {
    _setTestAuthToken('token');
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ contributions: { level: 'Local Expert', accepted_reports: 4, top_expertise: ['Food'] } }),
    })) as unknown as typeof fetch;

    const res = await getPassportContributions('me');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data?.level).toBe('Local Expert');
      expect(res.data?.acceptedReports).toBe(4);
      expect(res.data?.topExpertise).toEqual(['Food']);
    }
  });

  it('returns ok:null when the server has no contribution record', async () => {
    _setTestAuthToken('token');
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => null })) as unknown as typeof fetch;

    const res = await getPassportContributions('me');
    expect(res).toEqual({ ok: true, data: null });
  });

  it('fails soft on an HTTP error so the caller can fall back to the projection', async () => {
    _setTestAuthToken('token');
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await getPassportContributions('me');
    expect(res.ok).toBe(false);
  });

  it('fails when unauthenticated (no token)', async () => {
    _setTestAuthToken(''); // '' is a non-null seam value → treated as no token
    const res = await getPassportContributions('me');
    expect(res.ok).toBe(false);
  });
});
