import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { excludePrivateAuthorPosts } from "../lib/privacyFilter.js";
import { isLivePlacesCapabilityEnabled } from "../lib/featureFlags.js";
import { appendMomentAudit, areSharedMomentsEnabled, momentRole } from "../lib/places/sharedMoments.js";
import { recordMediaAttachment } from "../lib/mediaAssets.js"; import { recordMediaInviteIfAttributable } from "../lib/mediaAnalytics.js";

const router = Router();
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const createSchema = z.object({
  title: z.string().trim().min(1).max(140),
  description: z.string().trim().max(1000).nullable().optional(),
  placeDayId: uuid.optional(), placeId: uuid.optional(), tripId: uuid.optional(),
  joinPolicy: z.enum(["invite_only", "approval_required"]).default("invite_only"),
}).refine((v) => Boolean(v.placeDayId || v.placeId || v.tripId), "A Place Day, place, or trip is required");
const inviteSchema = z.object({ userId: uuid, originMediaId: uuid.optional() });
const responseSchema = z.object({ response: z.enum(["accept", "decline"]) });
const contributionSchema = z.object({ postId: uuid.optional(), mediaAssetId: uuid.optional(), caption: z.string().trim().min(1).max(1000).optional() })
  .refine((v) => Boolean(v.postId || v.mediaAssetId || v.caption), "A source or caption is required");
const cursorSchema = z.string().transform((value, ctx) => {
  const separator = value.lastIndexOf("|");
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (separator <= 0 || !Number.isFinite(Date.parse(createdAt)) || !uuid.safeParse(id).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid cursor" });
    return z.NEVER;
  }
  return { createdAt: new Date(createdAt).toISOString(), id };
});

async function guard(req: any, res: any) {
  const auth = await requireUser(req, res); if (!auth) return null;
  const sc = getServiceClient(); if (!sc) { sendError(res, "server_not_configured"); return null; }
  if (!(await areSharedMomentsEnabled(sc))) { sendError(res, "feature_disabled", "Shared Moments is unavailable"); return null; }
  return { sc, userId: auth.user.id };
}
function mapMoment(row: any, role: string | null = null) {
  return {
    id: row.id, title: row.title, description: row.description ?? null, placeDayId: row.place_day_id ?? null,
    placeId: row.place_id ?? null, tripId: row.trip_id ?? null, joinPolicy: row.join_policy,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, role,
  };
}
async function getMoment(sc: any, id: string) {
  const { data, error } = await sc.from("shared_moments").select("*").eq("id", id).maybeSingle();
  return { row: data as any, error };
}
async function ownerOrManager(sc: any, momentId: string, userId: string) {
  const role = await momentRole(sc, momentId, userId);
  return role === "owner" || role === "manager";
}

router.get("/shared-moments", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const parsed = z.object({ placeDayId: uuid.optional(), placeId: uuid.optional(), tripId: uuid.optional() }).safeParse(req.query);
  if (!parsed.success) { sendError(res, "invalid_payload"); return; }
  const { data, error } = await ctx.sc.from("shared_moment_memberships")
    .select("role, status, shared_moments(*)").eq("user_id", ctx.userId).eq("status", "accepted").order("updated_at", { ascending: false });
  if (error) { sendError(res, "db_error", error.message); return; }
  const items = ((data ?? []) as any[]).map((r) => ({ row: r.shared_moments, role: r.role }))
    .filter(({ row }) => row?.status === "active")
    .filter(({ row }) => !parsed.data.placeDayId || row.place_day_id === parsed.data.placeDayId)
    .filter(({ row }) => !parsed.data.placeId || row.place_id === parsed.data.placeId)
    .filter(({ row }) => !parsed.data.tripId || row.trip_id === parsed.data.tripId)
    .map(({ row, role }) => mapMoment(row, role));
  res.json({ moments: items });
}));

router.post("/shared-moments", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const parsed = createSchema.safeParse(req.body); if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message); return; }
  const p = parsed.data;
  const { data: moment, error } = await ctx.sc.from("shared_moments").insert({
    owner_id: ctx.userId, title: p.title, description: p.description ?? null, place_day_id: p.placeDayId ?? null,
    place_id: p.placeId ?? null, trip_id: p.tripId ?? null, join_policy: p.joinPolicy,
  }).select("*").single();
  if (error) { sendError(res, "db_error", error.message); return; }
  const { error: memberError } = await ctx.sc.from("shared_moment_memberships").insert({
    moment_id: (moment as any).id, user_id: ctx.userId, role: "owner", status: "accepted", invited_by: ctx.userId, responded_at: new Date().toISOString(),
  });
  if (memberError) { sendError(res, "db_error", memberError.message); return; }
  await appendMomentAudit(ctx.sc, (moment as any).id, ctx.userId, "created");
  res.status(201).json({ moment: mapMoment(moment, "owner") });
}));

