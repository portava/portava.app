/**
 * memoryIdRedirects — §22 "Existing IDs and URLs should remain stable": a Memory
 * merged into another keeps its id resolving (migration 3674's
 * memory_id_redirects, written by MERGE_MEMORY in 3676).
 *
 * DECISION: docs/architecture/memories-graph-model-decision.md §3.4.
 * CENSUS: H194.
 *
 * A REDIRECT IS NEVER AN EXISTENCE ORACLE. The caller re-reads the survivor and
 * runs its whole read ladder (blocks, canReadMemory, item visibility, place
 * corrections) as if the survivor's id had been asked for. A viewer who may not
 * read the survivor gets exactly the 404 an unknown id gets. A redirect read that
 * FAILS is that same 404 (logged): it is a read that found nothing to serve, and
 * nothing is written after it.
 *
 * NOT FLAG-GATED. Turning merges off must not break a URL a merge already moved.
 * An absent table (3674 not applied) means no merge has ever happened.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";

export type RedirectLookup =
  | { state: "none" }
  | { state: "redirect"; to: string }
  | { state: "unreadable"; detail: string };

export async function lookupMemoryRedirect(sc: SupabaseClient, oldId: string): Promise<RedirectLookup> {
  try {
    const { data, error } = await sc
      .from("memory_id_redirects")
      .select("old_memory_id, new_memory_id")
      .eq("old_memory_id", oldId)
      .maybeSingle();
    if (error) {
      if (isTableAbsentError(error)) return { state: "none" };
      return { state: "unreadable", detail: String((error as { code?: unknown }).code ?? "error") };
    }
    const to = (data as { new_memory_id?: string } | null)?.new_memory_id;
    if (!to || to === oldId) return { state: "none" };
    return { state: "redirect", to };
  } catch {
    return { state: "unreadable", detail: "threw" };
  }
}

/**
 * Follow one redirect for a read. `reread` loads the target exactly the way the
 * route loads any Memory (its own select list, `state <> 'deleted'`). Returns
 * null for every "serve a 404" outcome.
 */
export async function followMemoryRedirect<Row>(
  sc: SupabaseClient,
  oldId: string,
  reread: (targetId: string) => PromiseLike<{ data: Row | null; error: unknown }>,
  log?: { warn?: (obj: unknown, msg: string) => void },
): Promise<{ to: string; row: Row } | null> {
  const hop = await lookupMemoryRedirect(sc, oldId);
  if (hop.state === "unreadable") {
    log?.warn?.({ detail: hop.detail }, "memories: redirect read failed — answering 404 as for any unknown id");
    return null;
  }
  if (hop.state !== "redirect") return null;
  const { data, error } = await reread(hop.to);
  if (error || !data) return null;
  return { to: hop.to, row: data };
}
