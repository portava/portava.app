/**
 * useSharedContext — data hook for the Shared Context (ME ↔ THEM) surface
 * (spec §17 / §18).
 *
 * Consumes `GET /api/passport/:userId/shared-context` via `getSharedContext()`.
 * The endpoint computes overlap FOR THE VIEWER RELATIONSHIP each call, so this
 * hook does no caching and simply re-fetches when the target `userId` changes.
 * It re-shapes nothing: Shared Context is an explainable, server-owned fact set
 * and a qualitative label — the client must never synthesise a numeric match
 * score (§18 / TABLE 18).
 *
 * `buildCompassPrompt` is a pure function exported for the "See What You Could
 * Do" CTA (§18) and for direct unit/component testing. It turns the permitted
 * Compass-handoff seed (shared city, tonight's overlap window, shared intents)
 * into a natural-language prompt Compass can answer — the identity→action
 * bridge the spec's North Star (§35) describes.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getSharedContext,
  type SharedContextProjection,
} from '../../services/passportSharedContext.ts';

export interface UseSharedContextResult {
  /** The viewer↔owner overlap, or null (own passport / no relationship). */
  data: SharedContextProjection | null;
  /** Server reason when `data` is null (e.g. 'self'). */
  reason: string | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Build the §18 Compass prompt from a shared-context projection. Pure — no I/O.
 * Uses only the permitted handoff seed (coarse city, tonight's overlap window,
 * shared intents); it never references exact location or private history.
 */
export function buildCompassPrompt(
  ctx: SharedContextProjection,
  otherName?: string,
): string {
  const h = ctx.compassHandoff;
  const who = otherName?.trim() ? otherName.trim() : 'this traveler';
  const clauses: string[] = [];

  if (h.city) clauses.push(`we're both in ${h.city}`);
  if (h.overlapWindow) clauses.push(`we're both free tonight`);
  if (h.sharedIntents.length > 0) {
    clauses.push(`we both like ${h.sharedIntents.slice(0, 4).join(', ')}`);
  }

  const context =
    clauses.length > 0
      ? `${who} and I have some overlap — ${joinClauses(clauses)}.`
      : `${who} and I share some travel context.`;

  return `${context} What are a few things we could do together that would fit both of us?`;
}

/** Join clauses with commas and a trailing "and" for the last one. */
function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses.join('');
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
}

/**
 * Fetch shared context for the OTHER traveler `userId`. Fails soft: on error
 * `data` is null and `error` carries a message the screen can surface with a
 * retry affordance.
 */
export function useSharedContext(userId: string | undefined): UseSharedContextResult {
  const [data, setData] = useState<SharedContextProjection | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setData(null);
      setReason(null);
      setError('No traveler to compare with');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await getSharedContext(userId);
    if (res.ok) {
      setData(res.data.sharedContext);
      setReason(res.data.reason ?? null);
    } else {
      setError(res.message ?? 'Could not load shared context');
      setData(null);
      setReason(null);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, reason, loading, error, reload: load };
}
