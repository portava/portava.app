/**
 * §10 / §11 privacy controls — the client half.
 *
 * Highlights/Memories Development Architecture Spec v1 §10 (the owner's
 * selected location precision, person visibility and consent) and §11 (the six
 * resurfacing controls).
 *
 * WHAT THIS IS FOR. Both control tables were applied to production on
 * 2026-09-15, and the server-side enforcement that reads them was already live
 * and route-tested. What did not exist anywhere was a way for a user to SET
 * one: census §O.2 recorded that "there is no route, no service and no script
 * by which a user can set a §11 resurfacing control or a §10 precision rung.
 * Both tables are deployed and EMPTY." `routes/highlights.ts` now serves the
 * writer; this module reaches it.
 *
 * THE VOCABULARY IS NOT HARD-CODED HERE. The server returns the control
 * catalogue, each control's declared scope, the surfaces it suppresses, the two
 * §10 ladders and the consent dimensions, and the UI renders what it is given.
 * §21 requires Archive / do-not-resurface / do-not-personalize / Delete to stay
 * SEPARATE operations "in both data model and UX", and a client carrying its
 * own copy of which control means what is exactly how two of them get collapsed
 * one release later. The types below name the shapes; the VALUES come over the
 * wire.
 */
import { isSupabaseConfigured } from '../../lib/supabase.ts';
import { freshToken as freshApiToken } from '../../services/apiToken.ts';

/** §11. The six controls, as the server declares them. */
export type ResurfacingControl =
  | 'DO_NOT_RESURFACE'
  | 'DO_NOT_INCLUDE_IN_RECAPS'
  | 'HIDE_PERSON_FROM_RESURFACING'
  | 'HIDE_TRIP'
  | 'KEEP_PRIVATE_FOREVER'
  | 'RETAIN_BUT_DO_NOT_PERSONALIZE';

export type SuppressibleSurface =
  | 'proactive_resurfacing'
  | 'recap'
  | 'personalization'
  | 'public_projection';

export type ControlScope = 'highlight' | 'person' | 'trip' | 'owner';

export interface StoredControl {
  control: ResurfacingControl;
  subjectType: ControlScope;
  subjectId: string;
  createdAt: string | null;
  suppresses: SuppressibleSurface[];
  retainsRecord: boolean;
}

export interface ControlCatalogueEntry {
  control: ResurfacingControl;
  scope: ControlScope;
  suppresses: SuppressibleSurface[];
  note: string;
}

export interface ResurfacingControlsView {
  controls: StoredControl[];
  /**
   * Controls that suppress the proactive feed and whose subject that feed
   * cannot resolve. Census H90: `public.highlights` carries no trip reference,
   * so HIDE_TRIP is in here. A screen that renders these identically to the
   * rest promises an effect the server does not deliver.
   */
  unenforceableOnFeed: ResurfacingControl[];
  catalogue: ControlCatalogueEntry[];
}

/** §10. Coarsening left to right — the ORDER is meaning, not presentation. */
export type LocationPrecisionRung = 'EXACT' | 'VENUE' | 'NEIGHBORHOOD' | 'CITY' | 'COUNTRY' | 'HIDDEN';
export type PersonVisibilityRung = 'NAMED' | 'PROFILE_LINKED' | 'CREW_ONLY' | 'ANONYMOUS_COUNT' | 'HIDDEN';

/** Three-valued. `null` is UNKNOWN, and unknown REFUSES — it is not "no". */
export type ConsentValue = boolean | null;

/**
 * WHICH consent dimensions actually bite, as the SERVER derives it.
 *
 * `GET /highlights/:id/projection-policy` publishes all five §10 dimensions and
 * accepts a patch for any of them, but only some are read by a surface a viewer
 * can observe. `consentEnforcement` (services/highlights/highlightPublicProjection.ts)
 * is DERIVED there from `SURFACE_CONSENT_DIMENSIONS` — the very table the gate
 * consults — so the day a third dimension is wired the wire changes and no
 * client is edited.
 *
 * The dimension names are deliberately `string`, not a client union. A union
 * here would be a second copy of a vocabulary the server owns, and the whole
 * point of this field is that the client can render a dimension it has never
 * heard of. The same reasoning applies to `bySurface`'s keys.
 */