router.get("/shared-moments/suggestions/mine", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const [compass, clustering] = await Promise.all([
    isLivePlacesCapabilityEnabled(ctx.sc, "shared_moments_compass_suggestions_enabled"),
    isLivePlacesCapabilityEnabled(ctx.sc, "shared_moments_clustering_enabled"),
  ]);
  if (!compass && !clustering) { res.json({ suggestions: [], labeled: true }); return; }
  const { data } = await ctx.sc.from("shared_moment_suggestions").select("id, moment_id, kind, reason, created_at").eq("recipient_id", ctx.userId).eq("status", "offered").order("created_at", { ascending: false }).limit(20);
  res.json({ suggestions: (data ?? []).filter((s: any) => (s.kind === "compass" ? compass : clustering)).map((s: any) => ({ id: s.id, momentId: s.moment_id, kind: s.kind, reason: s.reason, label: "Suggestion — no one is joined or added automatically.", createdAt: s.created_at })), labeled: true });
}));

router.get("/shared-moments/:id", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params); if (!params.success) { sendError(res, "invalid_payload"); return; }
  const { row, error } = await getMoment(ctx.sc, params.data.id);
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!row) { sendError(res, "not_found"); return; }
  const role = await momentRole(ctx.sc, row.id, ctx.userId);
  if (!role) { sendError(res, "not_member", "Join this Moment to view it"); return; }
  const chatAvailable = await isLivePlacesCapabilityEnabled(ctx.sc, "shared_moments_chat_enabled");
  const { data: members } = await ctx.sc.from("shared_moment_memberships").select("user_id, role, status").eq("moment_id", row.id).eq("status", "accepted");
  res.json({ moment: mapMoment(row, role), members: (members ?? []).map((m: any) => ({ userId: m.user_id, role: m.role })), chat: { available: chatAvailable, reason: chatAvailable ? null : "Chat is not available for Shared Moments yet." } });
}));

router.post("/shared-moments/:id/invites", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params), parsed = inviteSchema.safeParse(req.body);
  if (!params.success || !parsed.success) { sendError(res, "invalid_payload"); return; }
  if (!(await ownerOrManager(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "forbidden"); return; }
  if (parsed.data.userId === ctx.userId) { sendError(res, "invalid_payload", "You cannot invite yourself"); return; }
  const blocked = await fetchBlockedSet(ctx.sc, ctx.userId);
  if (blocked === null || blocked.has(parsed.data.userId)) { sendError(res, "forbidden", "This invitation is unavailable"); return; }
  const { data: existing, error: existingError } = await ctx.sc.from("shared_moment_memberships")
    .select("role, status").eq("moment_id", params.data.id).eq("user_id", parsed.data.userId).maybeSingle();
  if (existingError) { sendError(res, "db_error", existingError.message); return; }
  if ((existing as any)?.status === "accepted") {
    res.json({ ok: true, status: "accepted", idempotent: true });
    return;
  }
  const { error } = await ctx.sc.from("shared_moment_memberships").upsert({
    moment_id: params.data.id, user_id: parsed.data.userId, role: "member", status: "invited", invited_by: ctx.userId, responded_at: null, removed_at: null, updated_at: new Date().toISOString(),
  }, { onConflict: "moment_id,user_id" });
  if (error) { sendError(res, "db_error", error.message); return; }
  await appendMomentAudit(ctx.sc, params.data.id, ctx.userId, "invited", { userId: parsed.data.userId });
  res.status(201).json({ ok: true }); recordMediaInviteIfAttributable(ctx.sc, { inviterId: ctx.userId, momentId: params.data.id, originMediaId: parsed.data.originMediaId ?? null }); void notifyMomentPerson(ctx.sc, { recipientId: parsed.data.userId, actorId: ctx.userId, momentId: params.data.id, eventType: "shared_moment.invited" }); // testing-mode WP-07: the invitee is told
}));

