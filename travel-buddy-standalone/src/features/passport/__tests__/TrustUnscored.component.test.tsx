/**
 * Trust — UNSCORED is not zero, and it is not a failed lookup either.
 *
 * Owner decision, 2026-09-22: the fabricated neutral score of 50 is removed
 * server-side. A user with no `trust_profiles` row is UNSCORED. The server has
 * already moved: `buildDomainTrust` now words a `substituted` domain as
 * "Not yet rated" rather than running the absent number through
 * `presentationWord` (which printed "Established" for the 50 — a person nobody
 * had measured, shown a flattering verdict).
 *
 * ── THE CLIENT HALF, AND WHY IT IS A DEFECT AND NOT A WORDING PREFERENCE ────
 *
 * `BASIS_NOTE.substituted` still read "Not yet measured — shown at the neutral
 * starting point." That sentence is printed DIRECTLY UNDER the server's word on
 * the same domain row, and under the server's new word it is false: nothing is
 * shown at a neutral starting point any more, because there is no longer a
 * neutral starting point to be shown at. It also appears verbatim in
 * `TrustScoreInfoSheet`'s basis guide — the surface whose entire job is to
 * explain what a standing rests on.
 *
 * This is the exact failure this repository has had twice: a second client
 * vocabulary describing a server mechanism, left behind when the server changed
 * the mechanism. The band table that contradicted `presentationWord` on the
 * same screen was the first; this is the same shape.
 *
 * The other two tests are the rest of the owner decision, from a person's side:
 *   - UNSCORED and UNREADABLE must not print the same explanation, because one
 *     is a fact about the account and the other is a fact about a database.
 *   - an unscored owner is shown NO number, and is NOT stripped of the
 *     capabilities the server granted them. Lacking a measurement is not a
 *     finding against somebody.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — TrustScreen uses only router.push/back; the
// real module pulls navigation state this suite does not mount.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — the real SessionContext provider starts auth
// and storage work on mount; TrustScreen reads only useSession().
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me', isAuthed: true }),
}));

// NOTE: intentionally exhaustive — apiToken reaches Supabase for a live token;
// null keeps the screen off the network.
jest.mock('../../../services/apiToken', () => ({
  freshToken: jest.fn(async () => null),
}));

jest.mock('../useTrustProjection', () => {
  const actual = jest.requireActual('../useTrustProjection');
  return {
    ...actual,
    useTrustProjection: () => ({ projection: null, loading: false, error: null, reload: jest.fn() }),
  };
});

import TrustScreen from '../TrustScreen.tsx';
import {
  deriveTrustView,
  BASIS_NOTE,
  type TrustProjectionEnvelope,
  type DomainTrustBasis,
} from '../useTrustProjection.ts';

/** Six domains as the server emits them for an account with NO trust profile. */
function unscoredDomains(basis: DomainTrustBasis = 'substituted') {
  return [
    { key: 'overall', domain: 'Overall', presentation: 'Not yet rated', applicable: true, basis },
    { key: 'traveler', domain: 'Traveler', presentation: 'Not yet rated', applicable: true, basis },
    { key: 'trip_guest', domain: 'Trip Guest', presentation: 'Not yet rated', applicable: true, basis },
    { key: 'trip_host', domain: 'Trip Host', presentation: 'Not yet rated', applicable: true, basis },
    { key: 'contributor', domain: 'Contributor', presentation: 'Not yet rated', applicable: true, basis },
    { key: 'buddy', domain: 'Buddy', presentation: 'Not applicable', applicable: false, basis: 'not_applicable' as const },
  ];
}

function unscoredProjection(over: Partial<TrustProjectionEnvelope> = {}): TrustProjectionEnvelope {
  return {
    userId: 'me',
    trust: {
      label: 'New Traveler',
      publicLevel: 'new',
      // No profile row: the server sends no number rather than a made-up one.
      score: null,
      confidence: null,
      confidenceBasis: 'unavailable',
      strengths: [],
      domains: unscoredDomains(),
    },
    credentials: [],
    capabilities: {
      owner: {
        canJoinPublicTrip: true,
        canHostTrip: false,
        canCreateLargePlan: false,
        canUseCrewLocation: false,
        canContributeLiveIntel: false,
        canBecomeBuddy: false,
      },
    },
    stats: { countries: 0, cities: 0, stamps: 0, trips: 0 },
    viewerContext: 'self',
    ...over,
  };
}

describe('Trust — an unscored account', () => {
  it('never explains a standing by a neutral starting point the server no longer substitutes', () => {
    // Every basis sentence the client can print, including the ones
    // TrustScoreInfoSheet's basis guide re-uses. None of them may describe the
    // standing as having been SHOWN AT a default value: the server's word for
    // an unmeasured domain is now "Not yet rated", and a sentence claiming a
    // neutral point was substituted contradicts it on the same row.
    for (const [basis, note] of Object.entries(BASIS_NOTE)) {
      if (!note) continue;
      expect(`${basis}: ${note.toLowerCase()}`).not.toContain('neutral');
      expect(`${basis}: ${note.toLowerCase()}`).not.toContain('starting point');
    }
  });

  it('still says, in words, that an unmeasured area was not measured', () => {
    // Removing the false half must not remove the disclosure itself — an
    // unannotated substituted row is indistinguishable from a measured one.
    const view = deriveTrustView(unscoredProjection());
    const overall = view.domains.find((d) => d.key === 'overall');
    expect(overall?.basis).toBe('substituted');
    expect(String(overall?.basisNote ?? '').toLowerCase()).toContain('not yet measured');
    // And the server's own word is rendered, not re-decided.
    expect(overall?.standing).toBe('Not yet rated');
  });

  it('tells an unscored account apart from one whose trust records could not be read', () => {
    const unscored = deriveTrustView(unscoredProjection());
    const failedProjection = unscoredProjection();
    failedProjection.trust!.domains = unscoredDomains('unavailable');
    const failed = deriveTrustView(failedProjection);

    const unscoredNote = unscored.domains.find((d) => d.key === 'overall')?.basisNote;
    const failedNote = failed.domains.find((d) => d.key === 'overall')?.basisNote;

    // "nobody has measured you yet" and "we could not read the records" are
    // different claims and a person must be able to tell which one they got.
    expect(unscoredNote).toBeTruthy();
    expect(failedNote).toBeTruthy();
    expect(unscoredNote).not.toEqual(failedNote);
    expect(String(failedNote).toLowerCase()).toContain('unavailable');
    expect(String(unscoredNote).toLowerCase()).not.toContain('unavailable');
  });

  it('shows an unscored owner no number at all', async () => {
    await render(<TrustScreen projectionOverride={unscoredProjection()} />);
    // The hero's numeric block is gated on a real score; nothing may stand in
    // for it — not a 0, not a 50, not a bar at some default fill.
    expect(screen.queryByText('/ 100')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText('50')).toBeNull();
  });

  it('does not strip an unscored owner of the capabilities the server granted', async () => {
    // Lacking a measurement is not a finding against somebody. The server said
    // this account may join public trips; the absence of a score must not
    // quietly remove that from the screen.
    await render(<TrustScreen projectionOverride={unscoredProjection()} />);
    expect(screen.queryAllByText('Join public trips').length).toBeGreaterThan(0);
  });
});
