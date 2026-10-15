/**
 * What the PUBLIC index is built from — and nothing else.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       §23 "Search/index workers consume privacy-filtered event payloads where
 *            possible rather than raw entire rows."
 *       §28.6 "Never expose private canonical Memory records to public search
 *            and rely on post-filtering."
 *       §10 / §28.7 a public derivative carries city and country, never a
 *            coordinate.
 *
 * CENSUS: census-highlights-memories H203 (B58 cluster MEM-INDEX).
 *
 * THE DEFECT. `PublicMemoryProjection` (projectionRegistry.ts) is the public
 * index: the derivative `GET /memories/search` serves for "this person's public
 * Memories" (memorySearchService resolveTarget "public"). Its builder admits
 * only published, public Memories and its whitelist carries no coordinate. But
 * the READ beneath it — derivativeRegistry.readProjectionSources, shared by
 * every projection — fetched EVERY Memory the owner has, private ones
 * included, with `location_lat`, `location_lng`, `allowed_user_ids` and
 * `hidden_user_ids`, plus every photo URL and every tagged person, and the
 * builder then filtered. Every rebuild of the public index, and every
 * staleness check a stranger's public search triggers, pulled the owner's
 * private rows into the process to throw them away: §28.6's post-filtering,
 * one step earlier than the wire.
 *
 * THE READ HERE IS FILTERED IN THE DATABASE.
 *   - `memories`: `visibility = 'public'` AND `state = 'published'` — the
 *     builder's own admission rule — and only the columns PUBLIC_FIELDS is made
 *     of, plus `visibility` / `state` (which the builder re-checks) and
 *     `updated_at` (the source version). No coordinate, no allow/hide list, no
 *     trip, event or place reference is selected.
 *   - the owner's §11 controls (3671) for THOSE ids only: a Memory carrying a
 *     control that suppresses `public_projection` (CONTROL_EFFECTS — today
 *     KEEP_PRIVATE_FOREVER) is dropped before the builder sees it. 3671 only
 *     lets an only_me Memory carry it, so a public one with it is a row some
 *     path wrote around that rule; it is never published. An unreadable
 *     controls read REFUSES the build: a control that could not be read must
 *     not be read as "none".
 *   - `memory_items` for the remaining ids only, `memory_id` and `position`
 *     only (the builder counts items; it never carries a URL).
 *   - the hidden photos (3672) for the remaining ids, exactly as every
 *     non-owner build reads them; unreadable is `null`, which deriveProjection
 *     refuses for a non-owner build (§AN).
 *   - NO `memory_tags`: the public index names nobody.
 *
 * NOTHING ELSE CHANGES. The builder, its whitelist and the registration are
 * the same code. For an owner whose every Memory is public and published, the
 * rows, the contributors and the source version are byte-identical to what
 * the shared read produced (test/memoryPublicIndexSources.test.ts pins it).
 * For any other owner the version folds in only what the public index can see,
 * so a registration written by the shared read reads STALE once and is rebuilt
 * — idempotent, the next rebuild is FRESH.
 *
 * WHO DECIDES THAT A READ IS PUBLIC. The projection DEFINITION, never the
 * caller: `sourceScopeOf` stamps the definition's audience on the scope
 * deriveProjection and projectionStaleness read with, overwriting whatever a
 * caller set, so a caller can neither widen a PUBLIC read nor narrow another
 * projection's. Both sides of a staleness comparison therefore read the same
 * rows.
 *
 * Like every read in derivativeRegistry.ts, `error` is bound on each one and a
 * failure is a structured refusal, never an empty array (§28.11).
 */

import { CONTROL_EFFECTS } from "../highlights/highlightResurfacing.js";
import { MEMORY_RESURFACING_CONTROLS, readMemoryControls } from "../memory/memoryResurfacingControls.js";
import { hiddenItemKeys } from "../memory/memoryItemVisibility.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";
// TYPE-ONLY imports from the registry: erased at runtime, so derivativeRegistry
// importing this module closes no ESM cycle (derivativeRegistry.ts records what
// a value read across one costs).
import type { ClientLike, ProjectionResult, ProjectionSources } from "./derivativeRegistry.js";
import type { MemoryItemRow, MemorySourceRow, ProjectionAudience, ProjectionScope, SourceControls } from "./projectionRegistry.js";

/**
 * The `memories` columns the PUBLIC index is made of. PUBLIC_FIELDS is
 * memory_id ← id, owner_id, occurred_at ← starts_at ?? created_at, title,
 * caption, location_city, location_country and media_count (counted from
 * items); `visibility` and `state` are the builder's own admission test, and
 * `updated_at` is the source version. A column added here is a column the
 * public index READS; test/memoryPublicIndexSources.test.ts pins the list.
 */
export const PUBLIC_SOURCE_MEMORY_COLUMNS =
  "id, owner_id, title, caption, visibility, state, starts_at, created_at, updated_at, location_city, location_country";

