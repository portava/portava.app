import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { appStorageUrlInfo, configuredStorageOrigin } from "../../lib/mediaUrl.js";
import { memoryItemMediaUrlAccepted } from "./memoryMediaOrigin.js";

const identity = z.string().uuid();

/** Historical signed links identify an object, never current read authority.
 * Parse only this deployment's origin and never return or renew their token. */
export function memoryRecoveryStorageRef(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.origin !== configuredStorageOrigin()) return null;
    if (parsed.pathname.startsWith("/storage/v1/object/sign/")) {
      parsed.pathname = parsed.pathname.replace("/storage/v1/object/sign/", "/storage/v1/object/public/");
      parsed.search = ""; parsed.hash = "";
      return appStorageUrlInfo(parsed.toString());
    }
  } catch { /* Bare keys are parsed by the existing origin-safe parser. */ }
  return appStorageUrlInfo(url);
}

export const memoryMediaUrlReviewHash = (url: string): string => createHash("sha256").update(url).digest("hex");
export class MemoryMediaBindingConflict extends Error {}

/** Read every unbound reference of the source owner at one unchanged digest.
 * The existing restoration command checks it again under its write fence.
 * An alias must first use the reviewed binding command; this scan never binds. */
export async function reviewUnboundMemoryReferences(client: SupabaseClient, assetId: string,
  source: { bucket: string; path: string }, actorId: string) {
  const origin = configuredStorageOrigin();
  if (!identity.safeParse(assetId).success || !identity.safeParse(actorId).success || !origin) throw new Error("Memory reference review unavailable");
  const schema = z.object({ ownerId: identity, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), total: z.number().int().nonnegative(),
    items: z.array(z.object({ id: identity, memory_id: identity, media_url: z.string() })).max(100) });
  let after: string | null = null, fingerprint: string | null = null, ownerId: string | null = null, total: number | null = null, seen = 0;
  for (let page = 0; page < 1000; page++) {
    const response = await client.rpc("memory_unbound_reference_snapshot", { p_actor: actorId, p_asset: assetId, p_after: after, p_limit: 100 });
    const parsed = schema.safeParse(response.data);
    if (response.error !== null || !parsed.success) throw new Error(`Memory reference review unavailable (${response.error?.code ?? (parsed.success ? "missing error envelope" : parsed.error.issues.map(issue => issue.path.join(".")).join(","))})`);
    const snapshot = parsed.data;
    if (fingerprint !== null && (snapshot.fingerprint !== fingerprint || snapshot.ownerId !== ownerId || snapshot.total !== total)) {
      throw new Error("Memory references changed during review");
    }
    fingerprint = snapshot.fingerprint; ownerId = snapshot.ownerId; total = snapshot.total;
    for (const item of snapshot.items) {
      if (after !== null && item.id <= after) throw new Error("Memory reference review did not advance");
      after = item.id; seen++;
      const ref = memoryRecoveryStorageRef(item.media_url);
      if (ref?.bucket === source.bucket && ref.path === source.path) throw new Error("Restoration Memory reference requires reconciliation");
    }
    if (seen > total || snapshot.items.length === 0 && seen < total) throw new Error("Memory reference review incomplete");
    if (seen === total) return { ownerId, fingerprint, total, storageOrigin: total === 0 ? null : origin, reviewed: true };
  }
  throw new Error("Memory reference review exceeds the bounded scan");
}

const inventoryItem = z.object({ id: identity, memory_id: identity, media_url: z.string() });
const inventoryParent = z.object({ id: identity, owner_id: identity, state: z.string(), title: z.string().nullish() });
const inventoryAsset = z.object({ id: identity, owner_user_id: identity, purge_status: z.string() });
type BindingStatus = "candidate" | "external_reference" | "unsupported_reference" | "missing_source" | "ambiguous_source" | "owner_mismatch" | "unavailable";
export type MemoryMediaBindingReview = {
  itemId: string; memoryId: string; memoryTitle: string | null; reviewedUrlHash: string; status: BindingStatus;
  source: { bucket: string; path: string } | null; assetId: string | null;
};

/** Bounded keyset page over the existing rows. This is a review queue, not a
 * snapshot or a backfill. A new scan is needed to catch concurrent older IDs.
 * Any failed read refuses the whole page instead of fabricating missing data. */
