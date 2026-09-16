/**
 * §15 Memory Retrieval and Search — the client half.
 *
 * Highlights/Memories Development Architecture Spec v1 §15, §18, §28.6.
 * Census H110–H114.
 *
 * The retrieval engine has existed for some time and had no caller: the
 * census's blocker on all five §15 rows reads "No route imports the module."
 * `POST /memories/search` is now that caller, and this is how the app reaches
 * it.
 *
 * ── WHAT THE CLIENT MAY ASK FOR, AND WHAT IT MAY NOT ──────────────────────
 * The request carries an INTENT, never a namespace, never an owner for a
 * private namespace, never a projection id. The server derives all three from
 * the authenticated viewer. That is not a convenience: if this module could
 * name a namespace, the only thing between a stranger and somebody's private
 * timeline would be one equality check on the server, and every future change
 * to it would be a data-breach risk rather than a bug.
 *
 * ── THE THREE ANSWERS THAT ARE NOT "NOTHING MATCHED" ──────────────────────
 * `empty`, `revoked` and `unavailable` are distinct states in the result type
 * below, because they are distinct things to tell a person:
 *
 *   empty       we searched and found nothing.
 *   revoked     these memories were removed from search by a privacy decision
 *               or a deletion (§18 / H114). They are not coming back.
 *   unavailable we could not search. Try again.
 *
 * A single `hits: []` would say the first for all three, which is the §28.11
 * failure — "never swallow projection/schema failures into plausible-looking
 * empty history without structured error state."
 */
import { isSupabaseConfigured } from '../../lib/supabase.ts';
import { freshToken as freshApiToken } from '../../services/apiToken.ts';

export type MemorySearchIntent =
  | { kind: 'mine' }
  | { kind: 'mine_place'; placeId: string }
  | { kind: 'public'; ownerId: string };

export interface MemorySearchHit {
  memoryId: string;
  score: number;
  /** §15's seven ranking dimensions, per hit. A rank with no derivation is not a rank. */
  dimensions: Record<string, number>;
  /** The projected row — only the fields the derivative's whitelist allows. */
  row: Record<string, unknown>;
}

export interface MemorySearchCapabilities {
  intents: string[];
  namespaces: string[];
  unreachableNamespaces: Record<string, string>;
  rankingDimensions: string[];
  /** §15's weights. `privacy_eligibility` is 0 — it is a gate, not a contributor. */
  rankingWeights: Record<string, number>;
  engineVersion: string;
  /** H111: `none`. The scorer is token overlap; no model is called. */
  semanticIndex: 'none';
  projectionsByNamespace: Record<string, string[]>;
}

export interface MemorySearchPage {
  hits: MemorySearchHit[];
  /**
   * How many rows the DETERMINISTIC filters selected, before ranking or limit.
   * §15 / H111: a semantic query may only reorder what the filters selected, so
   * this can never be smaller than the number of hits.
   */
  deterministicMatchCount: number;
  semanticRerankApplied: boolean;
  namespace: string;
  projectionId: string;
  engineVersion: string;
  capabilities: MemorySearchCapabilities;
}

export type MemorySearchResult =
  | { state: 'ok'; page: MemorySearchPage }
  | { state: 'revoked'; detail: string }
  | { state: 'refused'; detail: string }
  | { state: 'unavailable'; detail: string };

export interface MemorySearchQuery {
  intent: MemorySearchIntent;
  query?: string | null;
  people?: string[];
  place?: string | null;
  trip?: string | null;
  event?: string | null;
  dateRange?: { from?: string | null; to?: string | null } | null;
  memoryType?: string | null;
  limit?: number;
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

/**
 * Search.
 *
 * `410 gone` is mapped to `revoked` and NOT to a generic failure. That status
 * is the server saying the index existed and deliberately does not any more —
 * §18's revocation reaching a person. Folding it into "something went wrong"
 * would put a retry button on a decision that is final.
 */
export async function searchMemories(q: MemorySearchQuery): Promise<MemorySearchResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { state: 'unavailable', detail: 'Backend not configured' };
  }
  const token = await freshApiToken();
  if (!token) return { state: 'unavailable', detail: 'Not signed in' };
  try {
    const res = await fetch(`${apiBase()}/api/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(q),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 410) {
      return { state: 'revoked', detail: body?.message ?? 'Those memories are no longer searchable.' };
    }
    if (res.status === 400 || res.status === 403) {
      return { state: 'refused', detail: body?.message ?? 'That search is not permitted.' };
    }
    if (!res.ok) {
      return { state: 'unavailable', detail: body?.message ?? `API ${res.status}` };
    }
    return { state: 'ok', page: body as MemorySearchPage };
  } catch (e) {
    if (isNetworkError(e)) return { state: 'unavailable', detail: 'You appear to be offline.' };
    return { state: 'unavailable', detail: e instanceof Error ? e.message : 'Unknown error' };
  }
}

/** A hit's best available title, for a result row. */
export function hitTitle(hit: MemorySearchHit): string {
  const row = hit.row ?? {};
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (title) return title;
  const caption = typeof row.caption === 'string' ? row.caption.trim() : '';
  if (caption) return caption;
  return 'Untitled memory';
}

/** City / country, in the words the derivative carried. Never a coordinate. */
export function hitPlace(hit: MemorySearchHit): string | null {
  const row = hit.row ?? {};
  const city = typeof row.location_city === 'string' ? row.location_city : null;
  const country = typeof row.location_country === 'string' ? row.location_country : null;
  return [city, country].filter(Boolean).join(', ') || null;
}

/**
 * The dimension that CONTRIBUTED most to a hit's score.
 *
 * Contribution is value × weight, and the weight matters more than it looks.
 * `privacy_eligibility` is 1 on every eligible row and carries a weight of ZERO
 * — it is a GATE, not a contributor — so ranking by raw value would tell every
 * person, about every result, that it is there because it is shareable. The
 * weights arrive from the server with the page for exactly this reason; a
 * dimension the server gave no weight is never reported as a reason.
 */
export function topDimension(
  hit: MemorySearchHit,
  weights: Record<string, number> | undefined,
): { name: string; contribution: number } | null {
  const w = weights ?? {};
  const entries = Object.entries(hit.dimensions ?? {})
    .map(([name, v]) => [name, (typeof v === 'number' ? v : 0) * (w[name] ?? 0)] as const)
    .filter(([, c]) => c > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { name: entries[0][0], contribution: entries[0][1] };
}
