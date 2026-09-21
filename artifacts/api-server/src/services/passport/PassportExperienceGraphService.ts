/**
 * PassportExperienceGraphService — census-passport P159, "9 — Intelligence:
 * Travel DNA, yearbook, deeper Experience Graph".
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The census re-measured P159 and found the row's word "absent" too strong:
 * the Experience Graph IS built. `CompassGraphEngine` writes
 * person —experienced→ experience —at_place / during_trip / at_event / in_city
 * into `compass_graph_nodes` / `compass_graph_edges`, and the `experience` node
 * kind is admitted by migration 2290. What it found instead was that **30 files
 * reference those tables and ZERO of them are under `src/services/passport/` or
 * `src/routes/passport*.ts`**: the graph is built and has no Passport reader.
 *
 * This is that reader. It builds NOTHING. It adds no table, no node, no edge and
 * no second social graph — it reads the edges `CompassGraphEngine` already
 * wrote, and every row it can return was put there by that engine.
 *
 * ── THE TWO BLOCKERS, AND WHICH ONE THIS ANSWERS ────────────────────────────
 * §13.5 gave P159 two blockers.
 *
 * BLOCKER 2 — privacy — IS ALREADY ANSWERED IN THE CODE, and §16.2 established
 * it: "a Passport reader over those nodes must not become a second route to a
 * private memory". It cannot be. The experience feed is filtered
 * `state = 'published'` AND `visibility = 'public'` TWICE — once in the query
 * (`CompassGraphEngine.ts`, the `memories` select) and again per row through the
 * exported `isPublicWorldMemory` guard, which exists precisely so "a client that
 * ignores a predicate, or a fake that implements `eq` loosely, must not be the
 * only thing standing between a friends_only Memory and the world model". A
 * private memory is therefore not IN the graph, so no reader over the graph can
 * disclose one. `src/test/passportExperienceGraphReader.test.ts` pins both
 * halves of that filter and reddens if either is removed.
 *
 * BLOCKER 1 — the product definition — IS NOT ANSWERED, and this file does not
 * answer it. The census is explicit: a one-paragraph owner definition of "which
 * of the graph's four experience edges a traveller may see, ABOUT WHOM, and at
 * what viewer relationship", and "shipping a guess is the failure mode, not the
 * absence".
 *
 * So this reader is scoped to the ONE relationship that requires no ruling:
 *
 *     THE SUBJECT READING THEIR OWN PASSPORT.
 *
 * About whom: about themselves, and nobody else. At what relationship: `self`,
 * and no other. Every other viewer context returns `null` — not an empty
 * summary, which would be a different and equally unruled answer. A traveller
 * seeing the shape of their own published experiences discloses nothing to
 * anyone, so it is not a guess about audience; it is the absence of one. When
 * the owner writes the paragraph, the surface widens by relaxing
 * `viewerContext === "self"` and nothing else.
 *
 * ── READS FAIL HONESTLY ─────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error, so an unreadable edge table returns
 * `{ data: null, error }` — the same `data` an empty table returns. Reporting
 * that as "this traveller has experienced nothing" is the fail-open shape this
 * codebase has hunted out of a dozen other services. An unreadable read is
 * reported as `unreadable: true` with the counts left `null`, never as zero.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../../lib/logger.js";
import type { PassportViewerContext } from "./PassportProjectionService.js";

/**
 * The four experience edges `CompassGraphEngine` writes out of an experience
 * node, in the engine's own vocabulary. This service does not define them and
 * must not add to them: a key here that the engine never writes would be a
 * second graph's vocabulary wearing this one's name.
 */
export const EXPERIENCE_EDGE_TYPES = ["at_place", "during_trip", "at_event", "in_city"] as const;
export type ExperienceEdgeType = (typeof EXPERIENCE_EDGE_TYPES)[number];

export interface ExperienceGraphProjection {
  /**
   * Number of `person —experienced→ experience` edges the graph holds for this
   * traveller. `null` when the edge table could not be read — NOT zero.
   */
  experiences: number | null;
  /**
   * Per-edge-type counts over those experiences. Every key is present so a
   * consumer can tell "the engine wrote none of these" from "the key is
   * missing"; each value is `null` when the read failed.
   */
  edges: Record<ExperienceEdgeType, number | null>;
  /** Distinct cities the traveller's experience nodes are keyed to. */
  cities: number | null;
  /**
   * TRUE when `compass_graph_edges` could not be read. Every count above is
   * `null` and none of them is a statement about this traveller.
   */
  unreadable: boolean;
  /**
   * What the numbers are derived from, in one sentence a consumer can render.
   * The graph is built only from PUBLISHED, PUBLIC memories, so this summary is
   * a floor on a traveller's real history and must never be presented as a
   * total.
   */
  basis: "public_published_experiences";
}

