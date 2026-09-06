/**
 * useTrustProjection — data hook + presentation deriver for the Passport
 * Trust & Credentials surface (spec §9/§10/§11, TABLE 12/13/14).
 *
 * Trust is owned by the SERVER. This module never computes trust, authorization
 * or eligibility on the client — it only fetches the canonical, privacy-filtered
 * PassportProjection aggregate (`GET /api/passport/:userId/projection`, already
 * on main) and re-shapes the trust-relevant slices for display:
 *
 *   • trust        — 0–100 score (present ONLY where the server chose to expose
 *                    it, i.e. self / permitted view), qualitative label and the
 *                    evidence-aware confidence band (§9/§10).
 *   • credentials  — positive, server-sanitised credentials (TABLE 13). The
 *                    server strips private report counts / moderation evidence
 *                    before they ever reach the client (§10); this hook only
 *                    ever reads the whitelisted positive fields.
 *   • capabilities — server-projected POSITIVE capability flags (TABLE 14). The
 *                    UI shows them as "what this unlocks" chips; it must NOT
 *                    infer authorization from the numeric score (§11) — the
 *                    server is the sole authority, so applicability comes from
 *                    these flags, never from `score`.
 *
 * `deriveTrustView` is a pure function exported for direct unit/component
 * testing. It does NOT read the numeric score to decide domain applicability —
 * that is derived from server-owned capability flags and travel evidence only.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext.tsx';
import { freshToken } from '../../services/apiToken.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Backend projection contract (the subset the Trust surface consumes).
// Mirrors api-server services/passport/PassportProjectionService.ts. We only
// declare the whitelisted, positive fields — the private report/moderation/
// safety-history fields are never part of the contract and never rendered.
// ─────────────────────────────────────────────────────────────────────────────

export type TrustConfidence = 'low' | 'medium' | 'high';

export interface TrustProjection {
  /** Qualitative standing (e.g. "Strong", "New Traveler · Verified"). */
  label: string;
  publicLevel: string;
  /** Numeric 0–100 — present ONLY where the server permits it (self view). */
  score: number | null;
  /** Evidence-aware band: an 82 with high evidence ≠ an 82 with little (§10). */
  confidence: TrustConfidence;
  strengths: string[];
  /**
   * Ordered recovery advice — present ONLY on the owner's own view, because the
   * server emits it only for `context === "self"` (its presence would otherwise
   * disclose to another viewer that this user is in recovery). Absent is the
   * server's decision, never something the client fills in: no default hints, no
   * client-side derivation from the score or the categories.
   */
  recoveryHints?: string[];
}

export interface CredentialProjection {
  key: string;
  label: string;
  /** Server-sanitised positive detail (e.g. "Good standing", "8 trips"). */
  detail: string | null;
  tier: 'verified' | 'positive';
}

/** Positive owner capabilities (TABLE 14) — server-owned authorization signals. */
export interface PassportPositiveCapabilities {
  canJoinPublicTrip: boolean;
  canHostTrip: boolean;
  canCreateLargePlan: boolean;
  canUseCrewLocation: boolean;
  canContributeLiveIntel: boolean;
  canBecomeBuddy: boolean;
}

export interface PassportActionCapabilities {
  owner: PassportPositiveCapabilities;
  /** Per-viewer action flags (TABLE 29). Not rendered by the Trust surface. */
  actions?: Record<string, boolean>;
}

export interface TrustStats {
  countries: number;
  cities: number;
  stamps: number;
  trips: number;
}

export type PassportViewerContext =
  | 'self'
  | 'public'
  | 'follower'
  | 'following'
  | 'trip_crew'
  | 'trip_host'
  | 'buddy_customer'
  | 'buddy_provider'
  | 'event_group';

