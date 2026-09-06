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
 *   • domains      — the server's per-domain trust presentations (TABLE 12):
 *                    one non-stigmatizing word per domain plus the server's own
 *                    applicability decision. Read verbatim, never recomputed.
 *   • capabilities — server-projected POSITIVE capability flags (TABLE 14). The
 *                    UI shows them as "what this unlocks" chips; it must NOT
 *                    infer authorization from the numeric score (§11) — the
 *                    server is the sole authority. These flags drive the chips
 *                    ONLY; domain applicability comes from `trust.domains`.
 *
 * `deriveTrustView` is a pure function exported for direct unit/component
 * testing. It does NOT compute domain applicability or standing at all: both are
 * SERVER measurements, read verbatim off `trust.domains` (TABLE 12).
 *
 * UNKNOWN STAYS UNKNOWN. Where the server did not ship a measurement, this
 * module returns `null` rather than a plausible-looking default — the same
 * convention the numeric score already uses (`score: number | null` +
 * `hasScore`). A missing measurement must never be rendered as if it were one.
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

/**
 * TABLE 12 — one domain's trust presentation, exactly as the SERVER computed it
 * (PassportProjectionService buildDomainTrust). `presentation` is the server's
 * non-stigmatizing word ("Excellent" | "Strong" | "Established" | "Building" |
 * "New" | "Not applicable"); `applicable` is the server's scope decision (e.g.
 * Buddy is false for a user who offers no buddy service). The client renders
 * both verbatim and derives neither.
 */
export interface DomainTrustProjection {
  key: string;
  domain: string;
  presentation: string;
  applicable: boolean;
}

export interface TrustProjection {
  /** Qualitative standing (e.g. "Strong", "New Traveler · Verified"). */
  label: string;
  publicLevel: string;
  /** Numeric 0–100 — present ONLY where the server permits it (self view). */
  score: number | null;
  /** Evidence-aware band: an 82 with high evidence ≠ an 82 with little (§10). */
  confidence: TrustConfidence;
  strengths: string[];
  /** TABLE 12 per-domain presentations. Absent on a projection that predates
   *  the field — absent means UNKNOWN, never "nothing applies". */
  domains?: DomainTrustProjection[];
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
  /** Absent when the server did not project owner capabilities for this viewer.
   *  Absent means UNKNOWN — never "every capability denied". */
  owner?: PassportPositiveCapabilities;
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
  capabilities?: PassportActionCapabilities;
  stats?: TrustStats;
  viewerContext: PassportViewerContext;
  /** Present when privacy/blocking reduced the projection to a minimal card. */
  restricted?: { reason: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single domain-trust row (TABLE 12) — a straight read of the server's own
 * DomainTrust. Nothing here is derived on the client.
 */
export interface TrustDomainRow {
  key: string;
  /** Display name — Overall / Traveler / Trip Guest / … (server-supplied). */
  domain: string;
  /** The SERVER's scope decision for this domain. */
  applicable: boolean;
  /** The SERVER's presentation word, or null when it shipped none (unknown). */
  standing: string | null;
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
  /** Server-measured domain rows, or null when the server shipped none.
   *  null is UNKNOWN — the screen must not render six invented rows. */
  domains: TrustDomainRow[] | null;
  /** True only when the server actually measured the domains. */
  hasDomains: boolean;
  credentials: CredentialProjection[];
  /** Granted capability chips, or null when the server projected no owner
   *  capabilities at all. null is UNKNOWN, distinct from "[] = none granted". */
  capabilityChips: CapabilityChip[] | null;
  /** True only when the server actually projected owner capabilities. */
  hasCapabilities: boolean;
}

/**
 * The word the SERVER sends for an out-of-scope domain (§10, deliberately
 * neutral) — see PassportProjectionService.buildDomainTrust. Exported so tests
 * and future callers can name it; the client never SUBSTITUTES it for a missing
 * measurement, because "out of scope" is a server decision, not a fallback.
 */
export const NOT_APPLICABLE = 'Not applicable';

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

/**
 * Re-shape the trust slice of a PassportProjection into the display model.
 * Pure — no I/O, safe to unit-test.
 *
 * Domain rows (TABLE 12) are a VERBATIM read of `trust.domains` — the server
 * computed both the presentation word (buildDomainTrust → presentationWord) and
 * the applicability decision. The client does not recompute either from
 * capability flags, travel stats or the numeric score (§11).
 *
 * Where a measurement is absent it stays absent: no domains → `domains: null`;
 * no owner capabilities → `capabilityChips: null`. Callers branch on
 * `hasDomains` / `hasCapabilities` the same way they already branch on
 * `hasScore`, and render an honest unknown rather than a plausible default.
 */
export function deriveTrustView(p: TrustProjectionEnvelope): TrustView {
  const trust = p.trust ?? null;

  const hasTrust = !!trust;
  const confidence: TrustConfidence = trust?.confidence ?? 'low';
  const meta = CONFIDENCE_META[confidence];
  const hasScore = typeof trust?.score === 'number';

  // TABLE 12 — server measurement, read straight through. An absent array is
  // UNKNOWN (e.g. a cached projection from before the field shipped), never
  // "no domain applies".
  const serverDomains = Array.isArray(trust?.domains) ? trust!.domains : null;
  const domains: TrustDomainRow[] | null = serverDomains
    ? serverDomains
        .filter((d): d is DomainTrustProjection => !!d && typeof d.key === 'string')
        .map((d) => ({
          key: d.key,
          domain: typeof d.domain === 'string' && d.domain !== '' ? d.domain : d.key,
          // Only an explicit `false` denies scope; anything else is not a
          // server "no", so the row stays in scope and its standing carries
          // whatever the server actually said.
          applicable: d.applicable !== false,
          standing:
            typeof d.presentation === 'string' && d.presentation !== ''
              ? d.presentation
              : null,
        }))
    : null;

  // TABLE 14 — an absent `owner` block is UNKNOWN. Substituting all-false here
  // would hide the chips as though the server had denied every capability.
  const caps = p.capabilities?.owner ?? null;
  const capabilityChips: CapabilityChip[] | null = caps
    ? CAPABILITY_LABELS.filter((c) => caps[c.key] === true).map((c) => ({
        key: c.key,
        label: c.label,
      }))
    : null;

  return {
    hasTrust,
    label: trust?.label ?? 'Trust summary unavailable',
    score: hasScore ? (trust!.score as number) : null,
    hasScore,
    confidence,
    confidenceLabel: meta.label,
    confidenceCopy: meta.copy,
    domains,
    hasDomains: domains !== null,
    credentials: Array.isArray(p.credentials) ? p.credentials : [],
    capabilityChips,
    hasCapabilities: capabilityChips !== null,
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
