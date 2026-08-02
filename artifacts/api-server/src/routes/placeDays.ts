import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { excludePrivateAuthorPosts } from "../lib/privacyFilter.js";
import {
  arePlaceDaysEnabled,
  isEligiblePlaceDayPost,
  isValidLocalDate,
  localDateFor,
  resolvePlaceTimezone,
  utcRangeForLocalDate,
} from "../lib/places/placeDays.js";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateSchema = z.string().refine(isValidLocalDate, "date must be a real YYYY-MM-DD calendar date");
const cursorSchema = z.string().transform((value, ctx) => {
  const separator = value.lastIndexOf("|");
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (separator <= 0 || !Number.isFinite(Date.parse(createdAt)) || !UUID.test(id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid cursor" });
    return z.NEVER;
  }
  return { createdAt: new Date(createdAt).toISOString(), id };
});

async function canonicalPlace(sc: any, id: string): Promise<any | null> {
  const { data } = await sc.from("places")
    .select("id, name, city, latitude, longitude, merged_into_place_id").eq("id", id).maybeSingle();
  if (!data) return null;
  if (!(data as any).merged_into_place_id) return data;
  const { data: survivor } = await sc.from("places")
    .select("id, name, city, latitude, longitude").eq("id", (data as any).merged_into_place_id).maybeSingle();
  return survivor ?? null;
}

async function guard(req: any, res: any) {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return null; }
  if (!(await arePlaceDaysEnabled(sc))) { sendError(res, "feature_disabled"); return null; }
  return { sc, userId: auth.user.id };
}

// GET /api/places/:id/place-days?date=YYYY-MM-DD. Missing date means place-local today.
router.get("/places/:id/place-days", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  if (!UUID.test(req.params.id)) { sendError(res, "invalid_payload", "Invalid place id"); return; }
  const place = await canonicalPlace(ctx.sc, req.params.id);
  if (!place) { sendError(res, "not_found", "Place not found"); return; }
  const requested = req.query.date;
  if (requested !== undefined && !dateSchema.safeParse(requested).success) {
    sendError(res, "invalid_payload", "date must be YYYY-MM-DD"); return;
  }
  const timezone = resolvePlaceTimezone(place);
  const localDate = typeof requested === "string" ? requested : localDateFor(new Date(), timezone);
  let { data: day, error } = await ctx.sc.from("place_days").select("*")
    .eq("place_id", place.id).eq("local_date", localDate).maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  const [{ data: previous }, { data: next }] = await Promise.all([
    ctx.sc.from("place_days").select("local_date").eq("place_id", place.id).lt("local_date", localDate)
      .order("local_date", { ascending: false }).limit(1).maybeSingle(),
    ctx.sc.from("place_days").select("local_date").eq("place_id", place.id).gt("local_date", localDate)
      .order("local_date", { ascending: true }).limit(1).maybeSingle(),
  ]);
  res.json({
    day: day ? {
      id: (day as any).id, placeId: place.id, placeName: place.name, localDate: (day as any).local_date,
      timezone: (day as any).timezone, status: (day as any).status, openedAt: (day as any).opened_at,
      closingAt: (day as any).closing_at ?? null, archivedAt: (day as any).archived_at ?? null,
    } : null,
    navigation: { previousDate: (previous as any)?.local_date ?? null, nextDate: (next as any)?.local_date ?? null },
  });
}));

// GET /api/places/:id/place-days/:date/feed?cursor=<created_at>|<id>&limit=20
router.get("/places/:id/place-days/:date/feed", asyncHandler(async (req, res) => {
  const ctx = await guard(req, res); if (!ctx) return;
  if (!UUID.test(req.params.id) || !dateSchema.safeParse(req.params.date).success) {
    sendError(res, "invalid_payload", "Invalid place id or date"); return;
  }
  const parsed = z.object({ cursor: cursorSchema.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })
    .safeParse(req.query);
  if (!parsed.success) { sendError(res, "invalid_payload", "Invalid pagination"); return; }
  const place = await canonicalPlace(ctx.sc, req.params.id);
  if (!place) { sendError(res, "not_found", "Place not found"); return; }
  const timezone = resolvePlaceTimezone(place);
  const blocked = await fetchBlockedSet(ctx.sc, ctx.userId);
  if (blocked === null) { res.json({ placeId: place.id, localDate: req.params.date, items: [], nextCursor: null }); return; }
  const { start, end } = utcRangeForLocalDate(req.params.date, timezone);
  const chunkSize = 100;
  const candidates: any[] = [];
  let rawCursor = parsed.data.cursor ?? null;
  let exhausted = false;
  while (candidates.length <= parsed.data.limit && !exhausted) {
    let query = ctx.sc.from("posts")
      .select("id, author_id, content, media_urls, media_thumbnail_url, media_type, created_at, visibility, status, post_status, publish_at, profiles(id, is_private)")
      .eq("canonical_place_id", place.id).eq("status", "active")
      .gte("created_at", start).lt("created_at", end)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(chunkSize);
    if (rawCursor) {
      query = query.or(`created_at.lt.${rawCursor.createdAt},and(created_at.eq.${rawCursor.createdAt},id.lt.${rawCursor.id})`);
    }
    const { data: raw, error } = await query;
    if (error) { sendError(res, "db_error", error.message); return; }
    const chunk = (raw as any[]) ?? [];
    if (chunk.length === 0) { exhausted = true; break; }
    rawCursor = { createdAt: new Date(chunk[chunk.length - 1].created_at).toISOString(), id: chunk[chunk.length - 1].id };
    let visible = chunk.filter((p) => !blocked.has(p.author_id) && isEligiblePlaceDayPost(p));
    visible = await excludePrivateAuthorPosts(visible, ctx.userId, ctx.sc, { profilesKey: "profiles" });
    candidates.push(...visible);
    exhausted = chunk.length < chunkSize;
  }
  const hasMore = candidates.length > parsed.data.limit;
  const page = candidates.slice(0, parsed.data.limit);
  const last = page[page.length - 1];
  res.json({
    placeId: place.id, localDate: req.params.date,
    items: page.map((p) => ({ id: p.id, authorId: p.author_id, caption: p.content ?? null,
      mediaUrl: Array.isArray(p.media_urls) ? p.media_urls[0] ?? null : null,
      thumbnailUrl: p.media_thumbnail_url ?? null, mediaType: p.media_type ?? null, createdAt: p.created_at })),
    // Resume after the last emitted source row; the over-read row can be
    // evaluated again but no eligible activity is ever skipped.
    nextCursor: hasMore && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null,
  });
}));

export default router;