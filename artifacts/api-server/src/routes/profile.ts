import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { retranslateForUser } from "../services/messageTranslation";
import { isFlagEnabled } from "../lib/featureFlags";

const router = Router();

const AVATAR_BUCKET = "profile-media";
const ALLOWED_AVATAR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB

/** Creates the storage bucket if it doesn't already exist (service-role required). */
async function ensureStorageBucket(sc: ReturnType<typeof getServiceClient>, bucket: string, req: import("express").Request): Promise<void> {
  if (!sc) return;
  const { error } = await sc.storage.createBucket(bucket, { public: true });
  if (error && !error.message.includes("already exists")) {
    req.log.warn({ err: error, bucket }, "Could not ensure storage bucket");
  }
}

const SUPPORTED_LANGUAGE_CODES = new Set([
  'en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'zh-TW',
  'pt', 'it', 'ru', 'ar', 'th', 'vi', 'id', 'tl',
  'sv', 'nl', 'pl', 'tr', 'hi',
]);

const RESERVED_USERNAMES = new Set([
  "admin", "support", "travelbuddy", "official", "root", "system",
  "null", "undefined", "help", "security", "moderator", "owner",
  "passport", "api", "settings", "login", "signup", "me", "user",
  "users", "about", "terms", "privacy",
]);

/** No periods: keeps usernames clean; max 30 chars (was 24). */
const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

function validateUsername(u: string): { valid: boolean; reason?: string } {
  if (!USERNAME_RE.test(u)) {
    return { valid: false, reason: "Username must be 3-30 chars, lowercase letters, numbers, and underscores only" };
  }
  if (RESERVED_USERNAMES.has(u)) {
    return { valid: false, reason: "That username is reserved" };
  }
  return { valid: true };
}

const PROFILE_COLUMNS =
  "id, handle, name, display_name, username, bio, avatar_url, home_city, home_country, current_city, travel_style, interests, verified, verification_status, verified_at, open_to_meet, is_private, passport_visibility, cover_photo_url, username_updated_at, created_at, spoken_languages, default_language, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, availability_tags, planning_style, public_social_links, preferred_language, date_of_birth, dob_verified";

/** Fallback: select everything that exists; mapProfile handles every field with ?? null. */
const PROFILE_COLUMNS_FALLBACK = "*";

/** Compute profile completeness score (0–100) from profile row + stamp/trip presence. */
function computeCompleteness(profile: any, hasStamp: boolean, hasTrip: boolean): { score: number; missing: string[] } {
  const checks: Array<{ key: string; ok: boolean }> = [
    { key: "avatar",      ok: !!profile.avatar_url },
    { key: "displayName", ok: !!(profile.display_name || profile.name) },
    { key: "bio",         ok: !!(profile.bio && (profile.bio as string).trim().length > 0) },
    { key: "homeCountry", ok: !!profile.home_country },
    { key: "languages",   ok: Array.isArray(profile.spoken_languages) && (profile.spoken_languages as unknown[]).length > 0 },
    { key: "interests",   ok: Array.isArray(profile.interests) && (profile.interests as unknown[]).length > 0 },
    { key: "stamp",       ok: hasStamp },
    { key: "trip",        ok: hasTrip },
    { key: "verified",    ok: profile.verified === true },
  ];
  const missing = checks.filter((c) => !c.ok).map((c) => c.key);
  const score   = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  return { score, missing };
}

