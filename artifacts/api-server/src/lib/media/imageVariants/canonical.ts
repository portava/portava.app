import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeMediaAccess } from "../../mediaAccess.js";
import { resolveAccountRestriction } from "../../accountStateGate.js";
import { readFlagState } from "../../capability/schemaCapability.js";
import { mayViewUnderOverride } from "../../mediaVisibility.js";
import { abortable, sameSource, validSource, UUID, type ImageVariantSource } from "./contracts.js";

export interface ImageVariantsConfig { enabled: boolean; root: string; storageOrigin: string; encoderEntrypoint?: URL }
const COLUMNS = "id,version,owner_user_id,storage_bucket,storage_path,size_bytes,mime_type,media_type,processing_status,moderation_status,deleted_at,purge_status,visibility";

export function imageSource(row: any): ImageVariantSource | null {
  const source = { assetId: row?.id, ownerUserId: row?.owner_user_id, sourceVersion: row?.version,
    bucket: row?.storage_bucket, path: row?.storage_path, sizeBytes: row?.size_bytes };
  return validSource(source) ? source : null;
}
export function createImageVariantsAccess(sc: SupabaseClient, config: ImageVariantsConfig) {
  async function enabled(signal: AbortSignal): Promise<boolean> {
    if (!config.enabled) return false;
    // Two literal reads, in order, through the shared four-state reader: an unreadable flag throws, anything but "on" is off.
    const canonical = await abortable(readFlagState(sc, "media_canonical_enabled"), signal);
    if (canonical === "unreadable") throw new Error("image feature state unavailable");
    if (canonical !== "on") return false;
    const derivatives = await abortable(readFlagState(sc, "media_derivative_jobs_enabled"), signal);
    if (derivatives === "unreadable") throw new Error("image feature state unavailable");
    return derivatives === "on";
  }
  async function row(assetId: string, signal: AbortSignal) {
    if (!UUID.test(assetId)) throw new Error("invalid image asset");
    const answer = await abortable(sc.from("media_assets").select(COLUMNS).eq("id", assetId).abortSignal(signal).maybeSingle(), signal);
    if (answer.error) throw new Error("image canonical read unavailable");
    return answer.data;
  }
  async function activeAccount(userId: string, signal: AbortSignal): Promise<boolean> {
    if (!UUID.test(userId)) return false;
    const profile = await abortable(sc.from("profiles").select("id,account_status").eq("id", userId).abortSignal(signal).maybeSingle(), signal);
    if (profile.error || profile.data?.id !== userId || profile.data?.account_status !== "active") return false;
    const account = await abortable(resolveAccountRestriction(sc, userId), signal);
    return account.state === "ok" && account.accountStatus === "active" && account.restriction.kind === "none";
  }
  async function current(source: ImageVariantSource, signal: AbortSignal): Promise<{ mime: string; visibility: string } | null> {
    if (!validSource(source) || !await enabled(signal)) return null;
    const data = await row(source.assetId, signal);
    const canonical = imageSource(data);
    if (!data || !canonical || !sameSource(canonical, source) || data.media_type !== "image" || data.processing_status !== "ready" ||
        !["active", "approved"].includes(data.moderation_status) || data.deleted_at !== null || data.purge_status !== "not_requested" ||
        !["image/jpeg", "image/png", "image/webp"].includes(data.mime_type) ||
        !["inherit", "public", "private", "followers", "following", "trip_crew", "shared_moment"].includes(data.visibility) ||
        !await activeAccount(source.ownerUserId, signal)) return null;
    return { mime: data.mime_type, visibility: data.visibility };
  }
  async function authorized(source: ImageVariantSource, viewerId: string, signal: AbortSignal): Promise<boolean> {
    const canonical = await current(source, signal);
    return !!canonical && await activeAccount(viewerId, signal) &&
      await abortable(mayViewUnderOverride(sc, viewerId, source.ownerUserId, canonical.visibility), signal) &&
      await abortable(authorizeMediaAccess(sc, viewerId, source.bucket, source.path), signal);
  }
  return { enabled, row, current, authorized };
}

export function createImageVariantsAcquirer(sc: SupabaseClient, config: ImageVariantsConfig, access: ReturnType<typeof createImageVariantsAccess>, transport: typeof fetch = fetch) {
  return async (source: ImageVariantSource, signal: AbortSignal, checkLease: () => Promise<void>): Promise<Buffer> => {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const origin = new URL(config.storageOrigin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.hash || origin.search || origin.pathname !== "/") throw new Error("trusted storage origin required");
    const expected = await access.current(source, boundedSignal);
    if (!expected) throw new Error("image source unavailable");
    await checkLease();
    const signed = await abortable(sc.storage.from(source.bucket).createSignedUrl(source.path, 15), boundedSignal);
    if (signed.error || typeof signed.data?.signedUrl !== "string" || signed.data.signedUrl.length > 10000) throw new Error("image source signing failed");
    const url = new URL(signed.data.signedUrl);
    if (url.origin !== origin.origin || url.username || url.password || url.hash || url.searchParams.size !== 1 || !url.searchParams.get("token") ||
        url.pathname !== `/storage/v1/object/sign/${source.bucket}/${source.path.split("/").map(encodeURIComponent).join("/")}`) throw new Error("signed image source mismatch");
    await checkLease();
    const response = await abortable(transport(url, { redirect: "error", credentials: "omit", signal: boundedSignal,
      headers: { "Cache-Control": "no-store", "Accept-Encoding": "identity" } }), boundedSignal);
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || !response.body || (response.url && response.url !== url.href) ||
        response.headers.get("content-type")?.split(";")[0]?.trim() !== expected.mime ||
        ![null, "identity"].includes(response.headers.get("content-encoding")) ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) !== source.sizeBytes))) {
      void response.body?.cancel().catch(() => {}); throw new Error("image download refused");
    }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    boundedSignal.addEventListener("abort", cancel, { once: true });
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        boundedSignal.throwIfAborted();
        const next = await abortable(reader.read(), boundedSignal);
        if (next.done) break;
        total += next.value.length;
        if (total > source.sizeBytes) throw new Error("image byte budget exceeded");
        chunks.push(Buffer.from(next.value));
      }
      if (total !== source.sizeBytes || (await access.current(source, boundedSignal))?.mime !== expected.mime) throw new Error("image source changed");
      await checkLease();
      return Buffer.concat(chunks, total);
    } finally {
      cancel(); boundedSignal.removeEventListener("abort", cancel);
      for (const chunk of chunks) chunk.fill(0);
    }
  };
}