/** The only audience and lifecycle state the public index admits (projectionRegistry PublicMemoryProjection.build). */
export const PUBLIC_INDEX_VISIBILITY = "public";
export const PUBLIC_INDEX_STATE = "published";

/**
 * The §11 controls that keep a Memory out of the public index: every
 * Memory-scoped control whose CONTROL_EFFECTS row suppresses
 * `public_projection`. Derived, not listed (memoryReaderGuard's rule).
 */
export const PUBLIC_INDEX_EXCLUDING_CONTROLS: ReadonlySet<string> = new Set(
  MEMORY_RESURFACING_CONTROLS.filter((c) => CONTROL_EFFECTS[c].suppresses.includes("public_projection")),
);

/**
 * The scope a build or a staleness check READS with: the caller's scope, with
 * `audience` set from the DEFINITION. A caller's own `audience` is discarded,
 * never trusted; an unknown projection reads with none.
 */
export function sourceScopeOf(def: { audience: ProjectionAudience } | null, scope: ProjectionScope): ProjectionScope {
  const { audience: _callerAudience, ...rest } = scope;
  return def ? { ...rest, audience: def.audience } : rest;
}

function refuse(table: string, detail: string, retryable: boolean): ProjectionResult<ProjectionSources> {
  return { ok: false, reason: "source_unavailable", table, detail, retryable };
}

/**
 * The PUBLIC index's sources for one owner. See the header for what is read
 * and why. `opts` are the extra sources derivativeRegistry may ask for
 * (Highlights, place corrections, …): this read carries no Highlight and no
 * place reference, so a PUBLIC definition that ever asks for one is REFUSED
 * here rather than silently built without it.
 */
export async function readPublicProjectionSources(
  client: ClientLike,
  ownerId: string,
  opts: Readonly<Record<string, unknown>> = {},
): Promise<ProjectionResult<ProjectionSources>> {
  const asked = Object.entries(opts).filter(([, v]) => v === true).map(([k]) => k);
  if (asked.length > 0) {
    return {
      ok: false, reason: "projection_not_configured", retryable: false,
      detail: `the public source read cannot honour ${asked.join(", ")}: it reads no Highlight, place reference or person (H203)`,
    };
  }

  const memRes = await client
    .from("memories")
    .select(PUBLIC_SOURCE_MEMORY_COLUMNS)
    .eq("owner_id", ownerId)
    .eq("visibility", PUBLIC_INDEX_VISIBILITY)
    .eq("state", PUBLIC_INDEX_STATE);
  if (memRes.error) {
    return refuse("memories", `memories unreadable: ${memRes.error.message ?? "unknown error"}`, !isTableAbsentError(memRes.error));
  }
  if (!Array.isArray(memRes.data)) return refuse("memories", "memories read returned no row array", true);
  // Columns this read does not select are ABSENT on these rows, never filled
  // with a fabricated null: only PublicMemoryProjection's builder reads them.
  const published = memRes.data as MemorySourceRow[];

  // §11: the owner's controls on THESE Memories only.
  const read = await readMemoryControls(client, ownerId, published.map((m) => m.id));
  if (read.state === "unreadable") {
    return refuse("memory_resurfacing_preferences", `the owner's controls are unreadable, so no public index is derived (fail closed): ${read.detail}`, true);
  }
  const memoryControls: SourceControls = read.state === "absent"
    ? { state: "absent" }
    : { state: "ok", byMemory: Object.fromEntries([...read.byMemory].map(([id, set]) => [id, [...set]])) };
  const excluded = read.state === "ok"
    ? new Set([...read.byMemory].filter(([, set]) => [...set].some((c) => PUBLIC_INDEX_EXCLUDING_CONTROLS.has(c))).map(([id]) => id))
    : new Set<string>();
  const memories = published.filter((m) => !excluded.has(m.id));
  const ids = memories.map((m) => m.id);

  let items: MemoryItemRow[] = [];
  if (ids.length > 0) {
    const itemRes = await client.from("memory_items").select("memory_id, position").in("memory_id", ids);
    if (itemRes.error) {
      return refuse("memory_items", `memory_items unreadable: ${itemRes.error.message ?? "unknown error"}`, !isTableAbsentError(itemRes.error));
    }
    // `media_url` / `media_type` are not selected: the builder counts items.
    items = (itemRes.data ?? []) as MemoryItemRow[];
  }

  // §AN (3672): exactly the read derivativeRegistry makes for any build.
  // Absent column ⇒ none hidden; any other failure ⇒ null, which
  // deriveProjection refuses for a non-owner build.
  let hiddenItems: ReadonlySet<string> | null = new Set();
  if (ids.length > 0) {
    const hidden = await hiddenItemKeys(client, ids);
    hiddenItems = hidden.ok ? hidden.keys : null;
  }

  return {
    ok: true,
    value: { memories, items, tags: [], highlights: [], highlight_policies: [], memoryControls, hiddenItems },
  };
}