function mapProfile(r: any) {
  return {
    id: r.id,
    handle: r.handle ?? null,
    name: r.name ?? null,
    displayName: r.display_name ?? r.name ?? null,
    username: r.username ?? null,
    bio: r.bio ?? null,
    avatarUrl: r.avatar_url ?? null,
    homeCity: r.home_city ?? null,
    homeCountry: r.home_country ?? null,
    currentCity: r.current_city ?? null,
    travelStyle: r.travel_style ?? null,
    interests: r.interests ?? [],
    verified: r.verified ?? false,
    verificationStatus: r.verification_status ?? 'unverified',
    verifiedAt: r.verified_at ?? null,
    openToMeet: r.open_to_meet ?? false,
    isPrivate: r.is_private ?? false,
    passportVisibility: r.passport_visibility ?? "public",
    coverPhotoUrl: r.cover_photo_url ?? null,
    usernameUpdatedAt: r.username_updated_at ?? null,
    createdAt: r.created_at ?? null,
    spokenLanguages: r.spoken_languages ?? [],
    defaultLanguage: r.default_language ?? null,
    travelStyles: r.travel_styles ?? [],
    travelPace: r.travel_pace ?? null,
    budgetStyle: r.budget_style ?? null,
    travelGroupStyle: r.travel_group_style ?? [],
    lookingFor: r.looking_for ?? [],
    comfortLevel: r.comfort_level ?? null,
    availabilityTags: r.availability_tags ?? [],
    planningStyle: r.planning_style ?? null,
    publicSocialLinks: r.public_social_links ?? {},
    preferredLanguage: r.preferred_language ?? null,
    dateOfBirth: r.date_of_birth ?? null,
    dobVerified: r.dob_verified ?? false,
  };
}

/* ===========================================================================
 * GET /me/profile/analytics — private owner analytics (7d / 30d views, follower growth)
 * ===========================================================================
 * Only the profile owner can call this. Never exposes viewer identity.
 */
router.get("/me/profile/analytics", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const now = Date.now();
  const d7  = new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString();
  const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [views7Res, views30Res, followers7Res, followers30Res] = await Promise.allSettled([
    sc.from("profile_views")
      .select("id", { count: "exact", head: true })
      .eq("target_id", user.id)
      .neq("viewer_id", user.id)
      .gte("viewed_at", d7),
    sc.from("profile_views")
      .select("id", { count: "exact", head: true })
      .eq("target_id", user.id)
      .neq("viewer_id", user.id)
      .gte("viewed_at", d30),
    sc.from("user_follows")
      .select("id", { count: "exact", head: true })
      .eq("following_id", user.id)
      .gte("created_at", d7),
    sc.from("user_follows")
      .select("id", { count: "exact", head: true })
      .eq("following_id", user.id)
      .gte("created_at", d30),
  ]);

  // post_impressions_7d: count of impression events logged in post_impressions table.
  // Fails open — returns 0 if the table doesn't exist yet (pre-migration 0070 environments).
  const postImpressionsRes = await sc
    .from("post_impressions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("viewed_at", d7)
    .then(
      (r: any) => (r.count as number | null) ?? 0,
      () => 0,
    );

  const profileViews7d   = views7Res.status    === "fulfilled" ? (views7Res.value.count    ?? 0) : 0;
  const profileViews30d  = views30Res.status   === "fulfilled" ? (views30Res.value.count   ?? 0) : 0;
  const followerDelta7d  = followers7Res.status === "fulfilled" ? (followers7Res.value.count ?? 0) : 0;
  const followerDelta30d = followers30Res.status === "fulfilled" ? (followers30Res.value.count ?? 0) : 0;

  res.status(200).json({
    profileViews: { sevenDay: profileViews7d, thirtyDay: profileViews30d },
    followerGrowth: { sevenDay: followerDelta7d, thirtyDay: followerDelta30d },
    postImpressions7d: postImpressionsRes,
  });
});

/* ===========================================================================
 * GET /me/profile — full own profile (with completeness score)
 * ===========================================================================
 */
