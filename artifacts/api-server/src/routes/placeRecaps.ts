import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { areRecapsEnabled, recapSourceHash, proposeRecapChapters, type RecapSource } from "../lib/places/recaps.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { excludePrivateAuthorPosts } from "../lib/privacyFilter.js";
import { isEligiblePlaceDayPost, utcRangeForLocalDate } from "../lib/places/placeDays.js";

const router = Router();
const uuid = z.string().uuid();
const createSchema = z.object({ placeDayId: uuid.optional(), momentId: uuid.optional(), title: z.string().max(140).optional() })
  .refine((value) => Boolean(value.placeDayId) !== Boolean(value.momentId), "Choose one recap parent");

async function guard(req: any, res: any, kind: "place" | "moment") {
  const auth = await requireUser(req, res); if (!auth) return null;
  const sc = getServiceClient(); if (!sc) { sendError(res, "server_not_configured"); return null; }
  if (!(await areRecapsEnabled(sc, kind))) { sendError(res, "feature_disabled"); return null; }
  return { sc, userId: auth.user.id };
}
async function loadOwned(sc: any, id: string, userId: string) {
  const { data } = await sc.from("live_place_recaps").select("*").eq("id", id).eq("owner_id", userId).maybeSingle();
  return data as any | null;
}
async function guardExisting(req: any, res: any, recapId: string) {
  const auth = await requireUser(req, res); if (!auth) return null;
  const sc = getServiceClient(); if (!sc) { sendError(res, "server_not_configured"); return null; }
  const recap = await loadOwned(sc, recapId, auth.user.id);
  if (!recap) { sendError(res, "not_found"); return null; }
  if (!(await areRecapsEnabled(sc, recap.moment_id ? "moment" : "place"))) { sendError(res, "feature_disabled"); return null; }
  return { sc, userId: auth.user.id, recap };
}

/** Source lookup is intentionally read-only. SQL RPCs atomically store the
 * resulting deterministic evidence after this layer enforces viewer privacy. */
async function collectSources(sc: any, parent: any, kind: "place" | "moment", viewerId: string): Promise<{ sources: RecapSource[]; error: boolean }> {
  const blocked = await fetchBlockedSet(sc, viewerId);
  if (!blocked) return { sources: [], error: true };
  if (kind === "moment") {
    const { data, error } = await sc.from("shared_moment_contributions")
      .select("id, post_id, contributor_id, caption, created_at, posts(content, media_urls, media_thumbnail_url, media_type, visibility, status, post_status, publish_at, profiles(id, is_private))")
      .eq("moment_id", parent.id).eq("status", "approved").order("created_at", { ascending: true }).order("id", { ascending: true });
    if (error) return { sources: [], error: true };
    const rows = ((data ?? []) as any[]).filter((row) => !blocked.has(row.contributor_id) && (!row.posts || isEligiblePlaceDayPost(row.posts)))
      .map((row) => ({ ...row, profiles: row.posts?.profiles ?? null }));
    // Contributions without a post are owner-approved Moment material. Posts
    // still use the same visibility predicate and private-author safeguard.
    const publicPosts = await excludePrivateAuthorPosts(rows.filter((row) => row.posts), viewerId, sc, { authorKey: "contributor_id", profilesKey: "profiles" });
    const allowedIds = new Set(publicPosts.map((row) => row.id));
    return { sources: rows.filter((row) => !row.posts || allowedIds.has(row.id)).map((row) => ({
      id: row.id, type: "moment_contribution", postId: row.post_id ?? null, contributorId: row.contributor_id ?? null,
      caption: row.caption ?? row.posts?.content ?? null, mediaUrl: Array.isArray(row.posts?.media_urls) ? row.posts.media_urls[0] ?? null : null,
      thumbnailUrl: row.posts?.media_thumbnail_url ?? null, mediaType: row.posts?.media_type ?? null, createdAt: row.created_at ?? null,
    })), error: false };
  }
  if (!parent.local_date || !parent.timezone) return { sources: [], error: true };
  const { start, end } = utcRangeForLocalDate(parent.local_date, parent.timezone);
  const { data, error } = await sc.from("posts")
    .select("id, author_id, content, media_urls, media_thumbnail_url, media_type, created_at, visibility, status, post_status, publish_at, profiles(id, is_private)")
    .eq("canonical_place_id", parent.place_id).gte("created_at", start).lt("created_at", end)
    .order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) return { sources: [], error: true };
  const candidates = ((data ?? []) as any[]).filter((post) => !blocked.has(post.author_id) && isEligiblePlaceDayPost(post));
  const visible = await excludePrivateAuthorPosts(candidates, viewerId, sc, { profilesKey: "profiles" });
  return { sources: visible.map((post) => ({
    id: post.id, type: "place_day_post", postId: post.id, contributorId: post.author_id, caption: post.content ?? null,
    mediaUrl: Array.isArray(post.media_urls) ? post.media_urls[0] ?? null : null, thumbnailUrl: post.media_thumbnail_url ?? null,
    mediaType: post.media_type ?? null, createdAt: post.created_at ?? null,
  })), error: false };
}

