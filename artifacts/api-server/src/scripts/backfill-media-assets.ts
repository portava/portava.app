/**
 * backfill-media-assets — idempotent backfill of the canonical media layer
 * (migration 0189) from the legacy bare-URL columns (media Phase 0 audit §59).
 *
 * For each known legacy source it parses the public URL back to bucket+path,
 * upserts a media_assets row (unique on bucket+path → safe to re-run), and
 * links a media_attachments row (unique on asset+entity → safe to re-run).
 * Rows whose URL is not our storage (external/injected URLs) are counted and
 * reported as UNRESOLVED, never guessed at.
 *
 * Usage (requires media_canonical_enabled — the script checks and refuses):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node --import tsx/esm src/scripts/backfill-media-assets.ts
 */
import { createClient } from "@supabase/supabase-js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
const sc = createClient(url, key, { auth: { persistSession: false } });

const PAGE = 500;
const stats = { assets: 0, attachments: 0, unresolved: 0, errors: 0 };

function guessType(u: string): "image" | "video" {
  return /\.(mp4|mov|m4v|webm)(\?|$)/i.test(u) ? "video" : "image";
}

async function upsertAsset(owner: string, publicUrl: string, sourceType = "user"): Promise<string | null> {
  const ref = appStorageUrlInfo(publicUrl);
  if (!ref) { stats.unresolved++; return null; }
  const mediaType = guessType(publicUrl);
  const { data, error } = await sc
    .from("media_assets")
    .upsert(
      {
        owner_user_id: owner,
        uploader_user_id: owner,
        storage_bucket: ref.bucket,
        storage_path: ref.path,
        public_url: publicUrl,
        media_type: mediaType,
        mime_type: mediaType === "video" ? "video/mp4" : "image/jpeg",
        size_bytes: 0, // unknown for legacy rows — honest zero, not a guess
        source_type: sourceType,
        // Dimension constraint (migration 2089): processing_status='ready'
        // requires non-null width AND height.  Legacy backfill rows have no
        // dimension data — the original upload never measured them — so we
        // stage them as 'processing'.  A follow-on dimension sweep (or
        // completeVideoTranscode()) must transition them to 'ready' once real
        // dimensions are known.  Until then the rows are created but not served
        // to clients (feed filters out non-ready rows), which is the correct
        // safe default.
        processing_status: "processing",
        // Canonical §36 MediaModerationStatus (migration 2250): the promoted /
        // distributable state is 'active' (legacy 'approved' → 'active'). These
        // rows back content that is ALREADY served on the per-object path, so
        // they promote straight to 'active'. The distribution gate
        // (lib/mediaEligibility) recognizes both 'active' and legacy 'approved'.
        moderation_status: "active",
      },
      { onConflict: "storage_bucket,storage_path" },
    )
    .select("id")
    .single();
  if (error) { stats.errors++; return null; }
  stats.assets++;
  return (data as any).id;
}

async function attach(assetId: string, entityType: string, entityId: string, position = 0, isCover = false) {
  const { error } = await sc.from("media_attachments").upsert(
    { media_asset_id: assetId, entity_type: entityType, entity_id: entityId, position, is_cover: isCover },
    { onConflict: "media_asset_id,entity_type,entity_id" },
  );
  if (error) stats.errors++;
  else stats.attachments++;
}