router.get("/me/profile", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();

  let { data, error } = await client
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", user.id)
    .maybeSingle();

  if (error && (error as any).code === "42703") {
    ({ data, error } = await client
      .from("profiles")
      .select(PROFILE_COLUMNS_FALLBACK)
      .eq("id", user.id)
      .maybeSingle());
  }

  if (error) {
    req.log.error({ err: error }, "Failed to load own profile");
    sendError(res, "db_error", error.message);
    return;
  }
  if (!data) {
    sendError(res, "not_found", "Profile not found");
    return;
  }

  // Completeness score: parallel stamp + trip existence checks (fail-open)
  const [stampRes, tripRes] = await Promise.allSettled([
    sc ? sc.from("stamps").select("id", { count: "exact", head: true }).eq("user_id", user.id).limit(1) : Promise.resolve({ count: 0 }),
    sc ? sc.from("trips").select("id", { count: "exact", head: true }).eq("owner_id", user.id).limit(1) : Promise.resolve({ count: 0 }),
  ]);
  const hasStamp = stampRes.status === "fulfilled" && ((stampRes.value as any).count ?? 0) > 0;
  const hasTrip  = tripRes.status  === "fulfilled" && ((tripRes.value  as any).count ?? 0) > 0;

  const completeness = computeCompleteness(data, hasStamp, hasTrip);

  res.status(200).json({ ...mapProfile(data), completeness });
});

/* ===========================================================================
 * PATCH /me/profile — update own profile
 * ===========================================================================
 * User identity always from auth token — never from body.
 */
const patchProfileSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  username: z.string().optional(),
  bio: z.string().max(300).optional(),
  homeCity: z.string().max(100).optional(),
  homeCountry: z.string().max(100).optional(),
  currentCity: z.string().max(100).optional(),
  interests: z.array(z.string().max(50)).max(20).optional(),
  passportVisibility: z.enum(["public", "followers_only", "private"]).optional(),
  avatarUrl: z.string().url().optional(),
  coverUrl: z.string().url().optional(),
  travelStyle: z.string().max(50).optional(),
  openToMeet: z.boolean().optional(),
  spokenLanguages: z.array(z.string().max(50)).max(20).optional(),
  defaultLanguage: z.string().max(50).nullish(),
  travelStyles: z.array(z.string().max(50)).max(10).optional(),
  travelPace: z.enum(["slow", "balanced", "packed"]).nullish(),
  budgetStyle: z.enum(["budget", "mid-range", "luxury", "flexible"]).nullish(),
  travelGroupStyle: z.array(z.string().max(50)).max(5).optional(),
  lookingFor: z.array(z.string().max(50)).max(10).optional(),
  comfortLevel: z.string().max(50).nullish(),
  availabilityTags: z.array(z.string().max(50)).max(4).optional(),
  planningStyle: z.string().max(50).nullish(),
  publicSocialLinks: z.record(z.string().max(300)).optional(),
  preferredLanguage: z.string().max(20).nullish(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be YYYY-MM-DD").nullable().optional(),
  tagPermission: z.enum(['anyone', 'interacted', 'friends_only', 'nobody']).optional(),
});