router.post("/shared-moments/:id/request", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params); if (!params.success) { sendError(res, "invalid_payload"); return; }
  const { row, error } = await getMoment(ctx.sc, params.data.id);
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!row || row.status !== "active") { sendError(res, "not_found"); return; }
  if (row.join_policy !== "approval_required") { sendError(res, "forbidden", "This Moment accepts invitations only"); return; }
  const blocked = await fetchBlockedSet(ctx.sc, ctx.userId);
  if (blocked === null || blocked.has(row.owner_id)) { sendError(res, "forbidden", "This request is unavailable"); return; }
  // supabase-js RESOLVES on a DB error, so an unbound `error` read an
  // unreadable shared_moment_memberships row as "not a member yet" and let the
  // upsert below run on an ALREADY-ACCEPTED member — demoting them to
  // status "requested" and revoking their own access to the Moment until an
  // owner re-approves them. The sibling /invites route already binds this
  // error; match it.
  const { data: existing, error: existingErr } = await ctx.sc.from("shared_moment_memberships").select("status").eq("moment_id", row.id).eq("user_id", ctx.userId).maybeSingle();
  if (existingErr) { sendError(res, "db_error", existingErr.message); return; }
  if ((existing as any)?.status === "accepted") { res.json({ ok: true, status: "accepted", idempotent: true }); return; }
  const { error: requestError } = await ctx.sc.from("shared_moment_memberships").upsert({
    moment_id: row.id, user_id: ctx.userId, role: "member", status: "requested", invited_by: null, responded_at: null, removed_at: null, updated_at: new Date().toISOString(),
  }, { onConflict: "moment_id,user_id" });
  if (requestError) { sendError(res, "db_error", requestError.message); return; }
  await appendMomentAudit(ctx.sc, row.id, ctx.userId, "join_requested");
  res.status(201).json({ ok: true, status: "requested" }); void notifyMomentPerson(ctx.sc, { recipientId: row.owner_id, actorId: ctx.userId, momentId: row.id, eventType: "shared_moment.join_requested" }); // testing-mode WP-07: the owner is told
}));

router.post("/shared-moments/:id/respond", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params), parsed = responseSchema.safeParse(req.body);
  if (!params.success || !parsed.success) { sendError(res, "invalid_payload"); return; }
  const { data: membership } = await ctx.sc.from("shared_moment_memberships").select("status").eq("moment_id", params.data.id).eq("user_id", ctx.userId).maybeSingle();
  if ((membership as any)?.status !== "invited") { sendError(res, "not_found", "No pending invitation"); return; }
  const status = parsed.data.response === "accept" ? "accepted" : "declined";
  // `.eq("status","invited")` is a compare-and-swap against a value read a
  // moment ago, and LOSING it is not an error — supabase-js resolves a zero-row
  // update as `{ data: null, error: null }`. If the invitation was revoked or
  // already answered in between, the old code still answered {ok:true, status}
  // and wrote an `invite_accepted` audit row for an acceptance that never
  // happened — i.e. the caller was told they had joined a Moment they are not a
  // member of. `.select().maybeSingle()` makes the transition observable; the
  // not_found is the same one the pre-check five lines up returns, and the
  // sibling owner-side handler below already answers exactly this way.
  const { data: responded, error } = await ctx.sc.from("shared_moment_memberships").update({ status, responded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("moment_id", params.data.id).eq("user_id", ctx.userId).eq("status", "invited").select("user_id").maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!responded) { sendError(res, "not_found", "No pending invitation"); return; }
  await appendMomentAudit(ctx.sc, params.data.id, ctx.userId, `invite_${status}`);
  res.json({ ok: true, status });
}));

router.post("/shared-moments/:id/requests/:userId/respond", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = z.object({ id: uuid, userId: uuid }).safeParse(req.params), parsed = responseSchema.safeParse(req.body);
  if (!params.success || !parsed.success || !(await ownerOrManager(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "forbidden"); return; }
  const status = parsed.data.response === "accept" ? "accepted" : "declined";
  const { data, error } = await ctx.sc.from("shared_moment_memberships").update({ status, responded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("moment_id", params.data.id).eq("user_id", params.data.userId).eq("status", "requested").select("user_id").maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "No pending join request"); return; }
  await appendMomentAudit(ctx.sc, params.data.id, ctx.userId, `join_request_${status}`, { userId: params.data.userId });
  res.json({ ok: true, status });
}));

