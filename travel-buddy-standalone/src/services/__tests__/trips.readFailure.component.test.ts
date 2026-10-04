/**
 * getTrip / getTripMemberRole — a read that failed is not "no trip" and not
 * "not a member" (census-trips §79).
 *
 * supabase-js RESOLVES `{ data: null, error }` on a failure. getTrip answered
 * `null` for both, and the trip screen renders `null` as "Trip not found —
 * this trip may have been deleted or you may not have access to it", while
 * its honest "Couldn't load this trip / Try again" branch (useTrip's `error`)
 * could never be reached because getTrip never threw. getTripMemberRole did
 * the same to a co-host: an outage read as "not a member", and the edit screen
 * then told a co-host they could not manage the trip.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

type Reply = { data: unknown; error: unknown };
let mockReply: Reply = { data: null, error: null };
let mockSessionUser: string | null = 'u1';

function mockBuilder() {
  const b: any = {
    select: () => b,
    eq: () => b,
    // `.single()` reports "no row" as an error (PGRST116); `.maybeSingle()`
    // reports it as data: null. The fake answers each the way PostgREST does,
    // so the implementation may use either.
    single: async () =>
      mockReply.data === null && mockReply.error === null
        ? { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
        : mockReply,
    maybeSingle: async () => mockReply,
  };
  return b;
}

// NOTE: intentional stub — the database answer is the thing under test.
jest.mock('../../lib/supabase', () => ({
  isSupabaseConfigured: true,
  authedClient: () => null,
  supabase: {
    from: () => mockBuilder(),
    auth: {
      getSession: async () => ({ data: { session: mockSessionUser ? { user: { id: mockSessionUser } } : null } }),
    },
  },
}));

import { getTrip, getTripMemberRole, TripsReadUnavailableError } from '../trips.ts';

const ROW = {
  id: 't1', owner_id: 'u1', title: 'Lisbon', destination_city: 'Lisbon', destination_country: 'PT',
  neighborhoods: [], start_date: '2026-11-01', end_date: '2026-11-05', status: 'planning',
  visibility: 'private', open_to_meet: false, progress: 0,
};

describe('getTrip', () => {
  it('returns the trip when the read answers with a row', async () => {
    mockReply = { data: ROW, error: null };
    const t = await getTrip('t1');
    expect(t?.id).toBe('t1');
    expect(t?.destinationCity).toBe('Lisbon');
  });

  it('returns null when the read answers with NO row (absent or not visible)', async () => {
    mockReply = { data: null, error: null };
    await expect(getTrip('t1')).resolves.toBeNull();
  });

  it('THROWS TripsReadUnavailableError when the read failed — never "not found"', async () => {
    mockReply = { data: null, error: { code: '08006', message: 'connection failure' } };
    await expect(getTrip('t1')).rejects.toBeInstanceOf(TripsReadUnavailableError);
  });
});

describe('getTripMemberRole', () => {
  beforeEach(() => { mockSessionUser = 'u1'; });

  it('returns the role when the read answers with a row', async () => {
    mockReply = { data: { role: 'co_host' }, error: null };
    await expect(getTripMemberRole('t1')).resolves.toBe('co_host');
  });

  it('returns null when the read answers with no row (not a member)', async () => {
    mockReply = { data: null, error: null };
    await expect(getTripMemberRole('t1')).resolves.toBeNull();
  });

  it('returns null when signed out', async () => {
    mockSessionUser = null;
    await expect(getTripMemberRole('t1')).resolves.toBeNull();
  });

  it('THROWS when the read failed — an outage is not "not a member"', async () => {
    mockReply = { data: null, error: { code: '08006', message: 'connection failure' } };
    await expect(getTripMemberRole('t1')).rejects.toBeInstanceOf(TripsReadUnavailableError);
  });
});
