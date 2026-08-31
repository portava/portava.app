/**
 * Social Identity resolvers (Phase 4) — recipient/user search, @mentions,
 * #hashtags, and §23 username validation, all wired THROUGH the Phase-1 gateway.
 *
 * Reuse, not reimplementation:
 *   - Recipient eligibility uses the authoritative `canMessage` verdict
 *     (lib/messagingPermissions) — the same gate the send-message endpoints use.
 *   - Mention (@) resolution delegates to `dispatchSearch(..., 'travelers')`
 *     (routes/discoverySearch) behind the same fail-closed block/age gate.
 *   - Hashtag (#) resolution reuses the canonical `hashtags` search + the same
 *     lowercase slug normalization the TaggingService write path uses.
 *   - Username §23 validation reuses `validateUsername` (lib/usernameRules) and
 *     the identical availability query as GET /users/check-username.
 *
 * §47 ACCOUNT-ENUMERATION PROTECTION is the security property of this file:
 *   - Recipient search is scoped to the VIEWER'S OWN relationship graph (recent
 *     conversation partners + trip crew + follows + friends). A stranger's
 *     private account the viewer has no edge to never enters the candidate pool,
 *     so recipient search can never become a prefix oracle for private-account
 *     existence.
 *   - Every candidate is then passed through `canMessage`; anyone the viewer may
 *     NOT message (privacy='no_one', blocked, request-only-off) is dropped. This
 *     is the ELIGIBILITY FILTER.
 *   - Both the block gate and the eligibility filter are FAIL-CLOSED: an unknown
 *     block-set or an unreadable relationship graph yields NO recipients.
 */
import { fetchBlockedSet } from '../blocks';
import {
  dispatchSearch,
  fetchAgeRestrictedSet,
  type SearchResult,
} from '../../routes/discoverySearch';
import type { SearchQueryContext } from '../../routes/discoverySearchHelpers';
import { canMessage } from '../messagingPermissions';
import { validateUsername } from '../usernameRules';
import type { InputContext, InputSuggestion } from './types';

// ── Hashtag canonicalization (§26) ────────────────────────────────────────────

/**
 * Normalize a raw hashtag input to its CANONICAL slug — the same lowercase,
 * alphanumeric [A-Za-z0-9]{2,64} form the TaggingService `HASHTAG_RE` persists.
 * Returns null when the input has no valid tag body. This is the structured
 * reference target: `#Food` and `#FOOD` both canonicalize to `food`.
 */