router.post("/shared-moments/:id/leave", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params); if (!params.success) { sendError(res, "invalid_payload"); return; }
  const role = await momentRole(ctx.sc, params.data.id, ctx.userId);
  if (!role) { sendError(res, "not_member"); return; }
  if (role === "owner") { sendError(res, "invalid_payload", "Archive the Moment or transfer ownership before leaving"); return; }
  const { error } = await ctx.sc.from("shared_moment_memberships").update({ status: "left", removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("moment_id", params.data.id).eq("user_id", ctx.userId);
  if (error) { sendError(res, "db_error", error.message); return; }
  await appendMomentAudit(ctx.sc, params.data.id, ctx.userId, "left");
  res.json({ ok: true });
}));

router.patch("/shared-moments/:id", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params);
  const parsed = z.object({ title: z.string().trim().min(1).max(140).optional(), description: z.string().trim().max(1000).nullable().optional(), status: z.enum(["active", "archived"]).optional() }).refine((v) => Object.keys(v).length > 0).safeParse(req.body);
  if (!params.success || !parsed.success || !(await ownerOrManager(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "forbidden"); return; }
  const updates: {
    title?: string;
    description?: string | null;
    status?: "active" | "archived";
    archived_at?: string;
    updated_at: string;
  } = { updated_at: new Date().toISOString() };
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.status === "archived") updates.archived_at = new Date().toISOString();
  const { data, error } = await ctx.sc.from("shared_moments").update(updates).eq("id", params.data.id).select("*").maybeSingle();
  if (error || !data) { sendError(res, error ? "db_error" : "not_found", error?.message); return; }
  await appendMomentAudit(ctx.sc, params.data.id, ctx.userId, parsed.data.status === "archived" ? "archived" : "updated");
  res.json({ moment: mapMoment(data, await momentRole(ctx.sc, params.data.id, ctx.userId)) });
}));

router.post("/shared-moments/:id/contributions", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params), parsed = contributionSchema.safeParse(req.body);
  if (!params.success || !parsed.success || !(await momentRole(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "not_member"); return; }
  // A Moment only references a source the contributor already owns. It never
  // imports or reassigns a post/media record, preserving its original privacy.
  if (parsed.data.postId) {
    const { data: post } = await ctx.sc.from("posts").select("id").eq("id", parsed.data.postId).eq("author_id", ctx.userId).maybeSingle();
    if (!post) { sendError(res, "forbidden", "You can only contribute your own post"); return; }
  }
  if (parsed.data.mediaAssetId) {
    const { data: asset } = await ctx.sc.from("media_assets").select("id").eq("id", parsed.data.mediaAssetId).eq("owner_user_id", ctx.userId).maybeSingle();
    if (!asset) { sendError(res, "forbidden", "You can only contribute your own media"); return; }
  }
  const { data, error } = await ctx.sc.from("shared_moment_contributions").upsert({
    moment_id: params.data.id, contributor_id: ctx.userId, post_id: parsed.data.postId ?? null,
    media_asset_id: parsed.data.mediaAssetId ?? null, caption: parsed.data.caption ?? null, status: "pending",
  }, { onConflict: "moment_id,contributor_id,post_id,media_asset_id" }).select("*").maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  // Canonical dual-write (flag-gated OFF; fail-soft). The asset already exists
  // (verified above) and is FK'd on the contribution row; this adds the §6.1
  // media_attachments(entityType=shared_moment) link so the asset joins the
  // canonical "one asset, many entities" model once the flag is lit.
  if (parsed.data.mediaAssetId) {
    void recordMediaAttachment(ctx.sc, {
      mediaAssetId: parsed.data.mediaAssetId,
      entityType: "shared_moment",
      entityId: params.data.id,
    });
  }
  await appendMomentAudit(ctx.sc, params.data.id, ctx.userId, "contribution_submitted", { contributionId: (data as any)?.id });
  res.status(201).json({ contribution: data });
}));

router.post("/shared-moments/:id/contributions/:contributionId/approve", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = z.object({ id: uuid, contributionId: uuid }).safeParse(req.params);
  if (!params.success || !(await ownerOrManager(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "forbidden"); return; }
  const { data, error } = await ctx.sc.from("shared_moment_contributions")
    .update({ status: "approved", approved_by: ctx.userId, approved_at: new Date().toISOString() })
    .eq("id", params.data.contributionId).eq("moment_id", params.data.id).eq("status", "pending")
    .select("id").maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Contribution is not pending"); return; }
  await appendMomentAudit(ctx.sc, params.data.id, ctx.userId, "contribution_approved", { contributionId: params.data.contributionId });
  res.json({ ok: true });
}));

