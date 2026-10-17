/**
 * §36 Impersonation — the half the within-answer rule could not reach
 * (census-input-intelligence G233).
 *
 * `rankingSignals.applyImpersonationRisk` demotes an unverified person row whose
 * handle folds to the same confusable signature as a verified or official row
 * IN THE SAME ANSWER. Two holes kept G233 BUILT-BUT-WRONG:
 *
 *   (a) an impersonator that appears WITHOUT its target was untouched — nothing
 *       consulted the accounts that were not in the answer;
 *   (b) businesses were not covered at all — no venue row's verification flag
 *       reached the suggestion path.
 *
 * This module closes both by LOOKING THE TARGET UP, and returns the ids of the
 * rows to demote. The demotion itself stays in `applyImpersonationRisk`, so a
 * row is demoted ONCE whether its twin was in the answer, found here, or both.
 *
 *   PEOPLE  — an active `profiles` row that is verified or official, whose handle
 *             folds (`handleSignature`) to the SAME signature as a person row
 *             in the answer, and that is not that row's own account.
 *   VENUES  — `discovery_places.verified` is the listing's genuine signal: the
 *             curated first-party rows carry it (0075), every OSM-saved row is
 *             written `false`, and since 2153 no client can write it. An
 *             unverified listing whose name folds (`nameSignature`) to the same
 *             signature as an ACTIVE VERIFIED listing in the SAME city is the
 *             business twin. Same city on purpose: two real venues in two cities
 *             can share a name, and nothing here could tell them from a copy.
 *
 * ── THE LOOKUP ────────────────────────────────────────────────────────────────
 * No column stores the fold, so PostgREST cannot be asked for signature
 * equality. The read sends a case-insensitive regular expression (`imatch`, ~*)
 * that EVERY spelling folding to the signature satisfies — a superset — and the
 * exact fold is re-applied here to what comes back. The pattern is built only
 * from signature characters (`[a-z0-9]`), so nothing typed can reach it.
 *
 * ── PRIVACY ───────────────────────────────────────────────────────────────────
 * A twin that is already IN the answer is already visible. A twin outside it
 * counts only if the viewer's own search could have shown it — the gates
 * `searchTravelers` / `searchPlaces` apply: not blocked either way, not
 * age-restricted, not opted out of discovery, not Invisible to discovery, and
 * active; for a listing, active and not from a submitter the viewer is blocked
 * with. A gate that cannot be read drops every out-of-answer twin it covers: the
 * copy keeps its score and nothing about an account the viewer cannot see moves
 * the answer.
 *
 * ── FAILURE ───────────────────────────────────────────────────────────────────
 * This is a demotion source, never a filter. An unreadable read leaves the
 * answer exactly as the within-answer rule ranks it, and is logged.
 */
import { fetchBlockedSet, submitterIsVisible } from '../blocks';
import { normalizeLocationName } from '../canonicalLocations';
import { readDiscoveryPeopleGate } from '../discoveryPeoplePrivacy';
import { logger } from '../logger';
import { handleSignature, LOOKALIKE_LETTERS } from './rankingSignals';
import { fetchAgeRestrictedSet } from './searchCandidates';

/** The person-ish rows a handle twin applies to (as in rankingSignals.ts). */
const PERSON_ENTITY_TYPES: ReadonlySet<string> = new Set(['user', 'buddy']);

/** At most this many signatures are looked up per serve and kind — one read each. */
export const MAX_INDEX_SIGNATURES = 6;
/** A longer signature is matched on this many leading positions (still a superset). */
export const MAX_PATTERN_POSITIONS = 16;
/** Rows one read may return; the regex is a superset, the exact fold decides. */
export const TWIN_READ_LIMIT = 50;

/** The row fields this module reads — every InputSuggestion carries them. */
export interface ImpersonationRow {
  id?: string;
  entityType?: string;
  entityId?: string;
  label?: string;
  subtitle?: string;
  verified?: boolean;
  official?: boolean;
}

/**
 * A venue name's confusable signature: diacritics folded first (a listing's
 * genuine name is "Café", its copy "Cafe"), then exactly `handleSignature`.
 */
export function nameSignature(name: string | null | undefined): string {
  return handleSignature((name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

/**
 * The raw characters that fold to each signature character. `m` keeps `r` and
 * `n` because `rn` folds to `m`; every letter keeps itself, the digit
 * `handleSignature` maps onto it, and its LOOKALIKE_LETTERS in both cases (a
 * database's case folding of other scripts is not assumed).
 */
const DIGIT_FOLDS: Readonly<Record<string, string>> = {
  o: 'o0', l: 'l1', e: 'e3', a: 'a4', s: 's5', t: 't7', b: 'b8', m: 'mrn',
};
const FOLDS_TO: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...DIGIT_FOLDS };
  for (const [ch, latin] of Object.entries(LOOKALIKE_LETTERS)) {
    const upper = ch.toUpperCase();
    out[latin] = (out[latin] ?? latin) + ch + (upper.length === 1 && upper !== ch ? upper : '');
  }
  return out;
})();
/** Anything the fold drops: separators, marks, and every script it does not keep. */
const DROPPED = '[^a-z0-9]';
/**
 * The only non-ASCII characters NFD can fold onto a Latin letter: the
 * precomposed Latin blocks, plus KELVIN SIGN and ANGSTROM SIGN (measured over
 * every code point to U+2FFFF; nothing else decomposes to [A-Za-z]).
 */
