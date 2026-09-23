/**
 * census-passport P50 — a confidence band the server did NOT measure must not
 * render as one it did.
 *
 * The server's own `passportTrustConfidence`
 * (artifacts/api-server/src/services/passport/PassportProjectionService.ts)
 * returns `null` — declared `TrustConfidenceBand | null` — in four distinct
 * cases: the trust profile is absent, it is unreadable, its `evidence_weight`
 * is missing, or that weight is non-finite/negative. Its own comment says why:
 * "neither of them is evidence, so neither may produce a band."
 *
 * `deriveTrustView` then did `trust?.confidence ?? 'low'`, so all four arrived
 * on the hero as the `low` band — label "Early days", copy "New accounts start
 * here." A person whose trust records could not be READ was told, in the
 * product's own reassuring voice, that they were a new account.
 *
 * This is NOT an edge case. census-passport §3 measured 56 of 58 production
 * accounts with no `trust_profiles` row at all, so `null` is the answer almost
 * every real user's projection carries today.
 *
 * WHAT IS ASSERTED: the outcome a person reads, and the distinction the server
 * already draws. The absent case and the unreadable case get DIFFERENT copy,
 * because "we have not measured you yet" and "we cannot reach your records"
 * are different claims — `confidenceBasis` is the server field that separates
 * them, and it had no consumer before this.
 *
 * The three real bands are asserted unchanged, so the fix cannot pass by
 * blanking the feature.
 */
import { deriveTrustView, type TrustProjectionEnvelope } from '../useTrustProjection.ts';

const BASE: TrustProjectionEnvelope = {
  trust: {
    label: 'New Traveler',
    score: null,
    confidence: null,
    publicLevel: 'new_traveler',
  },
} as unknown as TrustProjectionEnvelope;

function withTrust(patch: Record<string, unknown>): TrustProjectionEnvelope {
  return {
    ...BASE,
    trust: { ...(BASE as any).trust, ...patch },
  } as unknown as TrustProjectionEnvelope;
}

describe('P50 — an unmeasured confidence band says so', () => {
  it('a null confidence is NOT rendered as the low band', () => {
    const view = deriveTrustView(withTrust({ confidence: null }));
    expect(view.confidence).toBeNull();
    expect(view.confidenceLabel).not.toBe('Early days');
    expect(view.confidenceCopy).not.toMatch(/New accounts start here/i);
  });

  it('an ABSENT profile reads as not yet measured', () => {
    const view = deriveTrustView(withTrust({ confidence: null }));
    expect(view.confidenceLabel).toBe('Not yet measured');
    expect(view.confidenceCopy).toMatch(/recorded history/i);
  });

  it('an UNREADABLE profile is a different claim from an absent one', () => {
    const unreadable = deriveTrustView(
      withTrust({ confidence: null, confidenceBasis: 'unavailable' }),
    );
    const absent = deriveTrustView(withTrust({ confidence: null }));
    expect(unreadable.confidenceLabel).toBe('Not available');
    expect(unreadable.confidenceCopy).toMatch(/unavailable/i);
    expect(unreadable.confidenceCopy).not.toBe(absent.confidenceCopy);
  });

  it('a missing trust object at all is still not the low band', () => {
    const view = deriveTrustView({} as TrustProjectionEnvelope);
    expect(view.confidence).toBeNull();
    expect(view.confidenceLabel).toBe('Not yet measured');
  });

  it('the three REAL bands still render their own words', () => {
    expect(deriveTrustView(withTrust({ confidence: 'high' })).confidenceLabel).toBe('High confidence');
    expect(deriveTrustView(withTrust({ confidence: 'medium' })).confidenceLabel).toBe('Growing confidence');

    const low = deriveTrustView(withTrust({ confidence: 'low' }));
    expect(low.confidence).toBe('low');
    expect(low.confidenceLabel).toBe('Early days');
    expect(low.confidenceCopy).toMatch(/New accounts start here/i);
  });
});