router.delete("/shared-moments/:id/contributions/:contributionId", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = z.object({ id: uuid, contributionId: uuid }).safeParse(req.params);
  if (!params.success || !(await ownerOrManager(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "forbidden"); return; }
  const { data, error } = await ctx.sc.from("shared_moment_contributions").update({
    status: "removed", removed_at: new Date().toISOString(),
  }).eq("id", params.data.contributionId).eq("moment_id", params.data.id).in("status", ["pending", "approved"]).select("id").maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Contribution is not available"); return; }
  await appendMomentAudit(ctx.sc, params.data.id, ctx.userId, "contribution_removed", { contributionId: params.data.contributionId });
  res.json({ ok: true });
}));

router.get("/shared-moments/:id/feed", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params);
  const query = z.object({ cursor: cursorSchema.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).safeParse(req.query);
  if (!params.success || !query.success) { sendError(res, "invalid_payload", "Invalid pagination"); return; }
  if (!(await momentRole(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "not_member"); return; }
  const blocked = await fetchBlockedSet(ctx.sc, ctx.userId);
  if (blocked === null) { res.json({ items: [], nextCursor: null }); return; }
  // The source query is intentionally paged separately from visibility filtering.
  // A blocked/private/unpublished row must not consume the only over-read slot,
  // otherwise an underfilled page can incorrectly terminate before older visible
  // contributions are reached.
  const chunkSize = query.data.limit + 1;
  let sourceCursor = query.data.cursor ?? null;
  let exhausted = false;
  const visibleRows: any[] = [];
  while (visibleRows.length <= query.data.limit && !exhausted) {
    let db = ctx.sc.from("shared_moment_contributions").select("id, contributor_id, post_id, media_asset_id, caption, created_at, posts(id, author_id, content, media_urls, media_thumbnail_url, visibility, status, post_status, publish_at, profiles(id, is_private))")
      .eq("moment_id", params.data.id).eq("status", "approved").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(chunkSize);
    if (sourceCursor) {
      db = db.or(`created_at.lt.${sourceCursor.createdAt},and(created_at.eq.${sourceCursor.createdAt},id.lt.${sourceCursor.id})`);
    }
    const { data, error } = await db;
    if (error) { sendError(res, "db_error", error.message); return; }
    const chunk = ((data ?? []) as any[]);
    if (chunk.length === 0) { exhausted = true; break; }
    const lastScanned = chunk.at(-1);
    sourceCursor = { createdAt: new Date(lastScanned.created_at).toISOString(), id: lastScanned.id };
    // Delayed-public posts (publish_at in the future) must stay hidden until
    // their scheduled time, even once the contribution itself is approved.
    const nowMs = Date.now();
    let rows = chunk.filter((x) => !blocked.has(x.contributor_id)).filter((x) => !x.posts || (
      x.posts.visibility === "public"
      && x.posts.status === "active"
      && (!x.posts.post_status || x.posts.post_status === "published")
      && (!x.posts.publish_at || new Date(x.posts.publish_at).getTime() <= nowMs)
    ));
    // Resolve contributor privacy independently of the optional post join.
    // Caption-only contributions have no nested post profile to inspect.
    rows = await excludePrivateAuthorPosts(rows, ctx.userId, ctx.sc, { authorKey: "contributor_id" });
    visibleRows.push(...rows);
    exhausted = chunk.length < chunkSize;
  }
  const page = visibleRows.slice(0, query.data.limit);
  const hasVisibleMore = visibleRows.length > query.data.limit;
  // If there is an over-read visible row, resume after the last emitted row so
  // that it remains available on the next page. If filtering consumed the
  // window, sourceCursor is the last scanned database boundary.
  const lastEmitted = page.at(-1);
  const next = hasVisibleMore && lastEmitted
    ? { createdAt: new Date(lastEmitted.created_at).toISOString(), id: lastEmitted.id }
    : (!exhausted ? sourceCursor : null);
  res.json({ items: page.map((x) => ({ id: x.id, contributorId: x.contributor_id, caption: x.caption ?? x.posts?.content ?? null, postId: x.post_id ?? null, mediaAssetId: x.media_asset_id ?? null, mediaUrl: x.posts?.media_urls?.[0] ?? null, thumbnailUrl: x.posts?.media_thumbnail_url ?? null, createdAt: x.created_at })), nextCursor: next ? `${next.createdAt}|${next.id}` : null });
}));