export async function listMemoryMediaBindings(client: SupabaseClient, options: { after?: string; memoryId?: string; limit?: number } = {}) {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50
    || options.after !== undefined && !identity.safeParse(options.after).success
    || options.memoryId !== undefined && !identity.safeParse(options.memoryId).success) throw new Error("Invalid Memory binding page");
  let query = client.from("memory_items").select("id,memory_id,media_url").is("media_asset_id", null).order("id").limit(limit + 1);
  if (options.after) query = query.gt("id", options.after);
  if (options.memoryId) query = query.eq("memory_id", options.memoryId);
  const page = await query;
  const parsed = z.array(inventoryItem).max(limit + 1).safeParse(page.data);
  if (page.error !== null || !parsed.success) throw new Error("Memory binding inventory unavailable");
  const rows = parsed.data.slice(0, limit), items: MemoryMediaBindingReview[] = [];
  for (const item of rows) {
    const source = memoryRecoveryStorageRef(item.media_url);
    const review: MemoryMediaBindingReview = { itemId: item.id, memoryId: item.memory_id, memoryTitle: null,
      reviewedUrlHash: memoryMediaUrlReviewHash(item.media_url), status: "unsupported_reference", source, assetId: null };
    items.push(review);
    const parent = await client.from("memories").select("id,owner_id,state,title").eq("id", item.memory_id).maybeSingle();
    if (parent.error !== null) throw new Error("Memory binding inventory unavailable");
    if (parent.data === null) { review.status = "unavailable"; continue; }
    const memory = inventoryParent.safeParse(parent.data);
    if (!memory.success || memory.data.id !== item.memory_id) throw new Error("Memory binding inventory unavailable");
    review.memoryTitle = memory.data.title ?? null;
    if (!source) {
      // A Storage-shaped foreign/malformed URL remains unresolved, never local.
      if (!item.media_url.includes("/storage/v1/") && memoryItemMediaUrlAccepted(item.media_url, configuredStorageOrigin())) review.status = "external_reference";
      continue;
    }
    const found = await client.from("media_assets").select("id,owner_user_id,purge_status")
      .eq("storage_bucket", source.bucket).eq("storage_path", source.path).limit(2);
    const candidates = z.array(inventoryAsset).max(2).safeParse(found.data);
    if (found.error !== null || !candidates.success) throw new Error("Memory binding inventory unavailable");
    if (candidates.data.length === 0) { review.status = "missing_source"; continue; }
    if (candidates.data.length !== 1) { review.status = "ambiguous_source"; continue; }
    const asset = candidates.data[0]!;
    if (asset.owner_user_id !== memory.data.owner_id) { review.status = "owner_mismatch"; continue; }
    if (!["draft", "published", "archived"].includes(memory.data.state) || !["not_requested", "retained"].includes(asset.purge_status)) { review.status = "unavailable"; continue; }
    review.status = "candidate"; review.assetId = asset.id;
  }
  return { items, nextCursor: parsed.data.length > limit ? rows[rows.length - 1]!.id : null };
}

/** Derived coordinates are service input, never copied from a caller's proof.
 * External HTTPS references retain their existing unbound behavior. */
export function prepareMemoryItemWrite(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Memory media write");
  const write = value as Record<string, unknown>;
  if (typeof write.media_url !== "string" || !write.media_url) throw new Error("Invalid Memory media URL");
  const ref = appStorageUrlInfo(write.media_url);
  if (!ref && !memoryItemMediaUrlAccepted(write.media_url, configuredStorageOrigin())) throw new Error("Invalid Memory media URL");
  return { ...write, source_ref: ref };
}

/** Reconcile one existing item's source through the Memory owner. Parsing does
 * not grant access: SQL rechecks the admin, owner, exact URL/key and lifecycle
 * under locks, then commits the reference and its audit together. */
export async function reconcileMemoryMediaBinding(client: SupabaseClient, actorId: string,
  itemId: string, assetId: string, reason: string, reviewedUrlHash?: string,
): Promise<{ itemId: string; assetId: string; alreadyBound: boolean }> {
  if (![actorId, itemId, assetId].every(value => identity.safeParse(value).success)
    || !reason.trim() || reason.length > 1000) throw new Error("Invalid Memory media binding review");
  const [item, asset] = await Promise.all([
    client.from("memory_items").select("id,media_url").eq("id", itemId).maybeSingle(),
    client.from("media_assets").select("id,storage_bucket,storage_path").eq("id", assetId).maybeSingle(),
  ]);
  if (item.error !== null || asset.error !== null || item.data?.id !== itemId || asset.data?.id !== assetId
    || typeof item.data.media_url !== "string") throw new Error("Memory media binding source unavailable");
  if (reviewedUrlHash !== undefined && reviewedUrlHash !== memoryMediaUrlReviewHash(item.data.media_url)) {
    throw new MemoryMediaBindingConflict("Memory media reference changed; refresh the review");
  }
  const ref = memoryRecoveryStorageRef(item.data.media_url);
  if (!ref || ref.bucket !== asset.data.storage_bucket || ref.path !== asset.data.storage_path) {
    throw new Error("Memory media binding source invalid");
  }
  const result = await client.rpc("reconcile_memory_media_binding", { p_actor: actorId, p_item: itemId, p_asset: assetId,
    p_url: item.data.media_url, p_bucket: ref.bucket, p_path: ref.path, p_reason: reason.trim() });
  if (result.error === null && result.data?.ok === false) throw new MemoryMediaBindingConflict("Memory media binding unconfirmed; refresh the review");
  if (result.error !== null || result.data?.ok !== true || result.data.itemId !== itemId || result.data.assetId !== assetId
    || typeof result.data.alreadyBound !== "boolean") throw new Error("Memory media binding unconfirmed");
  return { itemId, assetId, alreadyBound: result.data.alreadyBound };
}