router.post("/place-recaps", asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message); return; }
  const kind = parsed.data.momentId ? "moment" : "place";
  const ctx = await guard(req, res, kind); if (!ctx) return;
  const table = kind === "moment" ? "shared_moments" : "place_days";
  const parentId = parsed.data.momentId ?? parsed.data.placeDayId!;
  const { data: parent, error: parentError } = await ctx.sc.from(table).select("*").eq("id", parentId).maybeSingle();
  if (parentError || !parent || (kind === "place" && !["closing", "archived"].includes(parent.status)) || (kind === "moment" && (parent.owner_id !== ctx.userId || parent.status !== "archived"))) {
    sendError(res, "not_found", "Eligible recap parent not found"); return;
  }
  const { data: place } = await ctx.sc.from("places").select("id, name, city").eq("id", parent.place_id).maybeSingle();
  if (!place) { sendError(res, "not_found", "Place not found"); return; }
  const collected = await collectSources(ctx.sc, parent, kind, ctx.userId);
  if (collected.error) { sendError(res, "db_error", "Eligible recap sources could not be verified"); return; }
  if (kind === "place" && !collected.sources.some((source) => source.contributorId === ctx.userId)) {
    // A Place Day is a shared place/date anchor, not a user-owned record.
    // Its recap owner must therefore be an eligible participant in this exact
    // canonical place/local-day source set; the RPC repeats this invariant.
    sendError(res, "forbidden", "Add eligible activity on this Place Day before creating a recap"); return;
  }
  const chapters = proposeRecapChapters(collected.sources);
  const placeSnapshot = { id: place.id, name: place.name, city: place.city ?? null };
  const { data, error } = await ctx.sc.rpc("create_live_place_recap", {
    p_owner_id: ctx.userId, p_place_day_id: kind === "place" ? parent.id : null, p_moment_id: kind === "moment" ? parent.id : null,
    p_place_id: place.id, p_title: parsed.data.title ?? place.name, p_source_hash: recapSourceHash(collected.sources),
    p_place_snapshot: placeSnapshot, p_sources: collected.sources, p_chapters: chapters,
  });
  if (error || !data) { sendError(res, "db_error", error?.message ?? "Could not save complete recap evidence"); return; }
  res.status(201).json({ recap: data.recap, version: { ...data.version, chapterSuggestions: chapters, sourceCount: collected.sources.length }, label: "Compass suggestions require review before publication." });
}));