export function canonicalizeHashtag(raw: string): string | null {
  const body = (raw ?? '').replace(/^#+/, '');
  const m = body.match(/^[A-Za-z0-9]{2,64}/);
  return m ? m[0].toLowerCase() : null;
}

// ── Recipient candidate pool (§47/§54) ────────────────────────────────────────

/**
 * The viewer's own relationship graph — the ONLY people recipient search may
 * surface. Union of: recent conversation partners, trip crew, followed users,
 * and friends. Returns null on any read failure (fail-closed: no recipients).
 *
 * This scoping IS the enumeration protection: a private account the viewer has
 * no relationship with is never a candidate, so prefix typing cannot probe for
 * whether it exists.
 */
export async function fetchRecipientCandidateIds(
  sc: any,
  userId: string,
): Promise<Set<string> | null> {
  try {
    const ids = new Set<string>();

    const [follows, friendsA, friendsB, myThreads, myTrips] = await Promise.all([
      sc.from('user_follows').select('following_id').eq('follower_id', userId),
      sc.from('user_friendships').select('user_b').eq('user_a', userId),
      sc.from('user_friendships').select('user_a').eq('user_b', userId),
      sc.from('message_thread_members').select('thread_id').eq('user_id', userId),
      sc.from('trip_members').select('trip_id').eq('user_id', userId).in('role', ['owner', 'member']),
    ]);

    if (follows.error || friendsA.error || friendsB.error || myThreads.error || myTrips.error) {
      return null; // fail-closed: an unreadable graph yields no recipients
    }

    for (const r of (follows.data ?? []) as any[]) ids.add(r.following_id as string);
    for (const r of (friendsA.data ?? []) as any[]) ids.add(r.user_b as string);
    for (const r of (friendsB.data ?? []) as any[]) ids.add(r.user_a as string);

    // Recent conversation partners: the other members of the viewer's threads.
    const threadIds = [...new Set(((myThreads.data ?? []) as any[]).map((r) => r.thread_id as string))];
    if (threadIds.length > 0) {
      const partners = await sc
        .from('message_thread_members')
        .select('user_id, thread_id')
        .in('thread_id', threadIds)
        .neq('user_id', userId);
      if (partners.error) return null;
      for (const r of (partners.data ?? []) as any[]) ids.add(r.user_id as string);
    }

    // Trip crew: co-members of the viewer's trips.
    const tripIds = [...new Set(((myTrips.data ?? []) as any[]).map((r) => r.trip_id as string))];
    if (tripIds.length > 0) {
      const crew = await sc
        .from('trip_members')
        .select('user_id, trip_id')
        .in('trip_id', tripIds)
        .in('role', ['owner', 'member'])
        .neq('user_id', userId);
      if (crew.error) return null;
      for (const r of (crew.data ?? []) as any[]) ids.add(r.user_id as string);
    }

    ids.delete(userId);
    return ids;
  } catch {
    return null; // fail-closed
  }
}

interface RecipientProfile {
  id: string;
  handle: string | null;
  username: string | null;
  name: string | null;
  account_status: string | null;
  show_real_name?: boolean;
}

function matchesNeedle(p: RecipientProfile, needle: string): boolean {
  if (needle.length === 0) return true;
  const h = (p.handle ?? '').toLowerCase();
  const u = (p.username ?? '').toLowerCase();
  const n = (p.name ?? '').toLowerCase();
  return h.includes(needle) || u.includes(needle) || n.includes(needle);
}

export interface RecipientParams {
  userId: string;
  /** Already-sigil-stripped, sanitized query (may be empty for zero-char recents). */
  q: string;
  max: number;
}

/**
 * Recipient search for the `telegraph_recipient` context (§54).
 * Returns ONLY eligible, block-filtered recipients from the viewer's own graph.
 */
export async function resolveRecipientSuggestions(
  sc: any,
  context: InputContext,
  policyVersion: string,
  params: RecipientParams,
): Promise<InputSuggestion[]> {
  const { userId, q, max } = params;

  // §29 fail-closed block gate: unknown block state ⇒ no recipients.
  const blockedSet = await fetchBlockedSet(sc, userId);
  if (blockedSet === null) return [];

  const candidateIds = await fetchRecipientCandidateIds(sc, userId);
  if (candidateIds === null) return []; // fail-closed

  // ── BLOCK GATE ──────────────────────────────────────────────────────────────
  // Drop anyone in a block relationship (either direction). Fail-open here (e.g.
  // `.filter(() => true)`) leaks a blocked contact — the mutation-proof target.
  const pool = [...candidateIds].filter((id) => !blockedSet.has(id));
  if (pool.length === 0) return [];

  // Fetch the pooled profiles (active accounts only), then prefix/substring match.
  const { data, error } = await sc
    .from('profiles')
    .select('id, handle, username, name, account_status')
    .in('id', pool)
    .in('account_status', ['active']);
  if (error) return [];

  const needle = q.toLowerCase();
  const matched = ((data ?? []) as RecipientProfile[]).filter((p) => matchesNeedle(p, needle));
  if (matched.length === 0) return [];

  // Bound the per-request eligibility fan-out.
  const capped = matched.slice(0, Math.max(1, Math.min(25, max * 3)));

  // ── ELIGIBILITY FILTER (§47) ─────────────────────────────────────────────────
  // The authoritative messaging permission gate. Anyone the viewer may NOT
  // message (privacy='no_one', request-only-off, blocked) is dropped, so a
  // non-eligible / private account is never revealed. Dropping this filter
  // (returning `capped` directly) leaks such an account — the mutation-proof.
  const verdicts = await Promise.all(
    capped.map((p) =>
      canMessage(sc, userId, p.id).catch(() => ({ verdict: 'denied' as const })),
    ),
  );
  const eligible = capped.filter((_, i) => verdicts[i].verdict !== 'denied');

  return eligible.slice(0, Math.max(0, max)).map((p) => projectRecipient(p, context, policyVersion));
}

function displayLabel(p: RecipientProfile): string {
  const handle = p.handle ?? p.username ?? '';
  const name = (p.name ?? '').trim();
  // Recipients are the viewer's own contacts; still, prefer the handle as the
  // stable identifier and only show the name when present.
  return name.length > 0 ? name : (handle ? `@${handle}` : 'Unknown');
}

function projectRecipient(
  p: RecipientProfile,
  context: InputContext,
  policyVersion: string,
): InputSuggestion {
  const handle = p.handle ?? p.username ?? null;
  const suggestion: InputSuggestion = {
    id: `${context}:user:${p.id}`,
    type: 'entity',
    context,
    label: displayLabel(p),
    entityType: 'user',
    entityId: p.id,
    // A recipient resolves to the person; the client opens/starts the thread.
    action: { type: 'open_entity', entityType: 'user', entityId: p.id },
    // A structured recipient reference so the composer can bind the thread target.
    structuredValue: { kind: 'recipient', userId: p.id, handle },
    confidence: 0.8,
    source: 'canonical',
    policyVersion,
  };
  if (handle) suggestion.subtitle = `@${handle}`;
  return suggestion;
}

// ── Mentions (@ → user_id) as structured references (§26) ─────────────────────

export interface MentionParams {
  userId: string;
  /** Sigil-stripped, sanitized handle query. */
  q: string;
  max: number;
  ctx: SearchQueryContext;
}

/**
 * Resolve an @mention to real user references (§26). Delegates candidate
 * generation to the traveler search behind the SAME fail-closed block/age gate
 * the gateway uses, then projects each as a structured mention reference whose
 * value carries the resolved user_id — never a styled string.
 */
export async function resolveMentionSuggestions(
  sc: any,
  context: InputContext,
  policyVersion: string,
  params: MentionParams,
): Promise<InputSuggestion[]> {
  const { userId, q, max, ctx } = params;
  if (q.length < 1) return [];

  // §29 fail-closed: unknown block/age state ⇒ no people.
  const [blockedSet, ageRestrictedSet] = await Promise.all([
    fetchBlockedSet(sc, userId),
    fetchAgeRestrictedSet(sc),
  ]);
  if (blockedSet === null || ageRestrictedSet === null) return [];

  const results = await dispatchSearch(
    sc, q, userId, blockedSet, ageRestrictedSet, 'travelers', 0, Math.max(1, max), ctx,
  ).catch(() => [] as SearchResult[]);

  const out: InputSuggestion[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(projectMentionRef(r, context, policyVersion));
  }
  return out.slice(0, Math.max(0, max));
}

function projectMentionRef(
  r: SearchResult,
  context: InputContext,
  policyVersion: string,
): InputSuggestion {
  // subtitle from searchTravelers is "@handle"; recover the bare handle for the
  // structured mention token and the inserted replacement text.
  const handle = (r.subtitle ?? '').replace(/^@/, '') || null;
  const replacement = handle ? `@${handle}` : r.title;
  const suggestion: InputSuggestion = {
    id: `${context}:mention:${r.id}`,
    type: 'entity',
    context,
    label: r.title || (handle ? `@${handle}` : ''),
    entityType: 'user',
    entityId: r.id,
    replacementText: replacement,
    // §26: a mention is a STRUCTURED reference to a user_id, not a styled string.
    action: { type: 'set_structured_value', value: { kind: 'mention', userId: r.id, handle } },
    structuredValue: { kind: 'mention', userId: r.id, handle },
    confidence: 0.85,
    source: 'canonical',
    policyVersion,
  };
  if (r.subtitle) suggestion.subtitle = r.subtitle;
  return suggestion;
}

// ── Hashtags (# → canonical hashtag) as structured references (§26) ────────────

export interface HashtagParams {
  /** Raw query which may or may not include a leading '#'. */
  raw: string;
  max: number;
}

/**
 * Resolve a #hashtag to structured hashtag references (§26). Surfaces matching
 * existing canonical hashtags AND, when the typed tag canonicalizes to a valid
 * slug not already present, a "use #slug" reference so a brand-new tag still
 * resolves to its canonical form. No user privacy involved — hashtags are public
 * — so no block/age gate is needed here.
 */
export async function resolveHashtagRefSuggestions(
  sc: any,
  context: InputContext,
  policyVersion: string,
  params: HashtagParams,
): Promise<InputSuggestion[]> {
  const { raw, max } = params;
  const slug = canonicalizeHashtag(raw);
  if (!slug) return [];

  const out: InputSuggestion[] = [];
  const seenSlugs = new Set<string>();

  // Existing canonical hashtags (usage-ranked), reusing the hashtags search.
  const existing = await searchExistingHashtags(sc, slug, Math.max(1, max));
  for (const h of existing) {
    if (seenSlugs.has(h.slug)) continue;
    seenSlugs.add(h.slug);
    out.push(projectHashtagRef(h.slug, context, policyVersion, { id: h.id, usageCount: h.usageCount }));
  }

  // The exact canonical slug the user typed — always resolvable, even brand-new.
  if (!seenSlugs.has(slug)) {
    seenSlugs.add(slug);
    out.push(projectHashtagRef(slug, context, policyVersion, { isNew: true }));
  }

  return out.slice(0, Math.max(0, max));
}

interface ExistingHashtag { id: string; slug: string; usageCount: number | null }

async function searchExistingHashtags(sc: any, slug: string, limit: number): Promise<ExistingHashtag[]> {
  try {
    const pat = `%${slug.replace(/[%_]/g, '\\$&')}%`;
    const { data, error } = await sc
      .from('hashtags')
      .select('id, slug, name, usage_count, is_blocked')
      .or(`slug.ilike.${pat},name.ilike.${pat}`)
      .eq('is_blocked', false)
      .order('usage_count', { ascending: false })
      .range(0, Math.max(0, limit - 1));
    if (error || !data) return [];
    return (data as any[]).map((h) => ({
      id: h.id as string,
      slug: (h.slug as string) ?? '',
      usageCount: (h.usage_count as number | null) ?? null,
    })).filter((h) => h.slug.length > 0);
  } catch {
    return [];
  }
}

function projectHashtagRef(
  slug: string,
  context: InputContext,
  policyVersion: string,
  opts: { id?: string; usageCount?: number | null; isNew?: boolean } = {},
): InputSuggestion {
  const suggestion: InputSuggestion = {
    id: `${context}:hashtag:${slug}`,
    type: 'entity',
    context,
    label: `#${slug}`,
    entityType: 'hashtag',
    entityId: opts.id ?? slug,
    replacementText: `#${slug}`,
    // §26: a hashtag resolves to its CANONICAL slug as a structured reference.
    action: { type: 'set_structured_value', value: { kind: 'hashtag', slug } },
    structuredValue: { kind: 'hashtag', slug },
    confidence: opts.isNew ? 0.55 : 0.85,
    source: 'canonical',
    destination: { route: `/hashtag/${slug}`, entityType: 'hashtag' },
    canonicalUri: `portava:/hashtag/${slug}`,
    policyVersion,
  };
  if (typeof opts.usageCount === 'number') suggestion.subtitle = `${opts.usageCount} posts`;
  else if (opts.isNew) suggestion.subtitle = 'New tag';
  return suggestion;
}

// ── Username validation (§23) ─────────────────────────────────────────────────

export interface UsernameAvailability {
  available: boolean;
  reason?: string;
}

/**
 * Reuses the identical rules + availability query as GET /users/check-username:
 * validity/reserved-name rules from lib/usernameRules, then a uniqueness check
 * against `profiles.username` (excluding the caller's own row).
 */
export async function checkUsernameAvailability(
  sc: any,
  usernameRaw: string,
  userId: string,
): Promise<UsernameAvailability> {
  const username = (usernameRaw ?? '').toLowerCase().trim();
  if (!username) return { available: false, reason: 'Username is required' };

  const v = validateUsername(username);
  if (!v.valid) return { available: false, reason: v.reason };

  try {
    const { data, error } = await sc
      .from('profiles')
      .select('id')
      .eq('username', username)
      .neq('id', userId)
      .maybeSingle();
    if (error) return { available: false, reason: 'Could not verify availability' };
    if (data) return { available: false, reason: 'Username is already taken' };
    return { available: true };
  } catch {
    return { available: false, reason: 'Could not verify availability' };
  }
}

/**
 * Project a §23 username availability result as a `validation` assistance row.
 * The confidence encodes availability so the client can style it; the row is
 * intentionally NOT an entity (it resolves to no route) — it carries the verdict
 * as a structured value and stays resolvable via that action.
 */
export function buildUsernameValidation(
  context: InputContext,
  policyVersion: string,
  usernameRaw: string,
  result: UsernameAvailability,
): InputSuggestion {
  const username = (usernameRaw ?? '').toLowerCase().trim();
  const label = result.available
    ? `@${username} is available`
    : (result.reason ?? 'Username unavailable');
  return {
    id: `${context}:validation:${username}`,
    type: 'validation',
    context,
    label,
    action: {
      type: 'set_structured_value',
      value: { kind: 'username_validation', username, available: result.available, reason: result.reason ?? null },
    },
    structuredValue: { kind: 'username_validation', username, available: result.available, reason: result.reason ?? null },
    confidence: result.available ? 0.9 : 0.2,
    source: 'local',
    reason: result.available ? undefined : result.reason,
    policyVersion,
  };
}