// ════════════════════════════════════════════════════════════════════════════
// Testing-mode WP-07 (flows HM-F17, HM-F18): the READS participation needs.
//
// Every write above existed and had a client function, and no person could
// reach any of them: an invited person could not open the Moment (the detail
// read is members-only), the owner had no queue of requests or pending
// contributions to act on, a member had no list of their own sources, and an
// invitation told nobody. Appended here so no line above moves.
//
// Rules held on every read below:
//   - a block hides a Moment and a person in BOTH directions, and an unreadable
//     `blocks` fails CLOSED (503), never open;
//   - a failed read is a 503 / db_error, never an empty list (DV-83);
//   - a contribution's post is disclosed as media only on the same predicate
//     the approved feed uses (public, active, published, not scheduled, author
//     not private) — the owner reviewing a submission is not a wider audience
//     than the one the feed would give them.
// ════════════════════════════════════════════════════════════════════════════

const NOTIFY_COPY: Record<"shared_moment.invited" | "shared_moment.join_requested", { title: string; body: string }> = {
  "shared_moment.invited": { title: "You were invited to a Shared Moment", body: "Open it to accept or decline." },
  "shared_moment.join_requested": { title: "Someone asked to join your Shared Moment", body: "Open it to review the request." },
};

/**
 * Fire-and-forget in-app notification, through NotificationService so the
 * privacy guard (sender/recipient blocks), the dedupe ledger and the delivery
 * trail all apply. A failure is logged, never thrown.
 */
async function notifyMomentPerson(sc: any, input: {
  recipientId: string; actorId: string; momentId: string; eventType: keyof typeof NOTIFY_COPY;
}): Promise<void> {
  try {
    const copy = NOTIFY_COPY[input.eventType];
    const created = await new NotificationService(sc).create({
      userId: input.recipientId, actorId: input.actorId, senderId: input.actorId, eventType: input.eventType,
      category: "plans", title: copy.title, body: copy.body, actionUrl: `/shared-moments/${input.momentId}`,
      sourceType: "shared_moment", sourceId: input.momentId, metadata: { momentId: input.momentId },
    });
    if (!created) logger.info({ momentId: input.momentId, eventType: input.eventType }, "shared moments: notification not created (deduped, blocked or failed)");
  } catch (err) {
    logger.warn({ err, momentId: input.momentId }, "shared moments: notification threw");
  }
}

/** Public-feed predicate for a contribution's post — the same one GET /feed applies. */
function postIsFeedVisible(post: any, nowMs: number): boolean {
  return Boolean(post) && post.visibility === "public" && post.status === "active"
    && (!post.post_status || post.post_status === "published")
    && (!post.publish_at || new Date(post.publish_at).getTime() <= nowMs);
}

function previewOf(row: any) {
  return {
    id: row.id, title: row.title, description: row.description ?? null, placeId: row.place_id ?? null,
    placeDayId: row.place_day_id ?? null, tripId: row.trip_id ?? null, joinPolicy: row.join_policy, status: row.status,
  };
}

// GET /shared-moments/:id/preview — what a NON-member may see so they can act.
// Open to: an invitee, a requester, a member, the holder of an offered
// suggestion, and — for an ACTIVE approval-required Moment — anyone not
// blocked (that is what "ask to join" means). Everyone else: not_found, the
// same answer a Moment that does not exist gets.
router.get("/shared-moments/:id/preview", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params); if (!params.success) { sendError(res, "invalid_payload"); return; }
  const { row, error } = await getMoment(ctx.sc, params.data.id);
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!row) { sendError(res, "not_found"); return; }
  const blocked = await fetchBlockedSet(ctx.sc, ctx.userId);
  if (blocked === null) { sendError(res, "degraded_unavailable", "This Moment could not be checked right now. Please try again."); return; }
  if (blocked.has(row.owner_id)) { sendError(res, "not_found"); return; }
  const { data: membership, error: membershipError } = await ctx.sc.from("shared_moment_memberships")
    .select("status, role").eq("moment_id", row.id).eq("user_id", ctx.userId).maybeSingle();
  if (membershipError) { sendError(res, "db_error", membershipError.message); return; }
  const myStatus: string | null = (membership as any)?.status ?? null;
  let open = myStatus === "invited" || myStatus === "requested" || myStatus === "accepted"
    || (row.status === "active" && row.join_policy === "approval_required");
  if (!open) {
    const { data: suggestion, error: suggestionError } = await ctx.sc.from("shared_moment_suggestions")
      .select("id").eq("moment_id", row.id).eq("recipient_id", ctx.userId).eq("status", "offered").limit(1);
    if (suggestionError) { sendError(res, "db_error", suggestionError.message); return; }
    open = ((suggestion ?? []) as any[]).length > 0;
  }
  if (!open) { sendError(res, "not_found"); return; }
  res.json({ moment: previewOf(row), myStatus, myRole: myStatus === "accepted" ? (membership as any)?.role ?? null : null });
}));