router.patch("/me/profile", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = patchProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const p = parsed.data;

  const row: Record<string, unknown> = { updated_by: user.id };

  if (p.displayName !== undefined) row.name = p.displayName;
  if (p.bio !== undefined) row.bio = p.bio;
  if (p.homeCity !== undefined) row.home_city = p.homeCity;
  if (p.homeCountry !== undefined) row.home_country = p.homeCountry;
  if (p.currentCity !== undefined) row.current_city = p.currentCity;
  if (p.interests !== undefined) row.interests = p.interests;
  if (p.passportVisibility !== undefined) row.passport_visibility = p.passportVisibility;
  if (p.avatarUrl !== undefined) row.avatar_url = p.avatarUrl;
  if (p.travelStyle !== undefined) row.travel_style = p.travelStyle;
  if (p.openToMeet !== undefined) row.open_to_meet = p.openToMeet;
  if (p.spokenLanguages !== undefined) row.spoken_languages = p.spokenLanguages;
  if (p.defaultLanguage !== undefined) row.default_language = p.defaultLanguage;
  if (p.travelStyles !== undefined) row.travel_styles = p.travelStyles;
  if (p.travelPace !== undefined) row.travel_pace = p.travelPace;
  if (p.budgetStyle !== undefined) row.budget_style = p.budgetStyle;
  if (p.travelGroupStyle !== undefined) row.travel_group_style = p.travelGroupStyle;
  if (p.lookingFor !== undefined) row.looking_for = p.lookingFor;
  if (p.comfortLevel !== undefined) row.comfort_level = p.comfortLevel;
  if (p.availabilityTags !== undefined) row.availability_tags = p.availabilityTags;
  if (p.planningStyle !== undefined) row.planning_style = p.planningStyle;
  if (p.publicSocialLinks !== undefined) row.public_social_links = p.publicSocialLinks;
  if (p.coverUrl !== undefined) row.cover_photo_url = p.coverUrl;
  if (p.preferredLanguage !== undefined) {
    if (p.preferredLanguage !== null && !SUPPORTED_LANGUAGE_CODES.has(p.preferredLanguage)) {
      sendError(res, "invalid_payload", `Unsupported language code: "${p.preferredLanguage}". Supported: ${[...SUPPORTED_LANGUAGE_CODES].join(", ")}`);
      return;
    }
    row.preferred_language = p.preferredLanguage ?? null;
  }
  if (p.dateOfBirth !== undefined) {
    if (p.dateOfBirth !== null) {
      const dob = new Date(p.dateOfBirth);
      if (isNaN(dob.getTime())) {
        sendError(res, "invalid_payload", "Invalid dateOfBirth");
        return;
      }
      const now = new Date();
      if (dob >= now) {
        sendError(res, "invalid_payload", "dateOfBirth must be in the past");
        return;
      }
      const ageYears = now.getFullYear() - dob.getFullYear() - (
        now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate()) ? 1 : 0
      );
      if (ageYears < 13) {
        sendError(res, "invalid_payload", "You must be at least 13 years old");
        return;
      }
    }
    row.date_of_birth = p.dateOfBirth;
  }

  if (p.tagPermission !== undefined) row.tag_permission = p.tagPermission;

  if (p.username !== undefined) {
    const v = validateUsername(p.username);
    if (!v.valid) {
      sendError(res, "invalid_payload", v.reason ?? "Invalid username");
      return;
    }

    // 30-day cooldown: enforce via username_updated_at
    const { data: currentProfile } = await client
      .from("profiles")
      .select("username, username_updated_at")
      .eq("id", user.id)
      .maybeSingle();

    if (currentProfile?.username_updated_at && currentProfile.username !== p.username) {
      const lastChanged = new Date(currentProfile.username_updated_at);
      const msSince = Date.now() - lastChanged.getTime();
      const daysSince = msSince / (1000 * 60 * 60 * 24);
      if (daysSince < 30) {
        const daysLeft = Math.ceil(30 - daysSince);
        sendError(res, "invalid_payload", `Username can only be changed once every 30 days. ${daysLeft} day${daysLeft !== 1 ? "s" : ""} remaining.`);
        return;
      }
    }

    const { data: takenBy } = await client
      .from("profiles")
      .select("id")
      .eq("username", p.username)
      .neq("id", user.id)
      .maybeSingle();
    if (takenBy) {
      sendError(res, "invalid_payload", "Username is already taken");
      return;
    }
    row.username = p.username;
    row.username_updated_at = new Date().toISOString();
  }

  if (Object.keys(row).length <= 1) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  let { data: updated, error: updateError } = await client
    .from("profiles")
    .update(row)
    .eq("id", user.id)
    .select(PROFILE_COLUMNS)
    .single();

  if (updateError && (updateError as any).code === "42703") {
    const safeRow = { ...row };
    delete safeRow.display_name;
    delete safeRow.spoken_languages;
    delete safeRow.default_language;
    delete safeRow.travel_styles;
    delete safeRow.travel_pace;
    delete safeRow.budget_style;
    delete safeRow.travel_group_style;
    delete safeRow.looking_for;
    delete safeRow.comfort_level;
    delete safeRow.availability_tags;
    delete safeRow.planning_style;
    delete safeRow.public_social_links;
    ({ data: updated, error: updateError } = await client
      .from("profiles")
      .update(safeRow)
      .eq("id", user.id)
      .select(PROFILE_COLUMNS_FALLBACK)
      .single());
  }

  if (updateError) {
    req.log.error({ err: updateError }, "Failed to update profile");
    sendError(res, "db_error", updateError.message);
    return;
  }

  // Fire-and-forget re-translation sweep when preferred_language changes.
  if (p.preferredLanguage !== undefined && p.preferredLanguage !== null) {
    const sc = getServiceClient();
    if (sc) {
      retranslateForUser(sc, user.id, p.preferredLanguage, req.log).catch(() => {});
    }
  }

  res.status(200).json(mapProfile(updated));
});

