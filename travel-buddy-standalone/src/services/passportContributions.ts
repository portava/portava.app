/**
 * passportContributions — client bindings + pure derivation for the §20
 * Contribution reputation surface (TABLE 21).
 *
 * DATA SOURCE (spec §20): the reputation read route `GET
 * /api/passport/:userId/contributions` when the server exposes it, else the
 * contribution-relevant credentials the §29 PassportProjection already carries.
 * A sibling backend agent is landing that reputation route; this module wires to
 * it and falls back cleanly to `projection.credentials` so the client renders
 * the same card either way.
 *
 * PRIVACY / INTEGRITY INVARIANTS enforced HERE, in pure code, so they can never
 * widen by accident and can be unit-tested in isolation:
 *
 *   1. `normalizeContributions` is a closed ALLOW-LIST. It reads ONLY the six
 *      positive TABLE-21 fields (level, accepted reports, confirmations, hidden
 *      gems, top expertise) and constructs an explicit literal. Any other key on
 *      the payload — paid/purchased contribution counts, rejected reports,
 *      moderation notes, flags, safety history — is dropped by construction and
 *      never reaches the card.
 *
 *   2. PAID contributions are never surfaced as reputation. There is no field on
 *      the returned shape for paid/purchased activity, so a paid contribution can
 *      never be presented as boosting confidence (spec §20).
 *
 * Auth + fetch follow the same freshToken() pattern as passportProjection.ts.
 */
import { freshToken as freshApiToken } from './apiToken.ts';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Test seam — set to a non-null string to bypass Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void {
  _testAuthToken = t;
}

async function authToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshApiToken();
}

// ── Shape (TABLE 21) ─────────────────────────────────────────────────────────

/**
 * The exact, closed shape the Contribution card is allowed to render. Only
 * positive, organic reputation. Counts are `null` (not shown) when the server
 * did not provide them; `topExpertise` is `[]` when none.
 */
export interface ContributionProjection {
  /** Contributor level label (e.g. "Local Expert"), or null when not leveled. */
  level: string | null;
  /**
   * Accepted intel contributions (TABLE 21 "accepted reports" — user-submitted
   * tips/observations the platform accepted). Positive metric; NOT the private
   * moderation "reports against user" count, which is never part of this shape.
   */
  acceptedReports: number | null;
  /** Confirmations the traveler contributed (place still-here / accurate). */
  confirmations: number | null;
  /** Hidden gems the traveler surfaced that were accepted. */
  hiddenGems: number | null;
  /** Top areas of expertise (positive, already server-sanitised). */
  topExpertise: string[];
}

/** The exact set of keys a ContributionProjection may ever contain (test guard). */
export const CONTRIBUTION_FIELDS: ReadonlyArray<keyof ContributionProjection> = [
  'level',
  'acceptedReports',
  'confirmations',
  'hiddenGems',
  'topExpertise',
];

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** A non-negative integer count, or null. Negative / NaN / non-number → null. */
function asCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

/** Coerce a raw expertise list into clean, de-duplicated strings. */
function asExpertise(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s =
      typeof item === 'string'
        ? asString(item)
        : item && typeof item === 'object'
          ? asString((item as any).area ?? (item as any).label ?? (item as any).name)
          : null;
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Build the minimal, closed contribution projection from an arbitrary payload.
 * Reads snake_case or camelCase; constructs an EXPLICIT literal so no extraneous
 * (paid / moderation / rejected) field can ride along.
 */
export function normalizeContributions(raw: any): ContributionProjection {
  const r = raw ?? {};
  return {
    level: asString(r.level ?? r.contributorLevel ?? r.contributor_level),
    acceptedReports: asCount(r.acceptedReports ?? r.accepted_reports ?? r.acceptedContributions ?? r.accepted_contributions),
    confirmations: asCount(r.confirmations ?? r.confirmationCount ?? r.confirmation_count),
    hiddenGems: asCount(r.hiddenGems ?? r.hidden_gems ?? r.hiddenGemCount ?? r.hidden_gem_count),
    topExpertise: asExpertise(r.topExpertise ?? r.top_expertise ?? r.expertise),
  };
}

/** True when there is at least one positive signal worth rendering a card for. */
export function hasContributionSignal(c: ContributionProjection | null | undefined): boolean {
  if (!c) return false;
  return (
    c.level !== null ||
    (c.acceptedReports ?? 0) > 0 ||
    (c.confirmations ?? 0) > 0 ||
    (c.hiddenGems ?? 0) > 0 ||
    c.topExpertise.length > 0
  );
}

// ── Fallback: derive from projection credentials (§20 "else use projection") ──

/** The minimal credential shape this fallback reads (subset of TABLE 13). */
export interface CredentialLike {
  key: string;
  label: string;
  detail?: string | null;
}

/** Credential keys that denote contributor reputation (never moderation). */
const CONTRIBUTOR_KEYS = new Set(['contributor', 'live_intel', 'local_intel', 'local_expert']);

/**
 * Best-effort ContributionProjection from the credentials the projection already
 * carries, for the case where the dedicated reputation route is not present.
 * Credentials carry no granular counts, so only `level` and `topExpertise` are
 * derivable; counts stay null. Returns null when nothing contribution-relevant
 * is present, so a generic credential list (identity / established / trips) never
 * synthesizes a phantom card.
 */
export function contributionsFromCredentials(
  credentials: CredentialLike[] | null | undefined,
): ContributionProjection | null {
  if (!Array.isArray(credentials)) return null;
  const contributor = credentials.find((c) => CONTRIBUTOR_KEYS.has(c.key));
  const expertise = credentials
    .filter((c) => typeof c.key === 'string' && c.key.startsWith('expertise_'))
    .map((c) => c.label)
    .filter((l): l is string => typeof l === 'string' && l.length > 0);

  if (!contributor && expertise.length === 0) return null;

  return {
    level: contributor ? asString(contributor.label) : null,
    acceptedReports: null,
    confirmations: null,
    hiddenGems: null,
    topExpertise: expertise,
  };
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the contribution reputation for `userId` (UUID or @handle). Returns
 * `ok:true, data:null` when the server has no contribution record for this
 * viewer, and `ok:false` on auth/network/HTTP failure so the caller can fall
 * back to the projection credentials.
 */
export async function getPassportContributions(
  userId: string,
): Promise<ApiResult<ContributionProjection | null>> {
  const token = await authToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(
      `${apiBase()}/api/passport/${encodeURIComponent(userId)}/contributions`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any)?.message ?? `API ${res.status}` };
    }
    const json = await res.json().catch(() => null);
    const payload = (json as any)?.contributions ?? (json as any)?.reputation ?? json;
    if (!payload || typeof payload !== 'object') return { ok: true, data: null };
    return { ok: true, data: normalizeContributions(payload) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}