async function pages(table: string, cols: string, filter?: (q: any) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = sc.from(table).select(cols).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) { console.error(`  read ${table} failed: ${error.message}`); stats.errors++; break; }
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function main() {
  // Refuse to run while the canonical layer is dark.
  const { data: flag } = await sc.from("feature_flags").select("enabled").eq("flag", "media_canonical_enabled").maybeSingle();
  if (!(flag as any)?.enabled) {
    console.error("media_canonical_enabled is OFF — flip it before backfilling (migration 0189).");
    process.exit(1);
  }

  console.log("[1] posts.media_urls[] …");
  for (const p of await pages("posts", "id, author_id, media_urls", (q) => q.not("media_urls", "is", null))) {
    const urls: string[] = Array.isArray(p.media_urls) ? p.media_urls : [];
    for (let i = 0; i < urls.length; i++) {
      const id = await upsertAsset(p.author_id, urls[i]);
      if (id) await attach(id, "post", p.id, i, i === 0);
    }
  }

  console.log("[2] post_media (postcards) …");
  for (const m of await pages("post_media", "id, user_id, post_id, public_url, sort_order", (q) => q.eq("processing_status", "ready"))) {
    if (!m.public_url) { stats.unresolved++; continue; }
    const id = await upsertAsset(m.user_id, m.public_url);
    if (id) await attach(id, "post", m.post_id, m.sort_order ?? 0, (m.sort_order ?? 0) === 0);
  }

  console.log("[3] profiles avatar/cover …");
  for (const pr of await pages("profiles", "id, avatar_url, cover_photo_url")) {
    if (pr.avatar_url) {
      const id = await upsertAsset(pr.id, pr.avatar_url);
      if (id) await attach(id, "profile_avatar", pr.id, 0, true);
    }
    if (pr.cover_photo_url) {
      const id = await upsertAsset(pr.id, pr.cover_photo_url);
      if (id) await attach(id, "profile_cover", pr.id, 0, true);
    }
  }

  console.log("[4] trips.cover_url …");
  for (const t of await pages("trips", "id, owner_id, cover_url", (q) => q.not("cover_url", "is", null))) {
    const id = await upsertAsset(t.owner_id, t.cover_url);
    if (id) await attach(id, "trip", t.id, 0, true);
  }

  console.log("[5] events cover + event_media …");
  for (const e of await pages("events", "id, host_id, cover_url", (q) => q.not("cover_url", "is", null))) {
    const id = await upsertAsset(e.host_id, e.cover_url);
    if (id) await attach(id, "event", e.id, 0, true);
  }
  for (const em of await pages("event_media", "id, event_id, uploader_id, media_url")) {
    const id = await upsertAsset(em.uploader_id, em.media_url, "community");
    if (id) await attach(id, "event", em.event_id, 1, false);
  }

  console.log("[6] stories + highlights …");
  for (const s of await pages("stories", "id, owner_id, media_url", (q) => q.neq("state", "expired"))) {
    const id = await upsertAsset(s.owner_id, s.media_url);
    if (id) await attach(id, "story", s.id, 0, true);
  }
  for (const h of await pages("highlights", "id, owner_id, media_url")) {
    const id = await upsertAsset(h.owner_id, h.media_url);
    if (id) await attach(id, "highlight", h.id, 0, true);
  }

  console.log("[7] passport_memories.photo_url …");
  for (const m of await pages("passport_memories", "id, user_id, photo_url", (q) => q.not("photo_url", "is", null))) {
    const id = await upsertAsset(m.user_id, m.photo_url);
    if (id) await attach(id, "memory", m.id, 0, true);
  }

  console.log("[7b] passport_postcards.media_url …");
  for (const pc of await pages("passport_postcards", "id, user_id, media_url", (q) => q.not("media_url", "is", null))) {
    const id = await upsertAsset(pc.user_id, pc.media_url);
    if (id) await attach(id, "postcard", pc.id, 0, true);
  }

  console.log("[7c] hidden_gems.image_url …");
  for (const g of await pages("hidden_gems", "id, submitted_by, image_url", (q) => q.not("image_url", "is", null))) {
    const id = await upsertAsset(g.submitted_by, g.image_url, "community");
    if (id) await attach(id, "hidden_gem", g.id, 0, true);
  }

  console.log("[8] rent_buddy_profiles cover + gallery …");
  for (const b of await pages("rent_buddy_profiles", "id, user_id, cover_photo_url, gallery_urls")) {
    if (b.cover_photo_url) {
      const id = await upsertAsset(b.user_id, b.cover_photo_url);
      if (id) await attach(id, "buddy_listing", b.id, 0, true);
    }
    const gallery: string[] = Array.isArray(b.gallery_urls) ? b.gallery_urls : [];
    for (let i = 0; i < gallery.length; i++) {
      const id = await upsertAsset(b.user_id, gallery[i]);
      if (id) await attach(id, "buddy_listing", b.id, i + 1, false);
    }
  }

  console.log("\nDone.", stats);
  console.log("UNRESOLVED = URLs not in our storage (external/injected) — listed for manual review, never guessed.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