/* ===========================================================================
 * GET /users/check-username — check username availability
 * ===========================================================================
 */
router.get("/users/check-username", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const username = String(req.query.username ?? "").toLowerCase().trim();
  if (!username) {
    res.status(200).json({ available: false, reason: "Username is required" });
    return;
  }

  const v = validateUsername(username);
  if (!v.valid) {
    res.status(200).json({ available: false, reason: v.reason });
    return;
  }

  const { data } = await sc
    .from("profiles")
    .select("id")
    .eq("username", username)
    .neq("id", user.id)
    .maybeSingle();

  if (data) {
    res.status(200).json({ available: false, reason: "Username is already taken" });
    return;
  }
  res.status(200).json({ available: true });
});

/* ===========================================================================
 * POST /me/avatar/upload — upload avatar image
 * ===========================================================================
 * Accepts raw binary body, Content-Type = MIME. ≤5 MB. jpeg/png/webp only.
 * Uploads to profile-media bucket at avatars/{userId}/{uuid}.{ext}.
 * Returns { url }. Does NOT update avatar_url on the profile row —
 * caller must follow up with PATCH /me/profile { avatarUrl }.
 */
router.post(
  "/me/avatar/upload",
  (req, res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { (req as any).rawBody = Buffer.concat(chunks); next(); });
    req.on("error", next);
  },
  async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

    // Emergency flag: disable_media_uploads — fail-open on DB error
    if (await isFlagEnabled(sc, 'disable_media_uploads')) {
      sendError(res, 'feature_disabled', 'Media uploads are temporarily disabled');
      return;
    }

    const mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const ext = ALLOWED_AVATAR_MIME[mimeType];
    if (!ext) {
      sendError(res, "invalid_payload", `Unsupported avatar type: ${mimeType}. Use jpeg, png, or webp.`);
      return;
    }
    const rawBody: Buffer = (req as any).rawBody;
    if (!rawBody || rawBody.length === 0) {
      sendError(res, "invalid_payload", "Empty file body");
      return;
    }
    if (rawBody.length > MAX_AVATAR_BYTES) {
      sendError(res, "invalid_payload", `Avatar too large (${Math.round(rawBody.length / 1024 / 1024)}MB; max 5MB)`);
      return;
    }

    await ensureStorageBucket(sc, AVATAR_BUCKET, req);

    // Delete existing avatar file(s) before uploading new one to avoid orphaned files
    try {
      const { data: existingProfile } = await sc
        .from("profiles").select("avatar_url").eq("id", user.id).maybeSingle();
      const oldUrl: string | null = (existingProfile as any)?.avatar_url ?? null;
      if (oldUrl) {
        const marker = `/object/public/${AVATAR_BUCKET}/`;
        const idx = oldUrl.indexOf(marker);
        if (idx !== -1) {
          const oldPath = oldUrl.slice(idx + marker.length);
          await sc.storage.from(AVATAR_BUCKET).remove([oldPath]);
        }
      }
    } catch { /* fail-open: old file deletion is best-effort */ }

    const { randomUUID } = await import("crypto");
    const uuid = randomUUID();
    const path = `avatars/${user.id}/${uuid}.${ext}`;

    const { error } = await sc.storage
      .from(AVATAR_BUCKET)
      .upload(path, rawBody, { contentType: mimeType, upsert: true });

    if (error) {
      req.log.error({ err: error, path }, "Avatar upload failed");
      sendError(res, "db_error", `Upload failed: ${error.message}`);
      return;
    }

    const { data: urlData } = sc.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    res.status(201).json({ url: urlData.publicUrl, path });
  },
);