const FOLDABLE_LATIN = '\u00c0-\u024f\u1e00-\u1eff\u212a\u212b';

/**
 * A case-insensitive pattern that every string folding to `signature` matches;
 * the caller re-checks the exact fold. Each position needs one character that
 * can fold to its letter, then any repeats of it and any dropped characters. A
 * dropped character alone never carries a position, so a name written wholly in
 * a script the fold drops (Japanese, Thai) cannot match and cannot crowd a real
 * twin out of the read. A signature longer than MAX_PATTERN_POSITIONS is matched
 * on its prefix. Null when the signature is unusable.
 */
export function confusablePattern(signature: string): string | null {
  if (!/^[a-z0-9]{3,}$/.test(signature)) return null;
  const body = [...signature].slice(0, MAX_PATTERN_POSITIONS).map((c) => {
    const keeps = FOLDS_TO[c] ?? c;
    return `[${keeps}${FOLDABLE_LATIN}](?:[${keeps}]|${DROPPED})*`;
  }).join('');
  return `^${DROPPED}*${body}${signature.length > MAX_PATTERN_POSITIONS ? '' : '$'}`;
}

/**
 * One bounded read per distinct signature (at most MAX_INDEX_SIGNATURES), run
 * together. Each answer is keyed by its signature; a read that fails is logged
 * and leaves its signature out, so its rows keep their within-answer score.
 */
async function readBySignature(
  signatures: readonly string[],
  read: (pattern: string) => PromiseLike<{ data: unknown; error: unknown }>,
  what: string,
): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  const sigs = [...new Set(signatures)].slice(0, MAX_INDEX_SIGNATURES);
  await Promise.all(sigs.map(async (sig) => {
    const pattern = confusablePattern(sig);
    if (!pattern) return;
    const { data, error } = await read(pattern);
    if (error) {
      logger.warn({ err: error }, `input-assistance impersonation index: ${what} unreadable — within-answer rule only`);
      return;
    }
    out.set(sig, Array.isArray(data) ? data : []);
  }));
  return out;
}

/**
 * The ids (`InputSuggestion.id`) of the rows whose genuine twin exists outside
 * what the within-answer rule could see. Never throws; an unreadable source
 * contributes nothing and is logged.
 */
export async function indexedImpersonators(
  sc: any,
  rows: readonly ImpersonationRow[],
  opts: { userId: string },
): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  await Promise.all([
    personTwins(sc, rows, opts.userId, out).catch((err) => {
      logger.warn({ err }, 'input-assistance impersonation index: people lookup failed — within-answer rule only');
    }),
    listingTwins(sc, rows, opts.userId, out).catch((err) => {
      logger.warn({ err }, 'input-assistance impersonation index: listing lookup failed — within-answer rule only');
    }),
  ]);
  return out;
}

// ── People ────────────────────────────────────────────────────────────────────

function rowHandleSignature(r: ImpersonationRow): string {
  if (!r.entityType || !PERSON_ENTITY_TYPES.has(r.entityType)) return '';
  const sub = (r.subtitle ?? '').trim();
  return sub.startsWith('@') ? handleSignature(sub) : '';
}

async function personTwins(sc: any, rows: readonly ImpersonationRow[], userId: string, out: Set<string>): Promise<void> {
  // Every person row is a candidate unless it is flagged genuine. The @mention
  // and recipient projections carry no flag, so a genuine account there is
  // recognised below by its own id among the twins and is never demoted.
  const candidates = rows
    .filter((r) => r.id && r.entityId && r.verified !== true && r.official !== true)
    .map((r) => ({ r, sig: rowHandleSignature(r) }))
    .filter((c) => c.sig);
  if (candidates.length === 0) return;

  const bySig = await readBySignature(candidates.map((c) => c.sig), (pattern) => sc
    .from('profiles')
    .select('id, handle')
    .eq('account_status', 'active')
    .or('verified.eq.true,is_official.eq.true')
    .filter('handle', 'imatch', pattern)
    .limit(TWIN_READ_LIMIT), 'profiles');
  const genuine = [...bySig.values()].flat()
    .map((p: any) => ({ id: String(p?.id ?? ''), sig: handleSignature(typeof p?.handle === 'string' ? p.handle : '') }))
    .filter((p) => p.id && p.sig);
  if (genuine.length === 0) return;

  const inAnswer = new Set(rows.filter((r) => r.entityType && PERSON_ENTITY_TYPES.has(r.entityType) && r.entityId).map((r) => r.entityId!));
  const outside = [...new Set(genuine.filter((g) => !inAnswer.has(g.id)).map((g) => g.id))];
  const visible = outside.length > 0 ? await peopleVisibleToViewer(sc, outside, userId) : new Set<string>();
  const counts = (g: { id: string }) => inAnswer.has(g.id) || visible.has(g.id);

  const genuineIds = new Set(genuine.map((g) => g.id));
  for (const { r, sig } of candidates) {
    if (genuineIds.has(r.entityId!)) continue; // the row IS a genuine account
    if (genuine.some((g) => g.sig === sig && g.id !== r.entityId && counts(g))) out.add(r.id!);
  }
}

