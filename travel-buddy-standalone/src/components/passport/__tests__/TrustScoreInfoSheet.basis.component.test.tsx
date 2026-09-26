/**
 * TrustScoreInfoSheet — the sheet must not assert a SECOND standing vocabulary.
 *
 * ## The defect these tests pin
 *
 * The sheet's no-breakdown branch used to render a `TierGuide`: five bands of a
 * 0–100 score mapped to five names — 80–100 "Trusted Traveler", 60–79 "Community
 * Member", 40–59 "Growing Traveler", 20–39 "New Explorer", 0–19 "Getting
 * Started".
 *
 * The SERVER owns the standing word, and it uses different words on different
 * boundaries — `presentationWord` in
 * `artifacts/api-server/src/services/passport/PassportProjectionService.ts`
 * returns `>=80 Excellent`, `>=65 Strong`, `>=50 Established`, `>=35 Building`,
 * else `New`.
 *
 * So the guide that existed to EXPLAIN the word contradicted it, on the same
 * screen, at the same moment: a 62 is "Established" to the server and was
 * "Community Member" to the guide; a 45 is "Building" but was "Growing
 * Traveler"; a 25 is "New" but was "New Explorer". A person reading the sheet
 * was handed two different answers to one question and no way to tell which
 * one their Passport actually says.
 *
 * ## What these tests assert
 *
 * The OUTCOME a person reads — that the sheet prints the server's word and no
 * competing band label beside it — not the shape of a fixture. Case 3 in
 * particular walks the three scores where the two vocabularies visibly
 * disagreed and asserts the contradiction is gone at each.
 *
 * Case 4 pins the replacement copy to its single source of truth: the sentences
 * the sheet now shows are read back out of `deriveTrustView` (i.e. out of
 * `BASIS_NOTE` in `src/features/passport/useTrustProjection.ts`, the same copy
 * `TrustScreen` already prints beside each domain row) rather than re-typed
 * here, so the sheet drifting into a third vocabulary fails a test.
 *
 * ## Modal strategy
 * TrustScoreInfoSheet IS a Modal. The Modal Proxy replaces react-native's Modal
 * with a synchronous View so act() scopes don't overlap — see
 * .agents/memory/modal-proxy-mock.md. Must be declared before any import that
 * touches react-native.
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports. This is a
// Proxy over jest.requireActual, not an exhaustive stand-in: every export but
// `Modal` passes straight through to the real module.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({
    children,
    visible,
  }: {
    children: React.ReactNode;
    visible: boolean;
  }) => (visible ? R.createElement(actual.View, null, children) : null);
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react-native';
import { TrustScoreInfoSheet } from '../TrustScoreInfoSheet.tsx';
import {
  deriveTrustView,
  type TrustProjectionEnvelope,
} from '../../../features/passport/useTrustProjection.ts';

// ── The vocabulary that must never reappear ──────────────────────────────────

/**
 * The five band names of the removed `TierGuide`, with the score each band
 * claimed and the word the SERVER returns for that same score. Every pair is a
 * contradiction the sheet used to print.
 */
const CONTRADICTIONS = [
  { score: 91, serverWord: 'Excellent', bandLabel: 'Trusted Traveler', bandRange: '80–100' },
  { score: 62, serverWord: 'Established', bandLabel: 'Community Member', bandRange: '60–79' },
  { score: 45, serverWord: 'Building', bandLabel: 'Growing Traveler', bandRange: '40–59' },
  { score: 25, serverWord: 'New', bandLabel: 'New Explorer', bandRange: '20–39' },
  { score: 10, serverWord: 'New', bandLabel: 'Getting Started', bandRange: '0–19' },
] as const;

const BAND_LABELS = CONTRADICTIONS.map((c) => c.bandLabel);
const BAND_RANGES = CONTRADICTIONS.map((c) => c.bandRange);

// ── The replacement copy, read from its source of truth ──────────────────────

