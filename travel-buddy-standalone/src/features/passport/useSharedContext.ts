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
import { getPassportProjection } from '../../services/passportProjection.ts';

export interface UseSharedContextResult {
  /** The viewer↔owner overlap, or null (own passport / no relationship). */
  data: SharedContextProjection | null;
  /** Server reason when `data` is null (e.g. 'self'). */
  reason: string | null;
  /**
   * Server-projected (§30): whether this viewer may start a plan with the owner
   * (`capabilities.actions.can_make_plan`). Fail-closed — the "See What You
   * Could Do" make-plan action is never offered on a client guess; if the
   * capability can't be confirmed it stays false and the CTA is withheld.
   */
  canMakePlan: boolean;
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
  const [canMakePlan, setCanMakePlan] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setData(null);
      setReason(null);
      setCanMakePlan(false);
      setError('No traveler to compare with');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    // Fetch the overlap and the viewer's server-projected action capabilities
    // together. The make-plan CTA (§18) is gated on the SERVER `can_make_plan`
    // flag (§30) — never on the fact set — so the client can't recreate policy.
    const [ctx, proj] = await Promise.all([
      getSharedContext(userId),
      getPassportProjection(userId),
    ]);
    if (ctx.ok) {
      setData(ctx.data.sharedContext);
      setReason(ctx.data.reason ?? null);
    } else {
      setError(ctx.message ?? 'Could not load shared context');
      setData(null);
      setReason(null);
    }
    // Fail-closed: any projection error leaves can_make_plan false.
    setCanMakePlan(proj.ok ? proj.data.actions.can_make_plan === true : false);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, reason, canMakePlan, loading, error, reload: load };
}