const EMPTY_EDGES = (): Record<ExperienceEdgeType, number | null> =>
  ({ at_place: null, during_trip: null, at_event: null, in_city: null });

/**
 * Read this traveller's OWN experience-graph shape.
 *
 * Returns `null` — the surface does not exist — for every viewer context other
 * than `self`. That is the unruled half of P159 and is deliberately not guessed.
 */
export async function buildExperienceGraphProjection(
  sc: SupabaseClient,
  userId: string,
  viewerContext: PassportViewerContext,
): Promise<ExperienceGraphProjection | null> {
  // P159 blocker 1. Widening this condition is the owner's paragraph, not an
  // implementation detail.
  if (viewerContext !== "self") return null;
  if (!userId) return null;

  const unreadable = (reason: string): ExperienceGraphProjection => {
    logger.warn(
      { service: "PassportExperienceGraphService", userId, reason },
      "compass_graph_edges unreadable — reporting the experience graph as unread, not as empty",
    );
    return {
      experiences: null,
      edges: EMPTY_EDGES(),
      cities: null,
      unreadable: true,
      basis: "public_published_experiences",
    };
  };

  // 1. The traveller's own experience nodes.
  let experienceKeys: string[];
  try {
    const { data, error } = await sc
      .from("compass_graph_edges")
      .select("dst_key")
      .eq("src_type", "person")
      .eq("src_key", userId)
      .eq("dst_type", "experience")
      .eq("edge_type", "experienced");
    // The error is BOUND. `const { data } = await …` is the defect shape this
    // whole codebase has been de-fanging: it turns a failed read into "none".
    if (error) return unreadable(String((error as any).message ?? (error as any).code ?? "db_error"));
    experienceKeys = ((data as any[]) ?? []).map((r) => String(r.dst_key)).filter(Boolean);
  } catch (err) {
    return unreadable(String((err as any)?.message ?? "threw"));
  }

  const edges = EMPTY_EDGES();
  for (const k of EXPERIENCE_EDGE_TYPES) edges[k] = 0;

  if (experienceKeys.length === 0) {
    // A read that SUCCEEDED and found nothing. That is a measurement, and it is
    // reported as one — zero, not null.
    return { experiences: 0, edges, cities: 0, unreadable: false, basis: "public_published_experiences" };
  }

  // 2. What those experiences connect to. One query, the engine's own edge
  //    vocabulary, no traversal beyond the traveller's own nodes.
  try {
    const { data, error } = await sc
      .from("compass_graph_edges")
      .select("src_key, dst_type, dst_key, edge_type")
      .eq("src_type", "experience")
      .in("src_key", experienceKeys)
      .in("edge_type", EXPERIENCE_EDGE_TYPES as unknown as string[]);
    if (error) return unreadable(String((error as any).message ?? (error as any).code ?? "db_error"));
    const cities = new Set<string>();
    for (const r of (data as any[]) ?? []) {
      const t = String(r.edge_type) as ExperienceEdgeType;
      // An edge type the engine does not write is ignored rather than counted
      // under a key it does not belong to.
      if (!(EXPERIENCE_EDGE_TYPES as readonly string[]).includes(t)) continue;
      // Only edges that start at one of THIS traveller's experience nodes are
      // counted. `.in()` already narrows it; the re-check is the same
      // belt-and-braces `isPublicWorldMemory` applies on the write side, for the
      // same reason — a fake or a client that implements `in` loosely must not
      // be the only thing enforcing it.
      if (!experienceKeys.includes(String(r.src_key))) continue;
      edges[t] = (edges[t] ?? 0) + 1;
      if (t === "in_city" && r.dst_key) cities.add(String(r.dst_key));
    }
    return {
      experiences: experienceKeys.length,
      edges,
      cities: cities.size,
      unreadable: false,
      basis: "public_published_experiences",
    };
  } catch (err) {
    return unreadable(String((err as any)?.message ?? "threw"));
  }
}
