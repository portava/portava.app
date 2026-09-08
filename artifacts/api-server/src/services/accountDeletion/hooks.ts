/**
 * Declared extension points: storage cleanup and projection cleanup.
 *
 * ── THE DEFECT THESE EXIST FOR ──────────────────────────────────────────────
 * AccountDeletionService's own header records it: "A table can be fully erased —
 * row-complete, guard green — while the bytes its rows pointed at stay in the
 * bucket, which is exactly how intel_evidence's media survived." The same is
 * true of derived state: erase the source rows and a projection keeps serving
 * the departed user's content until something rebuilds it.
 *
 * So a hook here is a DECLARATION that a fate has a second half, and the
 * planner attaches it to the action. Nothing in this file deletes anything: the
 * removals still happen inside AccountDeletionService, which is the one place
 * that talks to storage. What the registry adds is the ability to ask, before
 * running, "does every table this plan erases have a hook for its bytes?" — and
 * to REFUSE when the answer is no, instead of finding out afterwards.
 *
 * The registry ships pre-seeded with what the service already does, cited to
 * the step that does it. `missingStorageHooks()` then reports the gap the graph
 * measures: tables carrying a media column with no hook covering them.
 */
import type { DeletionGraphNode } from "../../lib/deletion/types.js";

export interface StorageCleanupHook {
  id: string;
  /** Tables whose rows point at the objects this hook removes. */
  tables: readonly string[];
  /** The columns holding the reference. */
  columns: readonly string[];
  /** The AccountDeletionService step that performs it, or null when unimplemented. */
  implementedBy: string | null;
}

export interface ProjectionCleanupHook {
  id: string;
  /** Projection tables this hook rebuilds or invalidates. */
  projections: readonly string[];
  /** Source tables whose erasure makes those projections stale. */
  sources: readonly string[];
  implementedBy: string | null;
}

/**
 * Seeded from the storage inventory in AccountDeletionService's header — the
 * one place that lists every storage-bearing column the service knows about.
 */
const SEED_STORAGE_HOOKS: readonly StorageCleanupHook[] = [
  { id: "post_media_objects", tables: ["post_media"], columns: ["storage_path", "thumbnail_storage_path", "feed_storage_path"], implementedBy: "collect_post_media_paths" },
  { id: "media_assets_objects", tables: ["media_assets"], columns: ["storage_path", "thumbnail_path"], implementedBy: "collect_media_asset_paths" },
  { id: "profile_objects", tables: ["profiles"], columns: ["avatar_url", "cover_photo_url"], implementedBy: "collect_profile_media_paths" },
  { id: "memory_item_objects", tables: ["memories", "memory_items"], columns: ["media_url"], implementedBy: "collect_memory_item_paths" },
  { id: "intel_evidence_objects", tables: ["intel_evidence"], columns: ["reference"], implementedBy: "collect_intel_evidence_paths" },
  { id: "story_objects", tables: ["stories"], columns: ["media_url"], implementedBy: "collect_story_media_paths" },
  { id: "message_objects", tables: ["messages"], columns: ["media_url", "media_thumbnail_url"], implementedBy: "collect_message_media_paths" },
  { id: "hidden_gem_objects", tables: ["hidden_gems"], columns: ["image_url"], implementedBy: "collect_hidden_gem_media_paths" },
  { id: "review_objects", tables: ["reviews"], columns: ["photos"], implementedBy: "collect_review_photo_paths" },
];

const storageHooks = new Map<string, StorageCleanupHook>(SEED_STORAGE_HOOKS.map((h) => [h.id, h]));
const projectionHooks = new Map<string, ProjectionCleanupHook>();

export function registerStorageCleanupHook(hook: StorageCleanupHook): void {
  storageHooks.set(hook.id, hook);
}
export function registerProjectionCleanupHook(hook: ProjectionCleanupHook): void {
  projectionHooks.set(hook.id, hook);
}
export function listStorageCleanupHooks(): StorageCleanupHook[] {
  return [...storageHooks.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function listProjectionCleanupHooks(): ProjectionCleanupHook[] {
  return [...projectionHooks.values()].sort((a, b) => a.id.localeCompare(b.id));
}
/** Test seam: restore the shipped seed and drop every registered projection hook. */
export function _resetHooks(): void {
  storageHooks.clear();
  for (const h of SEED_STORAGE_HOOKS) storageHooks.set(h.id, h);
  projectionHooks.clear();
}

export function storageHooksFor(table: string): StorageCleanupHook[] {
  return listStorageCleanupHooks().filter((h) => h.tables.includes(table));
}
export function projectionHooksFor(projection: string): ProjectionCleanupHook[] {
  return listProjectionCleanupHooks().filter((h) => h.projections.includes(projection));
}

/**
 * Tables the graph says hold a storage reference, for which no hook exists.
 *
 * This is the measured version of the service header's hand-maintained
 * inventory: a new table with a media column shows up here without anybody
 * remembering to add it to a comment.
 */
export function missingStorageHooks(nodes: readonly DeletionGraphNode[]): Array<{ table: string; columns: string[] }> {
  const covered = new Set(listStorageCleanupHooks().flatMap((h) => h.tables));
  return nodes
    .filter((n) => !covered.has(n.table))
    .map((n) => ({ table: n.table, columns: n.propagation.DELETE.storageColumns }))
    .filter((x) => x.columns.length > 0)
    .sort((a, b) => a.table.localeCompare(b.table));
}