export interface ConsentEnforcementMap {
  /** Dimensions some non-owner surface actually reads. Render these. */
  enforced: string[];
  /**
   * Dimensions §10 names, the schema stores, and NOTHING reads. Storing a
   * preference nothing reads is honest; rendering it as a live control is not.
   */
  unenforced: string[];
  /** Which dimensions each non-owner surface asks about. */
  bySurface: Record<string, string[]>;
  /** The server's one-sentence explanation of why `unenforced` is not empty. */
  note: string;
}

export interface ProjectionPolicyView {
  highlightId: string;
  locationPrecision: LocationPrecisionRung | null;
  personVisibility: PersonVisibilityRung | null;
  consent: Record<string, ConsentValue>;
  locationPrecisionLadder: LocationPrecisionRung[];
  personVisibilityLadder: PersonVisibilityRung[];
  consentDimensions: string[];
  /**
   * OPTIONAL because a deployment older than `consentEnforcement` does not send
   * it, and the honest response to its absence is to offer no consent switches
   * at all. A client that fell back to `consentDimensions` would offer five
   * switches of which three change nothing observable — which is precisely the
   * failure this field was added to prevent.
   */
  consentEnforcement?: ConsentEnforcementMap;
}

export type PrivacyErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_payload'
  | 'feature_disabled'
  | 'degraded_unavailable'
  | 'network_unreachable'
  | 'config_error'
  | 'db_error';

export interface PrivacyResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: PrivacyErrorKind;
  message?: string;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

const KNOWN: PrivacyErrorKind[] = [
  'unauthenticated', 'forbidden', 'not_found', 'invalid_payload',
  'feature_disabled', 'degraded_unavailable', 'db_error',
];

/**
 * `feature_disabled` and `degraded_unavailable` are carried through rather than
 * flattened into a generic failure, because the screen says something different
 * for each: "this control is not available on this deployment" is permanent and
 * must not offer a retry, while "we could not save that" is transient and must.
 * Collapsing them would put a retry button on a control that will never exist.
 */
function mapError<T>(status: number, body: any): PrivacyResult<T> {
  const code = body?.error as PrivacyErrorKind | undefined;
  const errorKind = code && KNOWN.includes(code) ? code : 'db_error';
  return { ok: false, data: null, errorKind, message: body?.message ?? `API ${status}` };
}

async function request<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<PrivacyResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const token = await freshApiToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok) return mapError<T>(res.status, parsed);
    return { ok: true, data: parsed as T };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

export async function fetchResurfacingControls(): Promise<PrivacyResult<ResurfacingControlsView>> {
  return request<ResurfacingControlsView>('/api/highlights/resurfacing-controls', { method: 'GET' });
}

export async function setResurfacingControl(
  control: ResurfacingControl,
  subjectId: string,
): Promise<PrivacyResult<StoredControl>> {
  return request<StoredControl>('/api/highlights/resurfacing-controls', {
    method: 'PUT',
    body: { control, subjectId },
  });
}

/**
 * Clear one control.
 *
 * `confirm` exists for KEEP_PRIVATE_FOREVER, the one control whose name argues
 * it should not be undoable. The server refuses to clear it without an explicit
 * confirmation, so a caller that forwards `confirm: false` gets a 400 rather
 * than a silent no-op — which is the point: a mistap must not be able to
 * reverse the strongest control a user has.
 */
export async function clearResurfacingControl(
  control: ResurfacingControl,
  subjectId: string,
  opts: { confirm?: boolean } = {},
): Promise<PrivacyResult<{ cleared: boolean }>> {
  return request<{ cleared: boolean }>('/api/highlights/resurfacing-controls', {
    method: 'DELETE',
    body: { control, subjectId, confirm: opts.confirm === true },
  });
}