/* ===========================================================================
 * POST /me/cover/upload — upload cover photo image
 * ===========================================================================
 * Accepts raw binary body, Content-Type = MIME. ≤10 MB. jpeg/png/webp only.
 * Uploads to profile-media bucket at covers/{userId}/cover.{ext} (fixed path,
 * so each upload replaces the previous one). Returns { url }.
 * Does NOT update cover_photo_url on the profile row —
 * caller must follow up with PATCH /me/profile { coverUrl }.
 */
const MAX_COVER_BYTES = 10 * 1024 * 1024; // 10 MB

router.post(
  "/me/cover/upload",
  (req, res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { (req as any).rawBody = Buffer.concat(chunks); next(); });
    req.on("error", next);
  },
  async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

    // Emergency flag: disable_media_uploads — fail-open on DB error
    if (await isFlagEnabled(sc, 'disable_media_uploads')) {
      sendError(res, 'feature_disabled', 'Media uploads are temporarily disabled');
      return;
    }

    const mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const ext = ALLOWED_AVATAR_MIME[mimeType];
    if (!ext) {
      sendError(res, "invalid_payload", `Unsupported cover type: ${mimeType}. Use jpeg, png, or webp.`);
      return;
    }
    const rawBody: Buffer = (req as any).rawBody;
    if (!rawBody || rawBody.length === 0) {
      sendError(res, "invalid_payload", "Empty file body");
      return;
    }
    if (rawBody.length > MAX_COVER_BYTES) {
      sendError(res, "invalid_payload", `Cover too large (${Math.round(rawBody.length / 1024 / 1024)}MB; max 10MB)`);
      return;
    }

    await ensureStorageBucket(sc, AVATAR_BUCKET, req);

    // Delete existing cover file (any extension) before uploading new one
    try {
      const { data: existingProfile } = await sc
        .from("profiles").select("cover_photo_url").eq("id", user.id).maybeSingle();
      const oldUrl: string | null = (existingProfile as any)?.cover_photo_url ?? null;
      if (oldUrl) {
        const marker = `/object/public/${AVATAR_BUCKET}/`;
        const idx = oldUrl.indexOf(marker);
        if (idx !== -1) {
          const oldPath = oldUrl.slice(idx + marker.length);
          await sc.storage.from(AVATAR_BUCKET).remove([oldPath]);
        }
      }
    } catch { /* fail-open: old file deletion is best-effort */ }

    const path = `covers/${user.id}/cover.${ext}`;

    const { error } = await sc.storage
      .from(AVATAR_BUCKET)
      .upload(path, rawBody, { contentType: mimeType, upsert: true });

    if (error) {
      req.log.error({ err: error, path }, "Cover upload failed");
      sendError(res, "db_error", `Upload failed: ${error.message}`);
      return;
    }

    const { data: urlData } = sc.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    res.status(201).json({ url: urlData.publicUrl, path });
  },
);

// ── PUT /api/me/push-token ────────────────────────────────────────────────────
// Stores the device's Expo push token so the server can send push notifications.