router.post("/place-recaps/:id/review", asyncHandler(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) { sendError(res, "invalid_payload"); return; }
  const ctx = await guardExisting(req, res, req.params.id); if (!ctx) return;
  const { data, error } = await ctx.sc.rpc("transition_live_place_recap", { p_recap_id: ctx.recap.id, p_owner_id: ctx.userId, p_action: "review" });
  if (error || !data) { sendError(res, "conflict", error?.message ?? "Draft version required"); return; }
  res.json(data);
}));
router.post("/place-recaps/:id/publish", asyncHandler(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) { sendError(res, "invalid_payload"); return; }
  const ctx = await guardExisting(req, res, req.params.id); if (!ctx) return;
  const { data, error } = await ctx.sc.rpc("transition_live_place_recap", { p_recap_id: ctx.recap.id, p_owner_id: ctx.userId, p_action: "publish" });
  if (error || !data) { sendError(res, "conflict", error?.message ?? "Reviewed version required"); return; }
  res.json(data);
}));
router.post("/place-recaps/:id/regenerate", asyncHandler(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) { sendError(res, "invalid_payload"); return; }
  const ctx = await guardExisting(req, res, req.params.id); if (!ctx || ctx.recap.status === "removed") return;
  const { data: prior } = await ctx.sc.from("live_place_recap_versions").select("*").eq("id", ctx.recap.current_version_id).maybeSingle();
  const table = ctx.recap.place_day_id ? "place_days" : "shared_moments";
  const parentId = ctx.recap.place_day_id ?? ctx.recap.moment_id;
  const { data: parent } = await ctx.sc.from(table).select("*").eq("id", parentId).maybeSingle();
  if (!prior || !parent) { sendError(res, "not_found", "Recap parent or version no longer exists"); return; }
  const collected = await collectSources(ctx.sc, parent, ctx.recap.moment_id ? "moment" : "place", ctx.userId);
  if (collected.error) { sendError(res, "db_error", "Eligible recap sources could not be verified"); return; }
  const chapters = proposeRecapChapters(collected.sources);
  const { data, error } = await ctx.sc.rpc("regenerate_live_place_recap", {
    p_recap_id: ctx.recap.id, p_owner_id: ctx.userId, p_source_hash: recapSourceHash(collected.sources),
    p_place_snapshot: prior.place_snapshot, p_sources: collected.sources, p_chapters: chapters,
  });
  if (error || !data) { sendError(res, "db_error", error?.message ?? "Could not save recap version"); return; }
  res.status(201).json({ version: data.version, label: "New draft created; published history was not changed." });
}));
async function lifecycleAction(req: any, res: any, action: "archive" | "restore" | "remove") {
  if (!uuid.safeParse(req.params.id).success) { sendError(res, "invalid_payload"); return; }
  const ctx = await guardExisting(req, res, req.params.id); if (!ctx) return;
  const { data, error } = await ctx.sc.rpc("transition_live_place_recap", { p_recap_id: ctx.recap.id, p_owner_id: ctx.userId, p_action: action });
  if (error || !data) { sendError(res, "conflict", error?.message ?? "That recap transition is not available"); return; }
  res.json(data);
}
router.post("/place-recaps/:id/archive", asyncHandler((req, res) => lifecycleAction(req, res, "archive")));
router.post("/place-recaps/:id/restore", asyncHandler((req, res) => lifecycleAction(req, res, "restore")));
router.post("/place-recaps/:id/remove", asyncHandler((req, res) => lifecycleAction(req, res, "remove")));

router.get("/places/:placeId/recaps", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res, "place"); if (!ctx) return;
  if (!uuid.safeParse(req.params.placeId).success) { sendError(res, "invalid_payload"); return; }
  const { data, error } = await ctx.sc.from("live_place_recaps").select("id, place_id, status, created_at, current_version_id, live_place_recap_versions!inner(version_number, title, summary, published_at)")
    .eq("owner_id", ctx.userId).eq("place_id", req.params.placeId).neq("status", "removed").order("created_at", { ascending: false });
  if (error) { sendError(res, "db_error", error.message); return; } res.json({ recaps: data ?? [] });
}));
router.get("/place-recaps/:id", asyncHandler(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) { sendError(res, "invalid_payload"); return; }
  const ctx = await guardExisting(req, res, req.params.id); if (!ctx || ctx.recap.status === "removed") { if (ctx?.recap.status === "removed") sendError(res, "not_found"); return; }
  const [version, chapters, snapshots] = await Promise.all([
    ctx.sc.from("live_place_recap_versions").select("*").eq("id", ctx.recap.current_version_id).maybeSingle(),
    ctx.sc.from("live_place_recap_chapters").select("*").eq("version_id", ctx.recap.current_version_id).order("ordinal"),
    ctx.sc.from("live_place_recap_snapshots").select("source_id, snapshot_kind, payload").eq("version_id", ctx.recap.current_version_id),
  ]);
  if (version.error || chapters.error || snapshots.error) { sendError(res, "db_error", "Could not load recap"); return; }
  if (!version.data) { sendError(res, "not_found"); return; }
  res.json({ recap: ctx.recap, version: version.data, chapters: chapters.data ?? [], snapshots: snapshots.data ?? [] });
}));
export default router;