function envelope(): TrustProjectionEnvelope {
  return {
    userId: 'u1',
    trust: {
      label: 'Established',
      publicLevel: 'established',
      score: 62,
      confidence: 'medium',
      strengths: [],
      domains: [
        { key: 'overall', domain: 'Overall', presentation: 'Established', applicable: true, basis: 'measured' },
        { key: 'traveler', domain: 'Traveler', presentation: 'Building', applicable: true, basis: 'partial' },
        { key: 'trip_host', domain: 'Trip Host', presentation: 'Established', applicable: true, basis: 'substituted' },
      ],
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
    stats: { countries: 2, cities: 4, stamps: 6, trips: 3 },
    viewerContext: 'self',
  };
}

/** The `BASIS_NOTE` sentences for `partial` and `substituted`, straight from the hook. */
function shippedBasisNotes(): { partial: string; substituted: string } {
  const rows = deriveTrustView(envelope()).domains;
  const byBasis = (b: string) => {
    const note = rows.find((r) => r.basis === b)?.basisNote;
    if (!note) throw new Error(`fixture drift: no basisNote for basis "${b}"`);
    return note;
  };
  return { partial: byBasis('partial'), substituted: byBasis('substituted') };
}

const noop = () => {};

async function renderSheet(score: number | null, label: string | null) {
  return render(
    <TrustScoreInfoSheet
      visible
      onClose={noop}
      score={score}
      label={label}
      breakdown={null}
    />,
  );
}

afterEach(cleanup);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TrustScoreInfoSheet — one standing vocabulary, the server\'s', () => {
  it('prints no band label from the removed tier guide', async () => {
    await renderSheet(62, 'Established');

    for (const band of BAND_LABELS) {
      expect(screen.queryByText(band)).toBeNull();
    }
  });

  it('prints no 0–100 band range', async () => {
    await renderSheet(62, 'Established');

    for (const range of BAND_RANGES) {
      expect(screen.queryByText(range)).toBeNull();
    }
  });

  it.each(CONTRADICTIONS)(
    'at $score shows the server word "$serverWord" and never "$bandLabel"',
    async ({ score, serverWord, bandLabel }) => {
      await renderSheet(score, serverWord);

      // The server's word is what the person reads...
      expect(screen.getByText(new RegExp(serverWord))).toBeTruthy();
      // ...and nothing on the sheet offers a competing name for the same score.
      expect(screen.queryByText(bandLabel)).toBeNull();
    },
  );

  it('explains a standing using the sentences the app already ships', async () => {
    const notes = shippedBasisNotes();

    await renderSheet(62, 'Established');

    // The replacement copy IS `BASIS_NOTE` — not a re-typed paraphrase.
    expect(screen.getByText(notes.partial)).toBeTruthy();
    expect(screen.getByText(notes.substituted)).toBeTruthy();
  });

  it('still explains what the score is and how it is derived', async () => {
    await renderSheet(62, 'Established');

    // "Preserve useful explanatory access": the sheet must still say what trust
    // means and what it is built from, not merely drop the table.
    expect(screen.getByText('HOW IT WORKS')).toBeTruthy();
    expect(screen.getByText(/ID verification, passport stamps, account age/)).toBeTruthy();
    expect(screen.getByText('WHAT A STANDING RESTS ON')).toBeTruthy();
  });

  it('does not report a trust outage as a standing basis', async () => {
    await renderSheet(62, 'Established');

    // `BASIS_NOTE.unavailable` is a live transport state, not a basis. Listing
    // it as static explanatory copy would state an outage that is not happening.
    expect(screen.queryByText(/unavailable right now/)).toBeNull();
  });

  it('keeps the factor breakdown branch untouched when a breakdown is present', async () => {
    await render(
      <TrustScoreInfoSheet
        visible
        onClose={noop}
        score={62}
        label="Established"
        breakdown={{
          factors: [
            { key: 'profile_complete', label: 'Profile complete', points: 20, maxPoints: 20, maxed: true, hint: null },
          ],
        }}
      />,
    );

    expect(screen.getByText('HOW YOUR SCORE IS CALCULATED')).toBeTruthy();
    expect(screen.getByText('Profile complete')).toBeTruthy();
    // The band vocabulary is gone from this branch too (it never rendered here,
    // and must not arrive here as a "fix").
    for (const band of BAND_LABELS) {
      expect(screen.queryByText(band)).toBeNull();
    }
  });
});