// GET /me/shared-moment-invites — the caller's pending invitations.
router.get("/me/shared-moment-invites", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const { data, error } = await ctx.sc.from("shared_moment_memberships")
    .select("moment_id, invited_by, updated_at").eq("user_id", ctx.userId).eq("status", "invited")
    .order("updated_at", { ascending: false });
  if (error) { sendError(res, "degraded_unavailable", "We could not load your invitations. Please try again."); return; }
  const blocked = await fetchBlockedSet(ctx.sc, ctx.userId);
  if (blocked === null) { sendError(res, "degraded_unavailable", "We could not load your invitations. Please try again."); return; }
  const pending = (data ?? []) as any[];
  const moments = new Map<string, any>();
  const ids = [...new Set(pending.map((r) => r.moment_id as string))];
  if (ids.length > 0) {
    const { data: rows, error: momentsError } = await ctx.sc.from("shared_moments").select("*").in("id", ids);
    if (momentsError) { sendError(res, "degraded_unavailable", "We could not load your invitations. Please try again."); return; }
    for (const m of (rows ?? []) as any[]) moments.set(m.id, m);
  }
  const invites = pending
    .map((r) => ({ r, m: moments.get(r.moment_id) }))
    .filter(({ r, m }) => m && m.status === "active" && !blocked.has(m.owner_id) && !(r.invited_by && blocked.has(r.invited_by)))
    .map(({ r, m }) => ({ moment: previewOf(m), invitedBy: r.invited_by ?? null, invitedAt: r.updated_at ?? null }));
  res.json({ invites });
}));

// GET /shared-moments/:id/requests — owner/manager: pending join requests.
router.get("/shared-moments/:id/requests", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params); if (!params.success) { sendError(res, "invalid_payload"); return; }
  if (!(await ownerOrManager(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "forbidden"); return; }
  const { data, error } = await ctx.sc.from("shared_moment_memberships")
    .select("user_id, updated_at").eq("moment_id", params.data.id).eq("status", "requested").order("updated_at", { ascending: true });
  if (error) { sendError(res, "db_error", error.message); return; }
  const blocked = await fetchBlockedSet(ctx.sc, ctx.userId);
  if (blocked === null) { sendError(res, "degraded_unavailable", "Join requests could not be checked right now. Please try again."); return; }
  const pending = ((data ?? []) as any[]).filter((r) => !blocked.has(r.user_id));
  const ids = pending.map((r) => r.user_id as string);
  const profiles = new Map<string, any>();
  if (ids.length > 0) {
    const { data: profs, error: profError } = await ctx.sc.from("profiles").select("id, handle, name, avatar_url").in("id", ids);
    if (profError) { sendError(res, "degraded_unavailable", "Join requests could not be loaded right now. Please try again."); return; }
    for (const p of (profs ?? []) as any[]) profiles.set(p.id, p);
  }
  const named = await nameVisibilitySet(ctx.sc, ids);
  res.json({ requests: pending.map((r) => {
    const p = profiles.get(r.user_id);
    return { userId: r.user_id, handle: p?.handle ?? null, name: named.has(r.user_id) ? p?.name ?? null : null, avatarUrl: p?.avatar_url ?? null, requestedAt: r.updated_at ?? null };
  }) });
}));

