/**
 * perspectiveVantage — the §12 perspective GROUPS (census-media §36, MD82–MD85,
 * MD444), stored as a contributor-declared vantage on the post.
 *
 * THE SPEC, VERBATIM (docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt §12):
 *   "Perspective is a permitted visual contribution showing an aspect of a
 *    place or experience."
 *   Entity type  │ Perspective groups
 *   Nightclub    │ Entrance · Queue · Street · Main Room · Stage · Bar · VIP · Outside
 *   Festival     │ Main Gate · Stage A · Stage B · Food · Bathrooms · Meeting Area · Exit
 *   Beach        │ Water · Crowd · Weather · Beachfront · Food · Sunset · Access
 *   Restaurant   │ Exterior · Entrance · Seating · Food · View · Queue · Menu context
 *
 * The four vocabularies below are those lists, word for word. Nothing is added
 * to them: a place of any other type gets no vantage, and its perspectives stay
 * in the category buckets MediaPerspectiveService always used.
 *
 * THREE ENGINEERING CHOICES THE SPEC DOES NOT MAKE (census-media §36 names each
 * as a choice the owner may revisit):
 *   1. WHO names the vantage: the contributor, when they contribute — §12 calls
 *      a perspective "a permitted visual contribution", and §4 has a Media
 *      Contribution screen. No classifier infers one (that is MD63's vendor
 *      question, and a photo's vantage inferred by a model would be exactly the
 *      "visual inference" §9 forbids presenting as fact).
 *   2. WHICH vocabulary applies: the one keyed by the category the contributor
 *      says the media shows (nightlife → Nightclub, festival → Festival, beach →
 *      Beach, food → Restaurant). The canonical place has no §12 entity type,
 *      and inventing a place-type classifier to supply one would be a second
 *      product.
 *   3. WHERE it is stored: `posts.perspective_vantage` (migration 3352), one per
 *      post — a contribution is one photo or clip at one place. CHECKed over
 *      the union of the four lists.
 *
 * PRIVACY: a vantage says where INSIDE a place a photo was taken, so it rides
 * the place: it is attached to a projection only when the location choke point
 * let this viewer be told the place (the projection carries its placeId). For
 * the owner that is always; for anyone else never at city / neighbourhood /
 * hidden, never under a Hidden Gem's ceiling, never for an unreleased delayed
 * post.
 *
 * GATING: `media_perspective_vantage_enabled`, seeded OFF by 3352. Off: the post
 * write refuses a vantage (feature_disabled) and writes nothing; the projection
 * issues no read and no projection carries one; the contribution sheet offers
 * none. On: all three. Because the flag row is created by the migration that
 * adds the column, "flag on" implies the column exists — which is what lets the
 * read name it without failing the whole projection on a database without it.
 */
import { isFlagEnabled } from "../featureFlags.js";
import { logger } from "../logger.js";

/** Seeded FALSE by migration 3352. Read fail-closed. */
export const PERSPECTIVE_VANTAGE_FLAG = "media_perspective_vantage_enabled";

/** §12's four entity types. */
export type VantageEntityType = "nightclub" | "festival" | "beach" | "restaurant";

/** §12, word for word: each entity type's perspective groups, as [key, label]. */
export const PERSPECTIVE_VANTAGES_BY_TYPE: Readonly<Record<VantageEntityType, ReadonlyArray<readonly [string, string]>>> = {
  nightclub: [
    ["entrance", "Entrance"], ["queue", "Queue"], ["street", "Street"], ["main_room", "Main Room"],
    ["stage", "Stage"], ["bar", "Bar"], ["vip", "VIP"], ["outside", "Outside"],
  ],
  festival: [
    ["main_gate", "Main Gate"], ["stage_a", "Stage A"], ["stage_b", "Stage B"], ["food", "Food"],
    ["bathrooms", "Bathrooms"], ["meeting_area", "Meeting Area"], ["exit", "Exit"],
  ],
  beach: [
    ["water", "Water"], ["crowd", "Crowd"], ["weather", "Weather"], ["beachfront", "Beachfront"],
    ["food", "Food"], ["sunset", "Sunset"], ["access", "Access"],
  ],
  restaurant: [
    ["exterior", "Exterior"], ["entrance", "Entrance"], ["seating", "Seating"], ["food", "Food"],
    ["view", "View"], ["queue", "Queue"], ["menu_context", "Menu context"],
  ],
};

