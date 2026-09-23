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
 * testing. It does NOT read the numeric score to decide domain applicability
 * (§11). Per-domain trust (TABLE 12) is ADOPTED from `trust.domains` — the
 * word, the applicability and the `basis` are all the server's answers, and the
 * capability-derived rows are a fallback for a server that predates TABLE 12.
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
/** The view's band, plus the state for "the server did not band this". */
export type TrustConfidenceState = TrustConfidence | 'unknown';

/**
 * What a domain's word RESTS ON — server-owned (`domainTrustBasis` in
 * api-server services/passport/PassportProjectionService.ts). This is the field
 * that makes P45's "explainable" clause real: without it a neutral-50
 * SUBSTITUTION and a genuine MEASUREMENT print the same word and a person
 * cannot tell them apart.
 */
export type DomainTrustBasis =
  | 'measured'
  | 'partial'
  | 'substituted'
  | 'not_applicable'
  | 'unavailable'
  /** Client-only: derived from capability flags because the server sent no
   *  `trust.domains` (a deployment older than TABLE 12). */
  | 'client_derived';

/** One server-computed domain presentation (TABLE 12). Words only, never a number. */
export interface ServerDomainTrust {
  key: string;
  domain: string;
  /** The non-stigmatizing word the SERVER computed. Rendered verbatim. */
  presentation: string;
  applicable: boolean;
  basis: DomainTrustBasis;
}