// GET /shared-moments/:id/contributions — PENDING review. Owner/manager: all;
// a member: only their own ("awaiting approval").
router.get("/shared-moments/:id/contributions", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params); if (!params.success) { sendError(res, "invalid_payload"); return; }
  const role = await momentRole(ctx.sc, params.data.id, ctx.userId);
  if (!role) { sendError(res, "forbidden"); return; }
  const manager = role === "owner" || role === "manager";
  let db = ctx.sc.from("shared_moment_contributions")
    .select("id, contributor_id, post_id, media_asset_id, caption, created_at")
    .eq("moment_id", params.data.id).eq("status", "pending").order("created_at", { ascending: true });
  if (!manager) db = db.eq("contributor_id", ctx.userId);
  const { data, error } = await db;
  if (error) { sendError(res, "db_error", error.message); return; }
  const blocked = await fetchBlockedSet(ctx.sc, ctx.userId);
  if (blocked === null) { sendError(res, "degraded_unavailable", "Contributions could not be checked right now. Please try again."); return; }
  const rows = ((data ?? []) as any[]).filter((r) => !blocked.has(r.contributor_id));
  const postIds = [...new Set(rows.map((r) => r.post_id).filter(Boolean))] as string[];
  const posts = new Map<string, any>();
  if (postIds.length > 0) {
    const { data: postRows, error: postError } = await ctx.sc.from("posts")
      .select("id, author_id, content, media_urls, media_thumbnail_url, visibility, status, post_status, publish_at").in("id", postIds);
    if (postError) { sendError(res, "db_error", postError.message); return; }
    for (const p of (postRows ?? []) as any[]) posts.set(p.id, p);
  }
  const nowMs = Date.now();
  // A contribution's post is shown only when it passes the feed predicate AND
  // its author is not private (the viewer's own always pass).
  const candidates = rows.filter((r) => r.post_id && posts.has(r.post_id)
    && (r.contributor_id === ctx.userId || postIsFeedVisible(posts.get(r.post_id), nowMs)));
  const disclosable = new Set((await excludePrivateAuthorPosts(candidates, ctx.userId, ctx.sc, { authorKey: "contributor_id" })).map((r) => r.id));
  res.json({ contributions: rows.map((r) => {
    const post = disclosable.has(r.id) ? posts.get(r.post_id) : null;
    return {
      id: r.id, contributorId: r.contributor_id, postId: r.post_id ?? null, mediaAssetId: r.media_asset_id ?? null,
      caption: r.caption ?? post?.content ?? null,
      mediaUrl: post?.media_urls?.[0] ?? null, thumbnailUrl: post?.media_thumbnail_url ?? null,
      createdAt: r.created_at, mine: r.contributor_id === ctx.userId,
    };
  }) });
}));

// GET /shared-moments/:id/contributable-posts — the caller's OWN posts that
// could be contributed: at the Moment's place, or on its trip, newest first.
router.get("/shared-moments/:id/contributable-posts", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params); if (!params.success) { sendError(res, "invalid_payload"); return; }
  if (!(await momentRole(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "forbidden"); return; }
  const { row, error } = await getMoment(ctx.sc, params.data.id);
  if (error || !row) { sendError(res, error ? "db_error" : "not_found", error?.message); return; }
  let db = ctx.sc.from("posts").select("id, content, media_urls, media_thumbnail_url, created_at")
    .eq("author_id", ctx.userId).eq("status", "active").order("created_at", { ascending: false }).limit(30);
  if (row.place_id) db = db.eq("canonical_place_id", row.place_id);
  else if (row.trip_id) db = db.eq("trip_id", row.trip_id);
  const { data: posts, error: postsError } = await db;
  if (postsError) { sendError(res, "db_error", postsError.message); return; }
  const { data: mine, error: mineError } = await ctx.sc.from("shared_moment_contributions")
    .select("post_id, status").eq("moment_id", row.id).eq("contributor_id", ctx.userId);
  if (mineError) { sendError(res, "db_error", mineError.message); return; }
  const contributed = new Set(((mine ?? []) as any[]).filter((c) => c.status !== "removed").map((c) => c.post_id));
  res.json({ posts: ((posts ?? []) as any[]).map((p) => ({
    id: p.id, caption: p.content ?? null, mediaUrl: p.media_urls?.[0] ?? null, thumbnailUrl: p.media_thumbnail_url ?? null,
    createdAt: p.created_at, contributed: contributed.has(p.id),
  })) });
}));

// POST /shared-moments/suggestions/:id/dismiss — the recipient only.
router.post("/shared-moments/suggestions/:id/dismiss", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  const params = idParams.safeParse(req.params); if (!params.success) { sendError(res, "invalid_payload"); return; }
  const { data, error } = await ctx.sc.from("shared_moment_suggestions")
    .update({ status: "dismissed", responded_at: new Date().toISOString() })
    .eq("id", params.data.id).eq("recipient_id", ctx.userId).eq("status", "offered").select("id").maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Suggestion is not available"); return; }
  res.json({ ok: true });
}));

// Imported at the TAIL so no line above moves; ESM hoists them.
import { logger } from "../lib/logger.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { NotificationService } from "../services/notifications/NotificationService.js";

export default router;