/** Every stored value — the union migration 3352's CHECK admits. A shared word (Entrance, Queue, Food) is one key. */
export const PERSPECTIVE_VANTAGE_KEYS: readonly string[] = [
  ...new Set(Object.values(PERSPECTIVE_VANTAGES_BY_TYPE).flatMap((list) => list.map(([k]) => k))),
];

/** Display label for a stored key (the spec's own word). */
export const PERSPECTIVE_VANTAGE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(PERSPECTIVE_VANTAGES_BY_TYPE).flatMap((list) => list.map(([k, l]) => [k, l] as const)),
);

/**
 * The §12 entity type a contribution's category stands for. Only the four the
 * spec lists; every other category has no vantage vocabulary.
 */
export const VANTAGE_ENTITY_TYPE_BY_CATEGORY: Readonly<Record<string, VantageEntityType>> = {
  nightlife: "nightclub",
  nightclub: "nightclub",
  festival: "festival",
  beach: "beach",
  food: "restaurant",
  restaurant: "restaurant",
};

/** A stored value this module knows, or null. */
export function normalizePerspectiveVantage(v: unknown): string | null {
  return typeof v === "string" && PERSPECTIVE_VANTAGE_KEYS.includes(v) ? v : null;
}

/** May `vantage` be declared for media of this category? */
export function vantageAllowedForCategory(vantage: string, category: string | null | undefined): boolean {
  const type = category ? VANTAGE_ENTITY_TYPE_BY_CATEGORY[String(category).trim().toLowerCase()] : undefined;
  if (!type) return false;
  return PERSPECTIVE_VANTAGES_BY_TYPE[type].some(([k]) => k === vantage);
}

export async function isPerspectiveVantageEnabled(sc: unknown): Promise<boolean> {
  if (sc == null) return false;
  try {
    return await isFlagEnabled(sc, PERSPECTIVE_VANTAGE_FLAG);
  } catch {
    return false;
  }
}

export type VantageWriteDecision =
  | { ok: true; write: string | undefined }
  | { ok: false; code: "feature_disabled" | "invalid_payload"; message: string };

/**
 * What the post create writes for a requested vantage. No vantage ⇒ `write:
 * undefined`, which supabase-js drops from the request, so the insert is
 * byte-identical to one made before this column existed. A vantage while the
 * flag is off ⇒ refused. A vantage outside the category's §12 list ⇒ refused.
 */
export async function decidePerspectiveVantageWrite(
  sc: unknown,
  vantage: string | null | undefined,
  category: string | null | undefined,
): Promise<VantageWriteDecision> {
  if (vantage == null) return { ok: true, write: undefined };
  if (!(await isPerspectiveVantageEnabled(sc))) {
    return { ok: false, code: "feature_disabled", message: "Naming where in a place a photo was taken is not available yet." };
  }
  if (!vantageAllowedForCategory(vantage, category)) {
    return { ok: false, code: "invalid_payload", message: "That vantage is not one of the §12 groups for this category." };
  }
  return { ok: true, write: vantage };
}

/**
 * Post id → declared vantage for a page of candidate rows. Issues NO query
 * while the flag is off. FAIL-SOFT: a failed read only removes the labels, the
 * same posture as loadPlaceNeighborhoods, because losing a vantage narrows what
 * is shown and never widens it.
 */
export async function loadPerspectiveVantages(
  sc: any,
  rows: ReadonlyArray<{ id?: unknown }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(rows.map((r) => (typeof r.id === "string" ? r.id : null)).filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  if (!(await isPerspectiveVantageEnabled(sc))) return out;
  try {
    const { data, error } = await sc.from("posts").select("id, perspective_vantage").in("id", ids);
    if (error || !Array.isArray(data)) {
      logger.warn({ code: (error as any)?.code ?? null }, "perspectiveVantage: read failed; no vantage labels on this page");
      return out;
    }
    for (const r of data as any[]) {
      const v = normalizePerspectiveVantage(r?.perspective_vantage);
      if (v && typeof r?.id === "string") out.set(r.id, v);
    }
  } catch (err) {
    logger.warn({ err }, "perspectiveVantage: read threw; no vantage labels on this page");
  }
  return out;
}

/**
 * Attach a declared vantage to a projection — ONLY when the projection carries
 * its place id, i.e. the location choke point let this viewer be told the
 * place. A vantage without its place would be a sub-place detail about a place
 * the viewer may not learn.
 */
export function withPerspectiveVantage<P extends { placeId: string | null }>(
  vantages: ReadonlyMap<string, string>,
  postId: string,
  p: P,
): P & { vantage?: string } {
  const v = vantages.get(postId);
  if (!v || !p.placeId) return p;
  return { ...p, vantage: v };
}