/** The trust-relevant slice of the §29 PassportProjection aggregate. */
export interface TrustProjectionEnvelope {
  userId: string;
  identity?: { name?: string | null; handle?: string | null; verified?: boolean };
  trust?: TrustProjection;
  credentials: CredentialProjection[];
  capabilities: PassportActionCapabilities;
  stats: TrustStats;
  viewerContext: PassportViewerContext;
  /** Present when privacy/blocking reduced the projection to a minimal card. */
  restricted?: { reason: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation model
// ─────────────────────────────────────────────────────────────────────────────

/** A single domain-trust row (TABLE 12). */
export interface TrustDomainRow {
  key: string;
  /** Display name — Overall / Traveler / Trip Guest / … */
  domain: string;
  /** Server says this domain is in scope for the owner. */
  applicable: boolean;
  /** Qualitative standing, or the non-stigmatizing "Not applicable". */
  standing: string;
}

export interface CapabilityChip {
  key: string;
  label: string;
}

export interface TrustView {
  hasTrust: boolean;
  /** Qualitative label — rendered verbatim so server's non-stigmatizing copy
   *  (e.g. "New Traveler · Verified") is preserved for low-evidence accounts. */
  label: string;
  /** Numeric 0–100 — non-null ONLY when the server exposed it. */
  score: number | null;
  hasScore: boolean;
  confidence: TrustConfidence;
  /** Short confidence heading, e.g. "High confidence". */
  confidenceLabel: string;
  /** Non-stigmatizing sentence explaining the evidence level (§10). */
  confidenceCopy: string;
  domains: TrustDomainRow[];
  credentials: CredentialProjection[];
  capabilityChips: CapabilityChip[];
  /**
   * Server-authored recovery advice, verbatim and in server order. Empty when
   * the server did not send any — either because this is not the owner's view
   * (the field is absent) or because the owner has nothing to recover (an empty
   * array). The screen renders the section only when this is non-empty; it never
   * substitutes copy of its own for an absent read.
   */
  recoveryHints: string[];
}

/** Sentinel standing for out-of-scope domains — deliberately neutral (§10). */
export const NOT_APPLICABLE = 'Not applicable';

/** Standing shown for an in-scope domain the server vouches for. */
const IN_GOOD_STANDING = 'In good standing';

/**
 * Confidence copy is intentionally non-stigmatizing for new users (§10): the
 * low band frames a fresh account as a natural starting point, not a deficit.
 */
const CONFIDENCE_META: Record<TrustConfidence, { label: string; copy: string }> = {
  high: {
    label: 'High confidence',
    copy: 'Backed by a substantial travel and contribution history.',
  },
  medium: {
    label: 'Growing confidence',
    copy: 'Backed by a growing history — it strengthens as you travel and contribute.',
  },
  low: {
    label: 'Early days',
    copy: 'New accounts start here. Trust builds naturally as you travel and contribute.',
  },
};

/** Positive capability flags → chip labels (TABLE 14). Order is intentional. */
const CAPABILITY_LABELS: ReadonlyArray<{ key: keyof PassportPositiveCapabilities; label: string }> = [
  { key: 'canJoinPublicTrip', label: 'Join public trips' },
  { key: 'canHostTrip', label: 'Host trips' },
  { key: 'canCreateLargePlan', label: 'Create large plans' },
  { key: 'canUseCrewLocation', label: 'Share crew location' },
  { key: 'canContributeLiveIntel', label: 'Contribute live intel' },
  { key: 'canBecomeBuddy', label: 'Become a Buddy' },
];

const EMPTY_CAPS: PassportPositiveCapabilities = {
  canJoinPublicTrip: false,
  canHostTrip: false,
  canCreateLargePlan: false,
  canUseCrewLocation: false,
  canContributeLiveIntel: false,
  canBecomeBuddy: false,
};

/**
 * Re-shape the trust slice of a PassportProjection into the display model.
 * Pure — no I/O, safe to unit-test.
 *
 * Domain applicability (TABLE 12) is derived from SERVER-OWNED capability flags
 * and travel evidence — never from the numeric score (§11). "Overall" carries
 * the server's qualitative label; in-scope specific domains read "In good
 * standing"; out-of-scope domains read the neutral "Not applicable".
 */
export function deriveTrustView(p: TrustProjectionEnvelope): TrustView {
  const trust = p.trust ?? null;
  const caps = p.capabilities?.owner ?? EMPTY_CAPS;
  const stats = p.stats ?? { countries: 0, cities: 0, stamps: 0, trips: 0 };

  const hasTrust = !!trust;
  const confidence: TrustConfidence = trust?.confidence ?? 'low';
  const meta = CONFIDENCE_META[confidence];
  const hasScore = typeof trust?.score === 'number';
  const overall = trust?.label ?? NOT_APPLICABLE;

  // Traveler scope: any real travel evidence, or the base "join trips" grant.
  const hasTravelEvidence = stats.stamps > 0 || stats.countries > 0 || caps.canJoinPublicTrip;

  const specific = (applicable: boolean): string => (applicable ? IN_GOOD_STANDING : NOT_APPLICABLE);

  const domains: TrustDomainRow[] = [
    { key: 'overall', domain: 'Overall', applicable: hasTrust, standing: hasTrust ? overall : NOT_APPLICABLE },
    { key: 'traveler', domain: 'Traveler', applicable: hasTrust && hasTravelEvidence, standing: specific(hasTrust && hasTravelEvidence) },
    { key: 'trip_guest', domain: 'Trip Guest', applicable: caps.canJoinPublicTrip, standing: specific(caps.canJoinPublicTrip) },
    { key: 'trip_host', domain: 'Trip Host', applicable: caps.canHostTrip, standing: specific(caps.canHostTrip) },
    { key: 'contributor', domain: 'Contributor', applicable: caps.canContributeLiveIntel, standing: specific(caps.canContributeLiveIntel) },
    { key: 'buddy', domain: 'Buddy', applicable: caps.canBecomeBuddy, standing: specific(caps.canBecomeBuddy) },
  ];

  // Owner-only, server-gated (§9/§10). The client passes the strings through
  // untouched — it must not invent, reorder, translate or top up hints, because
  // an absent field means "the server did not send this", not "none exist".
  const recoveryHints: string[] = Array.isArray(trust?.recoveryHints)
    ? trust!.recoveryHints.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
    : [];

  const capabilityChips: CapabilityChip[] = CAPABILITY_LABELS
    .filter((c) => caps[c.key])
    .map((c) => ({ key: c.key, label: c.label }));

  return {
    hasTrust,
    label: trust?.label ?? 'Trust summary unavailable',
    score: hasScore ? (trust!.score as number) : null,
    hasScore,
    confidence,
    confidenceLabel: meta.label,
    confidenceCopy: meta.copy,
    domains,
    credentials: Array.isArray(p.credentials) ? p.credentials : [],
    capabilityChips,
    recoveryHints,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service — fetch the projection aggregate
// ─────────────────────────────────────────────────────────────────────────────

type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/**
 * Fetch the PassportProjection aggregate for `userId` (a profile UUID or
 * @handle). Returns the trust-relevant envelope, unwrapped from `{ projection }`.
 * Fails soft with a message the screen can surface with a retry affordance.
 */
export async function getPassportProjection(
  userId: string,
): Promise<ApiResult<TrustProjectionEnvelope>> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(
      `${apiBase()}/api/passport/${encodeURIComponent(userId)}/projection`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any)?.message ?? `API ${res.status}` };
    }
    const json = await res.json();
    const projection = (json as any)?.projection ?? null;
    if (!projection) return { ok: false, message: 'Trust summary unavailable' };
    return { ok: true, data: projection as TrustProjectionEnvelope };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export interface UseTrustProjectionResult {
  projection: TrustProjectionEnvelope | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads the PassportProjection for `userId`, defaulting to the signed-in user
 * (whose own view is where the server permits the numeric score, §9). On error
 * `projection` is null and `error` carries a message for the retry affordance.
 */
export function useTrustProjection(userId?: string): UseTrustProjectionResult {
  const session = useSession();
  const targetId = userId ?? session.userId ?? null;

  const [projection, setProjection] = useState<TrustProjectionEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!targetId) {
      setProjection(null);
      setError('Sign in to view your trust summary');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await getPassportProjection(targetId);
    if (res.ok) {
      setProjection(res.data);
    } else {
      setError(res.message);
      setProjection(null);
    }
    setLoading(false);
  }, [targetId]);

  useEffect(() => {
    load();
  }, [load]);

  return { projection, loading, error, reload: load };
}