router.put("/me/push-token", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { token } = req.body ?? {};
  if (typeof token !== "string" || !token.startsWith("ExponentPushToken[")) {
    sendError(res, "invalid_payload", "token must be a valid ExponentPushToken");
    return;
  }

  const { error } = await client
    .from("profiles")
    .update({ expo_push_token: token })
    .eq("id", user.id);

  if (error) {
    req.log.error({ err: error }, "push-token: db update failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ ok: true });
});

/* ===========================================================================
 * POST /me/reactivate — re-activate a self-deactivated account
 * ===========================================================================
 * Only works when account was self-deactivated (state = 'deactivated').
 * Admin-suspended or admin-banned accounts cannot self-reactivate.
 */
router.post("/me/reactivate", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // Fail closed: check profiles.account_status directly — this is the authoritative field
  const { data: profileRow, error: profileCheckErr } = await sc
    .from("profiles")
    .select("account_status")
    .eq("id", user.id)
    .maybeSingle();

  if (profileCheckErr) {
    req.log.error({ err: profileCheckErr }, "reactivate: failed to check account status");
    sendError(res, "db_error", "Could not verify account status");
    return;
  }
  if (!profileRow) {
    sendError(res, "not_found", "Profile not found");
    return;
  }

  const currentStatus = (profileRow as any).account_status as string;
  if (currentStatus !== "deactivated") {
    // suspended/banned/deleted accounts cannot self-reactivate
    sendError(res, "forbidden", "Account cannot be self-reactivated. Please contact support.");
    return;
  }

  const now = new Date().toISOString();

  // Fail closed: if the profile update fails, return an error (don't swallow it)
  const { error: profileUpdateErr } = await sc
    .from("profiles")
    .update({ account_status: "active" })
    .eq("id", user.id);

  if (profileUpdateErr) {
    req.log.error({ err: profileUpdateErr }, "reactivate: profile update failed");
    sendError(res, "db_error", "Failed to reactivate account");
    return;
  }

  // Secondary writes are best-effort after the primary write succeeds
  sc.from("user_account_states")
    .upsert({ user_id: user.id, state: "active", updated_at: now }, { onConflict: "user_id" })
    .then(undefined, () => {});

  sc.from("profile_privacy_settings")
    .upsert({ user_id: user.id, allow_profile_discovery: true, updated_at: now }, { onConflict: "user_id" })
    .then(undefined, () => {});

  res.status(200).json({ reactivated: true });
});

/* ===========================================================================
 * POST /me/deactivate — temporarily deactivate the caller's account
 * ===========================================================================
 * Sets user_account_states to 'deactivated' and flags discovery off.
 */
router.post("/me/deactivate", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const now = new Date().toISOString();
  const { error } = await sc
    .from("user_account_states")
    .upsert({ user_id: user.id, state: "deactivated", updated_at: now }, { onConflict: "user_id" });

  if (error) {
    req.log.error({ err: error }, "deactivate: failed to update account state");
    sendError(res, "db_error", error.message);
    return;
  }

  // Update profile-level account_status (awaited; fail-open if column not yet migrated)
  await sc
    .from("profiles")
    .update({ account_status: "deactivated" })
    .eq("id", user.id)
    .then(undefined, () => {});

  // Suppress from discovery (fire-and-forget: non-critical)
  sc.from("profile_privacy_settings")
    .upsert({ user_id: user.id, allow_profile_discovery: false, updated_at: now }, { onConflict: "user_id" })
    .then(undefined, () => {});

  res.status(200).json({ deactivated: true });
});

/* ===========================================================================
 * POST /me/delete-request — schedule account deletion (30-day hold)
 * ===========================================================================
 * Creates a deletion request record and flags the account as deactivated
 * so it becomes invisible to other users during the hold period.
 */
router.post("/me/delete-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const now = new Date().toISOString();
  const scheduledAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await sc
    .from("user_deletion_requests")
    .upsert({ user_id: user.id, requested_at: now, scheduled_at: scheduledAt, status: "pending" }, { onConflict: "user_id" });

  if (error) {
    req.log.error({ err: error }, "delete-request: failed to create deletion request");
    sendError(res, "db_error", error.message);
    return;
  }

  // Deactivate so profile is unavailable to others during the hold period
  await sc
    .from("user_account_states")
    .upsert({ user_id: user.id, state: "deactivated", updated_at: now }, { onConflict: "user_id" })
    .then(undefined, () => {});

  // Update profile-level account_status (awaited; fail-open if column not yet migrated)
  await sc
    .from("profiles")
    .update({ account_status: "deactivated" })
    .eq("id", user.id)
    .then(undefined, () => {});

  // Suppress from discovery (fire-and-forget: non-critical)
  sc.from("profile_privacy_settings")
    .upsert({ user_id: user.id, allow_profile_discovery: false, updated_at: now }, { onConflict: "user_id" })
    .then(undefined, () => {});

  res.status(200).json({ deletionScheduled: true, scheduledAt });
});