export interface TrustProjection {
  /** Qualitative standing (e.g. "Strong", "New Traveler · Verified"). */
  label: string;
  publicLevel: string;
  /** Numeric 0–100 — present ONLY where the server permits it (self view). */
  score: number | null;
  /**
   * Evidence-aware band: an 82 with high evidence ≠ an 82 with little (§10).
   * NULL means NOT MEASURED — the server sends null rather than a band when it
   * has nothing to band, and defaulting that to 'low' would print "Early days"
   * over a person the server declined to describe.
   */
  confidence: TrustConfidence | null;
  /** What `confidence` was computed from — trust evidence, or a travel proxy. */
  confidenceBasis?: 'trust_evidence' | 'travel_proxy' | 'unavailable';
  /**
   * The server READ of `trust_profiles` failed. Everything else on this object
   * is the server's fallback shape, not a measurement of this person.
   */
  degraded?: boolean;
  strengths: string[];
  /**
   * Ordered recovery advice — present ONLY on the owner's own view, because the
   * server emits it only for `context === "self"` (its presence would otherwise
   * disclose to another viewer that this user is in recovery). Absent is the
   * server's decision, never something the client fills in: no default hints, no
   * client-side derivation from the score or the categories.
   */
  recoveryHints?: string[];
  /** TABLE 12, server-owned. Absent only on a server older than TABLE 12. */
  domains?: ServerDomainTrust[];
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
  /** What `standing` rests on. See `DomainTrustBasis`. */
  basis: DomainTrustBasis;
  /**
   * Human-readable disclosure for a standing that is NOT a measurement, or
   * `null` when the word is measured and needs no qualification. Deliberately
   * null on the measured branch: an annotation printed on every row is
   * decoration, not a distinction.
   */
  basisNote: string | null;
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
  confidence: TrustConfidenceState;
  /**
   * TRUE when the server could not read this person's trust records. Everything
   * on this view is then the server's fallback shape. The screen must say so
   * and offer a retry; rendering it as an ordinary result is the defect.
   */
  degraded: boolean;
  /** Short confidence heading, e.g. "High confidence". */
  confidenceLabel: string;
  /** Non-stigmatizing sentence explaining the evidence level (§10). */
  confidenceCopy: string;
  /** Server-chosen strongest trust areas (at most 2, already privacy-filtered).
   *  Rendered verbatim; an absent/empty list stays empty — the client never
   *  substitutes a placeholder strength. */
  strengths: string[];
  domains: TrustDomainRow[];
  /** Positive credentials, minus the server's `strength_*` re-encoding of any
   *  strength this view already renders (see `strengths`) — so a strength is
   *  shown exactly once, never twice on the same screen. */
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

/**
 * Standing shown when the server sent no word for this domain at all. It is not
 * a rating, and it is deliberately about the LOAD rather than the person: the
 * client cannot tell an old server from a dropped field, and neither is a fact
 * about the traveler.
 */
const STANDING_UNKNOWN = 'Not available';

/**
 * Confidence copy is intentionally non-stigmatizing for new users (§10): the
 * low band frames a fresh account as a natural starting point, not a deficit.
 */
const CONFIDENCE_META: Record<TrustConfidenceState, { label: string; copy: string }> = {
  // NOT a band. The server sends no confidence when it has nothing to band, and
  // this row says so instead of borrowing 'low'. "Early days" over an unread
  // profile is a sentence about a person that nothing behind it supports.
  unknown: {
    label: 'Confidence unavailable',
    copy: 'We could not read this traveler\u2019s trust records just now. Nothing here is a measurement.',
  },
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
 * Copy for a standing that is not a measurement (§10 — non-stigmatizing: a
 * missing measurement is described as an absence of records, never as a
 * deficiency of the person).
 */
const BASIS_NOTE: Record<DomainTrustBasis, string | null> = {
  measured: null,
  partial: 'Based on part of the record so far.',
  // The server no longer shows a rating word here, so this note no longer ends
  // "shown at the neutral starting point": there is no starting point on
  // display for it to explain, and saying there is would put the substituted 50
  // back on the screen in words after the word itself stopped carrying it.
  substituted: 'Not yet measured — no ratings have been recorded for this area.',
  not_applicable: null,
  unavailable: 'Trust records are unavailable right now.',
  client_derived: null,
};

/**
 * Adopt the SERVER's TABLE 12 domains verbatim. The server computed each word
 * from the canonical category scores and said what that word rests on; the
 * client's job is to display it, not to re-decide it. Re-deciding is exactly
 * what this module's own header forbids ("Trust is owned by the SERVER") and
 * what the spec's canonical-architecture rule forbids ("Other surfaces request
 * the appropriate Passport projection instead of rebuilding … trust …
 * independently").
 */
function domainsFromServer(rows: ServerDomainTrust[]): TrustDomainRow[] {
  return rows.map((r) => {
    const basis: DomainTrustBasis = r.basis ?? 'measured';
    return {
      key: String(r.key),
      domain: String(r.domain),
      applicable: !!r.applicable,
      standing: String(r.presentation),
      basis,
      basisNote: BASIS_NOTE[basis] ?? null,
    };
  });
}

/**
 * Re-shape the trust slice of a PassportProjection into the display model.
 * Pure — no I/O, safe to unit-test.
 *
 * Domain trust (TABLE 12) comes from the SERVER when the projection carries it:
 * the word, the applicability and the basis are all the server's answers. The
 * capability-derived rows below are a FALLBACK for a server that predates
 * TABLE 12 — they are marked `client_derived` so a reader can tell that this
 * row was not measured anywhere.
 */
export function deriveTrustView(p: TrustProjectionEnvelope): TrustView {
  const trust = p.trust ?? null;
  const caps = p.capabilities?.owner ?? EMPTY_CAPS;
  // `p.stats` is no longer read here. It fed `hasTravelEvidence`, which decided
  // whether the Traveler domain was "in good standing" — travel volume standing
  // in for a trust measurement. That decision is gone with the rows it served,
  // and zeroed stats are not the same fact as unknown stats anyway.

  const hasTrust = !!trust;
  // `?? 'low'` used to stand here. A server that sends NO band is saying it has
  // nothing to band, and 'low' is a band — the fallback turned an absence into
  // the "Early days" sentence. Absent is now its own state.
  const confidence: TrustConfidenceState = trust?.confidence ?? 'unknown';
  const meta = CONFIDENCE_META[confidence];
  // A failed READ is the server's own word for it, not something the client
  // infers from an empty-looking payload.
  const degraded = trust?.degraded === true
    || trust?.confidenceBasis === 'unavailable'
    || (Array.isArray(trust?.domains) && trust!.domains!.length > 0
        && trust!.domains!.every((d) => d.basis === 'unavailable'));
  const hasScore = typeof trust?.score === 'number';

  // `specific()` used to turn a capability flag into the words "In good
  // standing". A capability is permission to DO something; standing is a
  // statement about a person's record, and the two are not the same fact.
  // Deriving one from the other is how six rows came to read as measurements on
  // a screen where nothing had been measured, so the derivation is gone.

  const unknown = (key: string, domain: string): TrustDomainRow => ({
    key,
    domain,
    // The domain still APPLIES; what is missing is the standing. Marking these
    // inapplicable would say the domain does not apply to this person, which is
    // a different claim and also one we cannot support here.
    applicable: true,
    standing: STANDING_UNKNOWN,
    basis: 'client_derived',
    basisNote: 'This traveler\u2019s standing could not be loaded.',
  });

  // An EMPTY array is treated the same as an absent one. The server never emits
  // zero domains — TABLE 12 always returns six — so an empty array means the
  // field did not survive transport, and blanking the surface on it would turn a
  // serialization bug into "this person has no trust in any area".
  const serverDomains = Array.isArray(trust?.domains) && trust!.domains!.length > 0
    ? trust!.domains!
    : null;

  // No server domains means one of two things — a server older than TABLE 12, or
  // a field that did not survive transport — and the client can tell neither
  // from the other. Both are "we do not know", so the LAYOUT is kept (six named
  // areas, so the screen does not silently collapse) and every row says its
  // standing could not be loaded. It is not blank, and it is not invented.
  const domains: TrustDomainRow[] = serverDomains
    ? domainsFromServer(serverDomains)
    : [
        unknown('overall', 'Overall'),
        unknown('traveler', 'Traveler'),
        unknown('trip_guest', 'Trip Guest'),
        unknown('trip_host', 'Trip Host'),
        unknown('contributor', 'Contributor'),
        unknown('buddy', 'Buddy'),
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

  // Strengths are SERVER-chosen (top categories above the server's threshold).
  // We only drop values that are not renderable strings — we never invent one,
  // and an absent list stays empty rather than becoming a default.
  const strengths: string[] = Array.isArray(trust?.strengths)
    ? trust!.strengths.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];

  // The server ALSO re-encodes the same top strengths as `strength_*`
  // credentials (PassportProjectionService.buildCredentials). Rendering both
  // would print the identical label twice on one screen, so a strength we
  // render here is removed from the credentials list — and only then, so no
  // credential is ever hidden without being shown somewhere.
  const shown = new Set(strengths);
  const rawCredentials = Array.isArray(p.credentials) ? p.credentials : [];
  const credentials = rawCredentials.filter(
    (c) => !(typeof c?.key === 'string' && c.key.startsWith('strength_') && shown.has(c.label)),
  );

  return {
    hasTrust,
    degraded,
    label: trust?.label ?? 'Trust summary unavailable',
    score: hasScore ? (trust!.score as number) : null,
    hasScore,
    confidence,
    confidenceLabel: meta.label,
    confidenceCopy: meta.copy,
    strengths,
    domains,
    credentials,
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
