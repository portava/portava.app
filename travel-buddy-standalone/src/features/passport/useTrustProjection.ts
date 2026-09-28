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
  /**
   * NOTHING in this domain was measured. The server's word for it is
   * "Not yet rated" — it no longer substitutes a neutral score and words that
   * (owner decision, 2026-09-22), so this basis means UNSCORED, not "scored at
   * the default". It is emphatically NOT `unavailable`: that one is a failed
   * READ of `trust_profiles` and is a fact about a database, not the account.
   */
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
   *
   * NULLABLE, because the server's own field is: `passportTrustConfidence`
   * returns null for an absent or unreadable trust profile and for a missing
   * evidence weight, and census-passport §3 measured 56 of 58 production
   * accounts with no trust profile at all — so null is the NORMAL answer, not
   * an edge case. `deriveTrustView` has read it as nullable since the coercion
   * to `'low'` was removed; this declaration was the half that did not follow,
   * and it made the `?? null` below look like dead defensive code.
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
  /**
   * The band, or `null` = NOT MEASURED. The server's own
   * `passportTrustConfidence` returns null for an absent or unreadable trust
   * profile and for a missing/corrupt evidence weight, so null is the
   * production-NORMAL answer, not an edge case: census-passport §3 measured 56
   * of 58 accounts with no trust profile at all. Coercing it to `'low'` printed
   * "Early days" — a measured-looking band — over four different kinds of
   * not-measured.
   *
   * MERGE DECISION, 2026-09-23. The other lane modelled the same absence as a
   * `'unknown'` MEMBER of the band union. Both carry "no band", but a pseudo-band
   * sitting beside the real ones is what invited `CONFIDENCE_META[confidence]`
   * to produce a row for it — and that row's copy ("we could not read this
   * traveller's records") is false for the 56-of-58 accounts that simply have
   * no profile. `null` cannot be indexed into the band table by accident, so
   * the two not-measured cases stay apart. `degraded` below carries the other
   * lane's distinct and additive fact: that the READ itself failed.
   */
  confidence: TrustConfidence | null;
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
// ONLY the three real bands. A fourth "did not band this" member used to sit
// here, and `CONFIDENCE_META[confidence]` then produced a row for it reading
// "we could not read this traveler's trust records" — false for the 56-of-58
// production accounts (census-passport §3) that simply have no trust profile.
// A band table that cannot be indexed by a non-band cannot make that claim; the
// two not-measured cases are worded by the pair of constants below instead.
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

/**
 * The two not-measured cases, kept apart because they are not the same claim:
 * the server distinguishes them itself via `confidenceBasis`, and the wording
 * here is lifted from the already-shipped BASIS_NOTE rather than invented, so
 * the hero and the domain rows say the same thing about the same state.
 */
const CONFIDENCE_UNMEASURED = {
  label: 'Not yet measured',
  copy: 'Not yet measured — confidence appears once there is recorded history to measure.',
};
const CONFIDENCE_UNAVAILABLE = {
  label: 'Not available',
  copy: 'Trust records are unavailable right now.',
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
/**
 * EXPORTED so the one explanatory surface that quotes these sentences —
 * `components/passport/TrustScoreInfoSheet.tsx` — can import them instead of
 * re-typing them. Duplicating user-facing vocabulary is how the band table
 * this replaced came to disagree with the server in the first place; a
 * shared constant makes a third vocabulary impossible rather than merely
 * detectable.
 */
export const BASIS_NOTE: Record<DomainTrustBasis, string | null> = {
  measured: null,
  partial: 'Based on part of the record so far.',
  /**
   * UNSCORED, and the sentence must not describe a value being stood in for.
   *
   * It used to read "…shown at the neutral starting point", which was true of
   * the server that substituted a neutral 50 for a missing category and ran it
   * through `presentationWord`. That substitution is gone (owner decision,
   * 2026-09-22): `buildDomainTrust` now words a `substituted` domain
   * "Not yet rated" and no number is produced at all. The old sentence was
   * therefore printed directly under a word that contradicted it — the same
   * second-client-vocabulary defect as the band table this file's header
   * describes, in the same place, one mechanism change later.
   */
  substituted: 'Not yet measured — there’s no recorded history in this area yet.',
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
  // A failed READ is the server's own word for it, not something the client
  // infers from an empty-looking payload.
  const degraded = trust?.degraded === true
    || trust?.confidenceBasis === 'unavailable'
    || (Array.isArray(trust?.domains) && trust!.domains!.length > 0
        && trust!.domains!.every((d) => d.basis === 'unavailable'));
  // `?? 'low'` here used to turn the server's explicit "not measured" into a
  // rendered band. null now survives to the view and picks its own copy, and
  // WHICH copy is keyed off `degraded` rather than off `confidenceBasis` alone
  // so that a server which reports the failure by its own `degraded` flag gets
  // the unavailable wording too — "nobody measured you" and "we could not read
  // the records" are different claims (TrustUnscored.component.test.tsx).
  const confidence: TrustConfidence | null = trust?.confidence ?? null;
  const meta = confidence
    ? CONFIDENCE_META[confidence]
    : degraded
      ? CONFIDENCE_UNAVAILABLE
      : CONFIDENCE_UNMEASURED;
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