export async function fetchProjectionPolicy(highlightId: string): Promise<PrivacyResult<ProjectionPolicyView>> {
  return request<ProjectionPolicyView>(`/api/highlights/${highlightId}/projection-policy`, { method: 'GET' });
}

/**
 * Save part of a Highlight's §10 policy.
 *
 * PARTIAL ON PURPOSE. A key that is ABSENT means "leave it alone"; a key whose
 * value is `null` means "unset it". The server keeps the same distinction, and
 * sending the whole object every time would mean a client built before a new
 * consent dimension existed resets it to `unknown` on every save — and unknown
 * refuses, so the Highlight would quietly stop being projectable with nobody
 * having chosen that.
 */
export interface ProjectionPolicyPatch {
  locationPrecision?: LocationPrecisionRung | null;
  personVisibility?: PersonVisibilityRung | null;
  consent?: Record<string, ConsentValue>;
}

export async function saveProjectionPolicy(
  highlightId: string,
  patch: ProjectionPolicyPatch,
): Promise<PrivacyResult<ProjectionPolicyView>> {
  return request<ProjectionPolicyView>(`/api/highlights/${highlightId}/projection-policy`, {
    method: 'PUT',
    body: patch,
  });
}

/** Is this control currently set for this subject, in a loaded view? */
export function isControlSet(
  view: ResurfacingControlsView | null,
  control: ResurfacingControl,
  subjectId: string,
): boolean {
  if (!view) return false;
  return view.controls.some((c) => c.control === control && c.subjectId === subjectId);
}

/**
 * The controls a per-Highlight sheet can offer, derived from the catalogue the
 * SERVER sent rather than from a list typed here. A control scoped to a person
 * or a trip does not belong on a sheet whose subject is one Highlight; showing
 * it would write a row keyed on a Highlight id under a control the database's
 * own CHECK constraint forbids.
 */
export function highlightScopedControls(view: ResurfacingControlsView | null): ControlCatalogueEntry[] {
  if (!view) return [];
  return view.catalogue.filter((c) => c.scope === 'highlight');
}

/**
 * The §10 consent dimensions a sheet may OFFER, read off the wire.
 *
 * An absent `consentEnforcement` returns an empty list on purpose — see the
 * field's own comment. `consentDimensions` is NOT a fallback: it is the full
 * catalogue including the three nothing reads.
 */
export function enforcedConsentDimensions(policy: ProjectionPolicyView | null): string[] {
  const enforced = policy?.consentEnforcement?.enforced;
  if (!Array.isArray(enforced)) return [];
  return enforced.filter((d): d is string => typeof d === 'string' && d.length > 0);
}

/**
 * Which non-owner surfaces ask about this dimension, derived from the server's
 * `bySurface` map rather than from a table typed beside it. Returned in the
 * map's own key order so the server decides the ordering too.
 */
export function surfacesGatedBy(policy: ProjectionPolicyView | null, dimension: string): string[] {
  const bySurface = policy?.consentEnforcement?.bySurface;
  if (!bySurface || typeof bySurface !== 'object') return [];
  return Object.keys(bySurface).filter((surface) => {
    const dims = bySurface[surface];
    return Array.isArray(dims) && dims.includes(dimension);
  });
}

/**
 * The stored answer for one dimension, three-valued.
 *
 * `unset` is NOT `withheld`. The gate that runs on the non-owner surfaces
 * (`consentWithholds`) refuses only on an explicit stored `false`, so the two
 * are different facts about what the owner decided and about what a viewer
 * sees. Anything that is not a boolean — absent, null, a JSON round-tripped
 * "false" string — is `unset`, never coerced into a decision.
 */
export type ConsentChoice = 'granted' | 'withheld' | 'unset';

export function consentChoice(policy: ProjectionPolicyView | null, dimension: string): ConsentChoice {
  const v = policy?.consent?.[dimension];
  if (v === true) return 'granted';
  if (v === false) return 'withheld';
  return 'unset';
}