/* ===========================================================================
 * GET /me/privacy — fetch caller's privacy settings
 * ===========================================================================
 * Returns the profile_privacy_settings row, or defaults if none exists yet.
 */
const PRIVACY_DEFAULTS = {
  profile_visibility: "public",
  show_current_city: true,
  show_home_country: true,
  show_visited_places: true,
  show_upcoming_trips: true,
  show_past_trips: true,
  show_posts: true,
  show_stamps: true,
  show_friends: true,
  show_followers: true,
  allow_messages_from: "everyone",
  allow_friend_requests: true,
  allow_follow: true,
  allow_tagging: true,
  allow_profile_discovery: true,
  delayed_posting_default: false,
  precise_location_visible: false,
} as const;

router.get("/me/privacy", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const { data, error } = await sc
    .from("profile_privacy_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    if ((error as any).code === "42P01" || (error as any).code === "PGRST205") {
      res.status(200).json({ ...PRIVACY_DEFAULTS, user_id: user.id });
      return;
    }
    req.log.error({ err: error }, "privacy/get: query failed");
    sendError(res, "db_error", error.message);
    return;
  }

  if (!data) {
    // First access: persist defaults so PATCH can merge against a real row
    const defaults = { ...PRIVACY_DEFAULTS, user_id: user.id };
    sc.from("profile_privacy_settings")
      .upsert(defaults, { onConflict: "user_id" })
      .then(undefined, (e: any) => req.log.warn({ err: e }, "privacy/get: failed to seed defaults"));
    res.status(200).json(defaults);
    return;
  }

  res.status(200).json(data);
});

/* ===========================================================================
 * PATCH /me/privacy — update privacy settings
 * ===========================================================================
 * Upserts profile_privacy_settings and syncs profile_visibility to
 * user_privacy_settings so the interactionPermissions engine stays consistent.
 */
const patchPrivacySchema = z.object({
  profile_visibility: z.enum(["public", "followers_only", "private"]).optional(),
  show_current_city: z.boolean().optional(),
  show_home_country: z.boolean().optional(),
  show_visited_places: z.boolean().optional(),
  show_upcoming_trips: z.boolean().optional(),
  show_past_trips: z.boolean().optional(),
  show_posts: z.boolean().optional(),
  show_stamps: z.boolean().optional(),
  show_friends: z.boolean().optional(),
  show_followers: z.boolean().optional(),
  allow_messages_from: z.enum(["everyone", "friends", "followers", "nobody"]).optional(),
  allow_friend_requests: z.boolean().optional(),
  allow_follow: z.boolean().optional(),
  allow_tagging: z.boolean().optional(),
  allow_profile_discovery: z.boolean().optional(),
  delayed_posting_default: z.boolean().optional(),
  precise_location_visible: z.boolean().optional(),
});

router.patch("/me/privacy", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = patchPrivacySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const now = new Date().toISOString();

  // Fetch existing to merge (prevents overwriting fields not in this PATCH)
  const existingRes = await sc
    .from("profile_privacy_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle()
    .then(undefined, () => ({ data: null }));
  const existing = existingRes.data;

  const mergedRow = {
    ...PRIVACY_DEFAULTS,
    ...(existing ?? {}),
    ...parsed.data,
    user_id: user.id,
    updated_at: now,
  };

  const { data, error } = await sc
    .from("profile_privacy_settings")
    .upsert(mergedRow, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) {
    req.log.error({ err: error }, "privacy/patch: update failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Keep user_privacy_settings.profile_visibility in sync
  if (parsed.data.profile_visibility !== undefined) {
    const syncVisibility = parsed.data.profile_visibility === "followers_only"
      ? null   // user_privacy_settings encodes "followers_only" as null (falsy private)
      : parsed.data.profile_visibility;
    sc.from("user_privacy_settings")
      .upsert({ user_id: user.id, profile_visibility: syncVisibility, updated_at: now }, { onConflict: "user_id" })
      .then(undefined, () => {});
  }

  res.status(200).json(data);
});

export default router;
