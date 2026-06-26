import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { retranslateForUser } from "../services/messageTranslation";

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
  "admin", "support", "system", "travelbuddy", "passport", "official",
  "root", "api", "settings", "login", "signup", "help", "me", "user",
  "users", "null", "undefined", "about", "terms", "privacy",
]);

const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;

function validateUsername(u: string): { valid: boolean; reason?: string } {
  if (!USERNAME_RE.test(u)) {
    return { valid: false, reason: "Username must be 3-24 chars, lowercase letters/numbers/underscores/periods only" };
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
 * GET /me/profile — full own profile
 * ===========================================================================
 */
router.get("/me/profile", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

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
  res.status(200).json(mapProfile(data));
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

  if (p.displayName !== undefined) row.display_name = p.displayName;
  if (p.bio !== undefined) row.bio = p.bio;
  if (p.homeCity !== undefined) row.home_city = p.homeCity;
  if (p.homeCountry !== undefined) row.home_country = p.homeCountry;
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
    const { data: existing } = await client
      .from("profiles")
      .select("id")
      .eq("username", p.username)
      .neq("id", user.id)
      .maybeSingle();
    if (existing) {
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

export default router;
