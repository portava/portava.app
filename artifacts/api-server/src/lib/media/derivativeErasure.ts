import { MEDIA_DERIVATIVE_ERASURE } from "../capability/registry.js";
import { probeSchemaReadiness } from "../capability/schemaCapability.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validAssetId, validVersion } from "./adaptive/types.js";
import { withMediaCleanup } from "../../services/media/MediaCleanupTransport.js";

/** Reuse the canonical purge owner's authorization before deleting local
 * derivatives. Withdrawal and queue cancellation alone never authorize erasure.
 * The SQL owner locks the exact version, checks admin/account authority and
 * refuses pending recovery transfers. Once authorized, that source cannot
 * transition back to recoverable retention while a filesystem write runs. */
export async function requireDerivativeErasure(sc: SupabaseClient, source: {
  id: string; version: number; storage_bucket: string; storage_path: string;
}): Promise<string[]> {
  if (!validAssetId(source.id) || !validVersion(source.version)
    || !source.storage_bucket || !source.storage_path) throw new Error("Invalid derivative erasure identity");
  return withMediaCleanup(sc, async client => {
    // media_captions_enabled reaches this shared erasure boundary. The schema
    // proof is required even when generation is disabled; it grants no authority.
    const readiness = await probeSchemaReadiness(client, MEDIA_DERIVATIVE_ERASURE, { force: true });
    if (readiness.state !== "ready") throw new Error("Permanent derivative erasure authority unavailable");
    const { data, error } = await client.rpc("advance_media_object_purge", {
      p_asset: source.id, p_version: source.version, p_phase: "manifest",
    });
    if (error !== null || data?.ok !== true || data.bucket !== source.storage_bucket
      || data.generation !== null && !validAssetId(data.generation)
      || !Array.isArray(data.paths) || !data.paths.length
      || data.paths.some((path: unknown) => typeof path !== "string" || !path)
      || new Set(data.paths).size !== data.paths.length || !data.paths.includes(source.storage_path)) {
      throw new Error("Permanent derivative erasure authority unavailable");
    }
    return data.paths as string[];
  });
}