/**
 * The subset of `ids` the viewer's own people search could show — the gates
 * `searchTravelers` applies to every row it returns. Any unreadable gate ⇒ the
 * empty set: an account whose visibility cannot be checked never moves the
 * answer.
 */
async function peopleVisibleToViewer(sc: any, ids: readonly string[], userId: string): Promise<ReadonlySet<string>> {
  const [blocked, ageRestricted] = await Promise.all([fetchBlockedSet(sc, userId), fetchAgeRestrictedSet(sc)]);
  if (blocked === null || ageRestricted === null) {
    logger.warn('input-assistance impersonation index: block/age state unreadable — out-of-answer twins dropped');
    return new Set();
  }
  const pool = ids.filter((id) => !blocked.has(id) && !ageRestricted.has(id));
  if (pool.length === 0) return new Set();

  const [{ data: optedOut, error: optErr }, gate] = await Promise.all([
    sc.from('profile_privacy_settings').select('user_id').in('user_id', pool).eq('allow_profile_discovery', false),
    readDiscoveryPeopleGate(sc, pool, userId, null),
  ]);
  if (optErr || !gate.ok) {
    logger.warn({ err: optErr ?? (gate.ok ? null : gate.error) }, 'input-assistance impersonation index: discovery visibility unreadable — out-of-answer twins dropped');
    return new Set();
  }
  const hidden = new Set<string>((Array.isArray(optedOut) ? optedOut : []).map((r: any) => String(r?.user_id ?? '')));
  return new Set(pool.filter((id) => !hidden.has(id) && !gate.withheld.has(id)));
}

// ── Venues ────────────────────────────────────────────────────────────────────

async function listingTwins(sc: any, rows: readonly ImpersonationRow[], userId: string, out: Set<string>): Promise<void> {
  const placeRows = rows
    .filter((r) => r.id && r.entityType === 'place' && r.entityId)
    .map((r) => ({ r, sig: nameSignature(r.label) }))
    .filter((c) => c.sig);
  if (placeRows.length === 0) return;

  // The answer's own listings: which are verified, and in which city.
  const { data: facts, error: factsErr } = await sc
    .from('discovery_places')
    .select('id, city, verified')
    .in('id', [...new Set(placeRows.map((c) => c.r.entityId!))]);
  if (factsErr) {
    logger.warn({ err: factsErr }, 'input-assistance impersonation index: listing facts unreadable — within-answer rule only');
    return;
  }
  const byId = new Map<string, { city: string; rawCity: string; verified: boolean }>();
  for (const f of (Array.isArray(facts) ? facts : []) as any[]) {
    const rawCity = typeof f?.city === 'string' ? f.city : '';
    byId.set(String(f?.id ?? ''), { city: normalizeLocationName(rawCity), rawCity, verified: f?.verified === true });
  }
  const candidates = placeRows
    .map((c) => ({ ...c, fact: byId.get(c.r.entityId!) }))
    .filter((c) => c.fact && !c.fact.verified && c.fact.city);
  if (candidates.length === 0) return;

  const cities = [...new Set(candidates.map((c) => c.fact!.rawCity))];
  const bySig = await readBySignature(candidates.map((c) => c.sig), (pattern) => sc
    .from('discovery_places')
    .select('id, name, city, submitted_by')
    .eq('verified', true)
    .eq('status', 'active')
    .in('city', cities)
    .filter('name', 'imatch', pattern)
    .limit(TWIN_READ_LIMIT), 'discovery_places');
  const genuine = [...bySig.values()].flat()
    .map((p: any) => ({
      id: String(p?.id ?? ''),
      sig: nameSignature(typeof p?.name === 'string' ? p.name : ''),
      city: normalizeLocationName(typeof p?.city === 'string' ? p.city : ''),
      submittedBy: p?.submitted_by ?? null,
    }))
    .filter((p) => p.id && p.sig && p.city);
  if (genuine.length === 0) return;

  // A listing outside the answer counts only if its submitter is visible to the
  // viewer — `searchPlaces`' own rule; unreadable blocks hide every submitter.
  const inAnswer = new Set(placeRows.map((c) => c.r.entityId!));
  const needsBlocks = genuine.some((g) => !inAnswer.has(g.id) && g.submittedBy);
  const blocked = needsBlocks ? await fetchBlockedSet(sc, userId) : new Set<string>();
  const counts = (g: { id: string; submittedBy: unknown }) => inAnswer.has(g.id) || submitterIsVisible(g.submittedBy, blocked);

  for (const { r, sig, fact } of candidates) {
    if (genuine.some((g) => g.sig === sig && g.city === fact!.city && g.id !== r.entityId && counts(g))) out.add(r.id!);
  }
}
