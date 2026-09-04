/**
 * Component tests for ContributionCard — the §20 contribution reputation card
 * (TABLE 21).
 *
 * Covers:
 *   1. Renders level, accepted contributions, confirmations, hidden gems and
 *      top expertise from a normalised projection.
 *   2. Renders reputation WITHOUT any private/moderation or paid field — the
 *      card reads only the closed ContributionProjection, so private data
 *      smuggled alongside can never surface (§20).
 *   3. Renders nothing when there is no positive signal.
 *   4. Counts of 0 are suppressed (no zero tiles); only present metrics show.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ContributionCard } from '../ContributionCard.tsx';
import { normalizeContributions } from '../../../services/passportContributions.ts';

// NOTE: intentionally exhaustive — ContributionCard imports passportContributions,
// which imports apiToken → the Supabase client at module load. The card never
// calls it (pure/prop-driven), so a null-returning stub is sufficient.
jest.mock('../../../services/apiToken', () => ({
  freshToken: jest.fn(async () => null),
}));

describe('ContributionCard', () => {
  it('renders the reputation fields from a normalised projection', async () => {
    const data = normalizeContributions({
      level: 'Local Expert',
      acceptedReports: 12,
      confirmations: 7,
      hiddenGems: 3,
      topExpertise: ['Food', 'Nightlife'],
    });

    await render(<ContributionCard data={data} />);

    expect(screen.getByText('Contributions')).toBeTruthy();
    expect(screen.getByText('Local Expert')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('Accepted tips')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('Confirmations')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('Hidden gems')).toBeTruthy();
    expect(screen.getByText('Food')).toBeTruthy();
    expect(screen.getByText('Nightlife')).toBeTruthy();
  });

  it('never surfaces paid or private moderation data (§20)', async () => {
    // Private/paid fields smuggled onto the RAW payload; normalize drops them and
    // the card only ever reads the closed shape — nothing private can leak.
    const data = normalizeContributions({
      level: 'Contributor',
      acceptedReports: 4,
      paidContributions: 50,
      purchasedBoosts: 9,
      reportCount: 6,
      rejectedReports: 8,
      moderationNotes: 'warned for spam',
      safetyHistory: ['banned once'],
    });

    await render(<ContributionCard data={data} />);

    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toMatch(/paid/i);
    expect(tree).not.toMatch(/purchas/i);
    expect(tree).not.toMatch(/moderation/i);
    expect(tree).not.toMatch(/spam/i);
    expect(tree).not.toMatch(/banned/i);
    expect(tree).not.toMatch(/reject/i);
    expect(tree).not.toMatch(/\b50\b/); // paid count never rendered
    // The positive metric still renders.
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('renders nothing when there is no positive signal', async () => {
    const empty = normalizeContributions({ acceptedReports: 0 });
    const r1 = await render(<ContributionCard data={empty} />);
    expect(r1.toJSON()).toBeNull();

    const r2 = await render(<ContributionCard data={null} />);
    expect(r2.toJSON()).toBeNull();
  });

  it('suppresses zero-count metrics but still shows level + expertise', async () => {
    const data = normalizeContributions({
      level: 'Explorer',
      acceptedReports: 0,
      confirmations: 5,
      hiddenGems: 0,
      topExpertise: ['Coffee'],
    });

    await render(<ContributionCard data={data} />);

    expect(screen.getByText('Explorer')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('Confirmations')).toBeTruthy();
    expect(screen.getByText('Coffee')).toBeTruthy();
    // Zero-count metrics are not rendered.
    expect(screen.queryByText('Accepted tips')).toBeNull();
    expect(screen.queryByText('Hidden gems')).toBeNull();
  });
});
