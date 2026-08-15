/**
 * discoveryShadow — P1 Stage 2. Observation only: it logs, it never serves.
 *
 * WHAT SHADOW MODE DOES
 * =====================
 * With `DISCOVERY_ENGINE_MODE = shadow`, the user receives the LEGACY result,
 * byte for byte. After the response is flushed, PDE ranks the same candidates
 * for the same viewer, and both orders are written to `discovery_shadow_serves`
 * (operator ruling D7=A).
 *
 * The user's response is computed, sent and finished before any of this runs.
 * Nothing here can change what was served, because what was served has already
 * left.
 *
 * WHERE IT IS WIRED, AND WHY NOT EVERYWHERE YET
 * =============================================
 * Stage 2a wires serve points 1, 2 and 3 — the Cache A layers. That is the
 * traffic the entire packet is about: legacy runs NO ranker there, so a
 * divergence row from those serve points says something no other measurement in
 * this system can say.
 *
 * Serve point 6, the cold-fetch legacy rank, is deliberately NOT wired. Since
 * the engine was extracted rather than copied, the cold path already IS PDE —
 * `routes/discovery.ts` calls `rankForViewer` for it. A shadow row there would
 * compare a result with itself and report zero divergence, which reads like
 * evidence and is a tautology. Rows that cannot fail to agree do not belong in
 * a table whose purpose is to find disagreement.
 *
 * Serve points 4 and 5 — the Compass candidate-cache hit and the fresh Compass
 * rank — are a genuinely different ranker and a genuinely different comparison.
 * They are Stage 2b, not an oversight.
 *
 * NOTHING HERE MAY WRITE OUTSIDE THIS TABLE
 * =========================================
 * The PDE run behind these rows is invoked with `served: false`, which hands it
 * a client that cannot write (lib/discoveryPde.ts). That is not a formality:
 * DiscoveryRankingService emits its own `rank_events` rows for every candidate
 * it scores, and a shadow run left unguarded would have written production
 * impression rows for a page NOBODY SAW — into the very table D7=A exists to
 * keep this data out of. `pde_suppressed_writes` records how many such writes
 * were intercepted, so the guard's effectiveness is visible in the data rather
 * than assumed.
 *
 * FAILURES ARE LOGGED, NOT SWALLOWED
 * ==================================
 * Same rule as lib/discoveryServeLog.ts, for the same reason: an insert that is
 * rejected silently is how a surface can be "instrumented" for weeks and hold
 * zero rows with nothing anywhere saying so. A rejected row is logged. It still
 * never throws — an observation must not be able to damage a request that has
 * already been answered.
 */
import { logger } from "./logger.js";

/** The comparison, computed once at write time so every reader agrees. */
export interface ShadowComparison {
  /** Ids present on both served pages. */
  overlapCount: number;
  /** Shared ids whose position on the page differs. */
  displacedCount: number;
  /** Did the top slot change. */
  topChanged: boolean;
}

/**
 * Compare two served pages by id order.
 *
 * Deliberately compares the SERVED PAGES rather than the full ranked lists.
 * What a user receives is a page; a reordering below the fold changed nothing
 * anybody saw, and counting it as divergence would inflate every figure this
 * table produces.
 */
export function compareServedOrders(legacyIds: string[], pdeIds: string[]): ShadowComparison {
  const pdePos = new Map<string, number>();
  pdeIds.forEach((id, i) => { if (!pdePos.has(id)) pdePos.set(id, i); });

  let overlapCount = 0;
  let displacedCount = 0;
  legacyIds.forEach((id, i) => {
    const j = pdePos.get(id);
    if (j === undefined) return;
    overlapCount += 1;
    if (j !== i) displacedCount += 1;
  });

  // Two empty pages agree. An empty page against a populated one does not, and
  // must not be reported as "top unchanged" — that would read as agreement.
  const topChanged = (legacyIds[0] ?? null) !== (pdeIds[0] ?? null);

  return { overlapCount, displacedCount, topChanged };
}

export interface ShadowServeParams {
  userId: string;
  sessionId?: string | null;

  destination: string;
  category: string;
  radiusKm: number;
  page: number;
  pageSize: number;
  sortBy?: string | null;

  /** Serve point of the LEGACY path that answered this request. */
  servePoint: number;
  cacheLevel?: string | null;

  /** Ids of the page legacy actually served, in served order. */
  legacyIds: string[];
  legacyTotal: number;
  legacyMs?: number | null;

  /** Ids of the page PDE would have served, in its order. */
  pdeIds: string[];
  pdeTotal: number;
  pdeMs?: number | null;
  pdeStages?: Record<string, unknown> | null;
  pdeSuppressedWrites?: number | null;

  engineMode: string;
  modeReason: string;
}

/**
 * Write one shadow observation. Fire-and-forget; never throws.
 *
 * The caller is responsible for having flushed the response first — this
 * function does not enforce ordering it cannot see. It is called with `void`
 * from the serve paths for exactly that reason.
 */
export async function logDiscoveryShadowServe(sc: any, p: ShadowServeParams): Promise<void> {
  try {
    if (!sc) return;

    const cmp = compareServedOrders(p.legacyIds, p.pdeIds);

    const { error } = await sc.from("discovery_shadow_serves").insert({
      user_id:     p.userId,
      session_id:  p.sessionId ?? null,

      destination: p.destination,
      category:    p.category,
      radius_km:   p.radiusKm,
      page:        p.page,
      page_size:   p.pageSize,
      sort_by:     p.sortBy ?? null,

      serve_point:  p.servePoint,
      cache_level:  p.cacheLevel ?? null,
      legacy_ids:   p.legacyIds,
      legacy_total: p.legacyTotal,
      legacy_ms:    p.legacyMs ?? null,

      pde_ids:   p.pdeIds,
      pde_total: p.pdeTotal,
      pde_ms:    p.pdeMs ?? null,
      pde_stages: p.pdeStages ?? {},
      pde_suppressed_writes: p.pdeSuppressedWrites ?? 0,

      overlap_count:   cmp.overlapCount,
      displaced_count: cmp.displacedCount,
      top_changed:     cmp.topChanged,

      engine_mode: p.engineMode,
      mode_reason: p.modeReason,
    });

    if (error) {
      logger.warn(
        { err: error, servePoint: p.servePoint, destination: p.destination },
        "discoveryShadow: shadow observation rejected — the comparison for this serve is lost",
      );
    }
  } catch (err) {
    logger.warn({ err }, "discoveryShadow: shadow observation threw — the comparison for this serve is lost");
  }
}
