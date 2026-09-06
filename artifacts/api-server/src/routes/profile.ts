import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, safeSecretEquals } from "../lib/http";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { getServiceClient } from "../lib/supabase";
import { resolveStoragePath } from "../lib/storagePath.js";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";
import { retranslateForUser } from "../services/messageTranslation";
import { shouldRetranslateOnLanguageChange } from "../lib/retranslateGate";
import { detectAndStoreLanguage, invalidateContentTranslations } from "../services/contentTranslation.js";
import { isFlagEnabled, isKillSwitchEngaged } from "../lib/featureFlags";
import { invalidateCompassHomeCache } from "./compassHome";
import { sniffMedia, processImage, type ProcessedImage, type SniffResult } from "../lib/mediaProcessing";
import { appMediaRef } from "../lib/postSchemas";
import { computeTrustScore } from "../lib/trustScore.js";
import { countContentStampsReceived } from "../services/stamps/ContentStampService.js";
import { countUserTrips } from "../lib/tripCounts.js";
import { validateUsername } from "../lib/usernameRules.js";

/**
 * Sniff + strip-EXIF/auto-orient an avatar/cover image. Returns the processed
 * buffer + real mime/ext, or a string error message. Avatars/covers previously
 * stored raw client bytes — including embedded GPS EXIF (audit privacy fix).
 */
async function prepareProfileImage(
  rawBody: Buffer,
  maxDim: number,
): Promise<{ img: ProcessedImage } | { error: string }> {
  const sniffed: SniffResult | null = sniffMedia(rawBody);
  if (!sniffed || sniffed.kind !== "image") {
    return { error: "File content is not a supported image (jpeg, png, webp)" };
  }
  try {
    return { img: await processImage(rawBody, sniffed, maxDim) };
  } catch {
    return { error: "Corrupt or undecodable image file" };
  }
}

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

// Username validity/reserved rules live in one place (lib/usernameRules) so the
// input-assistance gateway's §23 validation reuses the identical rules. Behavior
// here is unchanged — this used to be an inline copy (see the import at the top).

const PROFILE_COLUMNS =
  "id, handle, name, display_name, username, bio, avatar_url, home_city, home_country, current_city, travel_style, interests, verified, verification_status, verified_at, open_to_meet, is_private, passport_visibility, cover_photo_url, username_updated_at, created_at, spoken_languages, default_language, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, availability_tags, planning_style, public_social_links, preferred_language, verification_level, id_verified_at, selfie_verified_at, home_country_verified_at, safety_flags_count, host_verified_at, buddy_verified_at, passport_section_order, passport_tab_order, passport_hidden_sections, date_of_birth, is_official, featured_count";

/**
 * Fallback column list for older DB schemas that may not have the full set of columns
 * in PROFILE_COLUMNS. Must not include sensitive columns (dob_verified,
 * or any internal/admin-only field). Triggered only on error codes 42703 / PGRST204.
 * date_of_birth is fetched for server-side ageGateRequired computation only — it is
 * never returned to the client directly.
 */
const PROFILE_COLUMNS_FALLBACK =
  "id, handle, name, username, bio, avatar_url, home_city, home_country, current_city, travel_style, interests, verified, verification_status, verified_at, open_to_meet, is_private, passport_visibility, username_updated_at, created_at";

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
    passportSectionOrder: r.passport_section_order ?? null,
    passportTabOrder: r.passport_tab_order ?? null,
    passportHiddenSections: r.passport_hidden_sections ?? null,
    verificationLevel: r.verification_level ?? null,
    idVerifiedAt: r.id_verified_at ?? null,
    selfieVerifiedAt: r.selfie_verified_at ?? null,
    homeCountryVerifiedAt: r.home_country_verified_at ?? null,
    safetyFlagsCount: r.safety_flags_count ?? null,
    hostVerifiedAt: r.host_verified_at ?? null,
    buddyVerifiedAt: r.buddy_verified_at ?? null,
    isOfficial: r.is_official ?? false,
    featuredCount: (r.featured_count as number) ?? 0,
  };
}

/* ---------------------------------------------------------------------------
 * POST /profile/ensure — idempotently create a profile row for the authed user
 * ---------------------------------------------------------------------------
 * Uses the service-role key so the insert bypasses RLS. This is necessary for
 * new sign-ups before PostgREST picks up the P-256 JWT key rotation (auth.uid()
 * returns NULL under PostgREST when the key is in ECC P-256 format).
 */
router.post("/profile/ensure", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const email: string = req.body?.email ?? '';
  const nameMeta: string | undefined = req.body?.name ?? undefined;
  const handleMeta: string | undefined = req.body?.handle ?? undefined;

  const base = (handleMeta || email.split('@')[0] || 'traveler').replace(/[^a-zA-Z0-9_]/g, '');
  const handle = `${base}_${user.id.slice(0, 4)}`;
  const name = nameMeta || email.split('@')[0] || 'Traveler';

  const { error } = await sc
    .from('profiles')
    .upsert(
      { id: user.id, handle, name, display_name: name },
      { onConflict: 'id', ignoreDuplicates: true },
    );

  if (error) {
    req.log.warn({ err: error }, "profile/ensure upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Also ensure a location_preferences row exists with safe defaults.
  // NOTE: The table was originally called user_location_privacy and was renamed
  // to location_preferences in migration 0032_location_preferences.sql.
  // Uses ignoreDuplicates so existing preferences are never overwritten.
  const { error: locError } = await sc
    .from('location_preferences')
    .upsert(
      { user_id: user.id },
      { onConflict: 'user_id', ignoreDuplicates: true },
    );
  if (locError) {
    // Non-fatal: log but don't block the response. The row will be created
    // on first access to location features.
    req.log.warn({ err: locError }, "profile/ensure location_preferences upsert failed (non-fatal)");
  }

  res.status(200).json({ ok: true });
});

/* ---------------------------------------------------------------------------
 * GET /me/profile/analytics — private owner analytics (7d / 30d views, follower growth)
 * ---------------------------------------------------------------------------
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

  const [views7Res, views30Res, followers7Res, followers30Res, analyticsStampsEarnedRes, analyticsMilestonesRes] = await Promise.allSettled([
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
      .select("follower_id", { count: "exact", head: true })
      .eq("following_id", user.id)
      .gte("created_at", d7),
    sc.from("user_follows")
      .select("follower_id", { count: "exact", head: true })
      .eq("following_id", user.id)
      .gte("created_at", d30),
    // Lifetime stamps earned (user_stamps, non-revoked). Fails silently.
    sc.from("user_stamps")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_revoked", false),
    // Milestone history (stamp_milestones). Fails silently.
    sc.from("stamp_milestones")
      .select("milestone_level, celebrated_at")
      .eq("user_id", user.id),
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
  const analyticsStampsEarned = analyticsStampsEarnedRes.status === "fulfilled"
    ? ((analyticsStampsEarnedRes.value as any).count ?? 0)
    : 0;
  const analyticsMilestones: Array<{ level: number; celebratedAt: string }> =
    analyticsMilestonesRes.status === "fulfilled"
      ? (((analyticsMilestonesRes.value as any).data ?? []) as any[]).map((m: any) => ({
          level: m.milestone_level as number,
          celebratedAt: m.celebrated_at as string,
        }))
      : [];

  res.status(200).json({
    profileViews: { sevenDay: profileViews7d, thirtyDay: profileViews30d },
    followerGrowth: { sevenDay: followerDelta7d, thirtyDay: followerDelta30d },
    postImpressions7d: postImpressionsRes,
    stampsEarned: analyticsStampsEarned,
    milestones: analyticsMilestones,
  });
});

/* ---------------------------------------------------------------------------
 * GET /me/profile/viewers — paginated list of users who viewed the caller's
 * profile in the last 7 days. Privacy-filtered: viewers with
 * allow_profile_discovery = false are omitted.
 * ---------------------------------------------------------------------------
 */
router.get("/me/profile/viewers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit = Math.min(Number((req.query as any).limit ?? 50), 100);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();

  // Fetch recent profile views, most-recent first, excluding self-views.
  const { data: viewRows, error: viewErr } = await sc
    .from("profile_views")
    .select("viewer_id, viewed_at")
    .eq("target_id", user.id)
    .neq("viewer_id", user.id)
    .gte("viewed_at", since)
    .order("viewed_at", { ascending: false })
    .limit(limit * 3); // over-fetch: dedupe + privacy filter will reduce count
  if (viewErr) { sendError(res, "db_error", viewErr.message); return; }
  if (!viewRows || viewRows.length === 0) { res.json({ viewers: [] }); return; }

  // Deduplicate by viewer_id — keep only the most recent view per user.
  const seen = new Set<string>();
  const unique: any[] = [];
  for (const r of viewRows as any[]) {
    if (!seen.has(r.viewer_id as string)) {
      seen.add(r.viewer_id as string);
      unique.push(r);
      if (unique.length >= limit * 2) break;
    }
  }

  const viewerIds = unique.map((r) => r.viewer_id as string);

  const [profilesRes, privacyRes, allowedNames] = await Promise.all([
    sc.from("profiles").select("id, username, full_name, avatar_url, is_official").in("id", viewerIds),
    sc.from("profile_privacy_settings").select("user_id, allow_profile_discovery").in("user_id", viewerIds),
    // Which viewers permit their REAL name to be shown (show_real_name=true).
    // Previously full_name was returned unconditionally, leaking the real names
    // of viewers who never opted in. Fail-closed (an error yields an empty set).
    nameVisibilitySet(sc, viewerIds),
  ]);

  const profileMap = new Map(((profilesRes.data ?? []) as any[]).map((p) => [p.id as string, p]));
  const privacyMap = new Map(((privacyRes.data ?? []) as any[]).map((p) => [p.user_id as string, p.allow_profile_discovery as boolean]));

  const viewers = unique
    .filter((r) => privacyMap.get(r.viewer_id as string) !== false)
    .slice(0, limit)
    .map((r) => {
      const p = profileMap.get(r.viewer_id as string);
      return {
        userId: r.viewer_id,
        handle: (p as any)?.username ?? null,
        name: allowedNames.has(r.viewer_id as string) ? ((p as any)?.full_name ?? null) : null,
        avatarUrl: (p as any)?.avatar_url ?? null,
        isOfficial: (p as any)?.is_official ?? false,
        viewedAt: r.viewed_at,
      };
    })
    .filter((v) => v.handle !== null);

  res.json({ viewers });
});

/* ---------------------------------------------------------------------------
 * GET /me/profile — full own profile (with completeness score)
 * ---------------------------------------------------------------------------
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

  if (error && ((error as any).code === "42703" || (error as any).code === "PGRST204")) {
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

  // Completeness score + trust score + stamp count: parallel queries (all fail-open)
  const [stampRes, tripRes, followersRes, followingRes, trustRes, stampsEarnedRes, contentStampsReceivedRes] = await Promise.allSettled([
    sc ? sc.from("passport_stamps").select("user_id", { count: "exact", head: true }).eq("user_id", user.id).limit(1) : Promise.resolve({ count: 0 }),
    sc ? countUserTrips(sc, user.id) : Promise.resolve({ count: 0 }),
    sc ? sc.from("user_follows").select("follower_id", { count: "exact", head: true }).eq("following_id", user.id) : Promise.resolve({ count: 0 }),
    sc ? sc.from("user_follows").select("follower_id", { count: "exact", head: true }).eq("follower_id", user.id) : Promise.resolve({ count: 0 }),
    sc ? computeTrustScore(user.id, sc, data as Record<string, any>) : Promise.resolve(null),
    // Lifetime passport milestone stamps (all entity types, excluding revoked). Fails silently if
    // user_stamps table is absent (schema-drift safe).
    sc ? sc.from("user_stamps").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_revoked", false) : Promise.resolve({ count: 0 }),
    // Content stamps received: stamps placed by others on this user's posts.
    // Uses the paginated/RPC counter so lifetime totals are exact for
    // high-post-count users rather than capped by a single-page query.
    sc ? countContentStampsReceived(sc, user.id) : Promise.resolve(0),
  ]);
  const hasStamp     = stampRes.status === "fulfilled" && ((stampRes.value as any).count ?? 0) > 0;
  const tripCount    = tripRes.status === "fulfilled" ? ((tripRes.value as any).count ?? 0) : 0;
  const hasTrip      = tripCount > 0;
  const followersCount = followersRes.status === "fulfilled" ? ((followersRes.value as any).count ?? 0) : 0;
  const followingCount = followingRes.status === "fulfilled" ? ((followingRes.value as any).count ?? 0) : 0;
  const trustResult  = trustRes.status === "fulfilled" ? trustRes.value : null;
  // STAMPS reflects both passport milestones and content reactions (Roam/Watch
  // stamps placed by others on this user's posts/media) — counted exactly once
  // via the paginated countContentStampsReceived above.
  const contentStampsReceived = contentStampsReceivedRes.status === "fulfilled" ? contentStampsReceivedRes.value : 0;
  const stampsEarned = (stampsEarnedRes.status === "fulfilled" ? ((stampsEarnedRes.value as any).count ?? 0) : 0) + contentStampsReceived;

  const completeness = computeCompleteness(data, hasStamp, hasTrip);

  const ageGateRequired = (() => {
    const dob = (data as any).date_of_birth as string | null | undefined;
    if (!dob) return true;
    const birth = new Date(dob + 'T00:00:00');
    if (isNaN(birth.getTime())) return true;
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
    return age < 18;
  })();
  res.status(200).json({
    ...mapProfile(data),
    ageGateRequired,
    completeness,
    tripCount,
    followersCount,
    followingCount,
    trustScore: trustResult?.score ?? null,
    trustLabel: trustResult?.label ?? null,
    trustScoreBreakdown: trustResult?.breakdown ?? null,
    stampsEarned,
  });
});

/* ---------------------------------------------------------------------------
 * PATCH /me/profile — update own profile
 * ---------------------------------------------------------------------------
 * User identity always from auth token — never from body.
 */
const patchProfileSchema = z.object({
  displayName: z.string().min(1).max(30).optional(),
  username: z.string().optional(),
  bio: z.string().max(300).nullish(),
  homeCity: z.string().max(100).nullish(),
  homeCountry: z.string().max(100).nullish(),
  currentCity: z.string().max(100).nullish(),
  interests: z.array(z.string().max(50)).max(20).optional(),
  passportVisibility: z.enum(["public", "followers_only", "private"]).optional(),
  avatarUrl: appMediaRef.nullish(),
  avatarImageWidth: z.number().int().positive().nullish(),
  avatarImageHeight: z.number().int().positive().nullish(),
  coverUrl: appMediaRef.nullish(),
  coverImageWidth: z.number().int().positive().nullish(),
  coverImageHeight: z.number().int().positive().nullish(),
  travelStyle: z.string().max(50).nullish(),
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
  /**
   * Set to true by the onboarding flow after the user completes all steps.
   * Triggers a silent server-side auto-follow of the @Portava account so the
   * new user's Pulse/Roam feed is non-empty from day one.
   */
  onboardingComplete: z.boolean().optional(),
  passportSectionOrder: z
    .array(z.enum(["identity", "stamps", "highlights", "tabs", "dossier"]))
    .length(5)
    .nullable()
    .optional(),
  passportTabOrder: z
    .array(z.enum(["postcards", "memories", "plans", "stamps", "map"]))
    .length(5)
    .nullable()
    .optional(),
  passportHiddenSections: z
    .array(z.enum(["stamps", "highlights", "tabs", "dossier"]))
    .nullable()
    .optional(),
  isPrivate: z.boolean().optional(),
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
  const nowMs = Date.now();

  const row: Record<string, unknown> = {};

  if (p.displayName !== undefined) {
    row.name = p.displayName;
    row.display_name = p.displayName;
  }
  if (p.bio !== undefined) row.bio = p.bio;
  if (p.homeCity !== undefined) row.home_city = p.homeCity;
  if (p.homeCountry !== undefined) row.home_country = p.homeCountry;
  if (p.currentCity !== undefined) row.current_city = p.currentCity;
  if (p.interests !== undefined) row.interests = p.interests;
  if (p.passportVisibility !== undefined) row.passport_visibility = p.passportVisibility;
  if (p.avatarUrl !== undefined) row.avatar_url = p.avatarUrl;
  if (p.avatarImageWidth  !== undefined) row.avatar_image_width  = p.avatarImageWidth;
  if (p.avatarImageHeight !== undefined) row.avatar_image_height = p.avatarImageHeight;
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
  if (p.coverImageWidth  !== undefined) row.cover_image_width  = p.coverImageWidth;
  if (p.coverImageHeight !== undefined) row.cover_image_height = p.coverImageHeight;
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
      const now = new Date(nowMs);
      if (dob >= now) {
        sendError(res, "invalid_payload", "dateOfBirth must be in the past");
        return;
      }
      const ageYears = now.getFullYear() - dob.getFullYear() - (
        now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate()) ? 1 : 0
      );
      if (ageYears < 18) {
        res.status(403).json({ error: "forbidden", message: "Users under 18 are not permitted" });
        return;
      }
    }
    row.date_of_birth = p.dateOfBirth;
  }

  if (p.passportSectionOrder !== undefined) {
    if (p.passportSectionOrder !== null) {
      // Must be a permutation of all five section keys (no duplicates).
      if (new Set(p.passportSectionOrder).size !== 5) {
        sendError(res, "invalid_payload", "passportSectionOrder must contain each section exactly once");
        return;
      }
    }
    row.passport_section_order = p.passportSectionOrder;
  }
  if (p.passportTabOrder !== undefined) {
    if (p.passportTabOrder !== null) {
      // Must be a permutation of all five tab keys (no duplicates).
      if (new Set(p.passportTabOrder).size !== 5) {
        sendError(res, "invalid_payload", "passportTabOrder must contain each tab key exactly once");
        return;
      }
    }
    row.passport_tab_order = p.passportTabOrder;
  }
  if (p.passportHiddenSections !== undefined) {
    // Persist null when the array is empty (no sections hidden) to keep the
    // column tidy.  The Zod schema already restricts values to the four
    // hideable section keys, so no additional validation is needed here.
    row.passport_hidden_sections =
      p.passportHiddenSections && p.passportHiddenSections.length > 0
        ? p.passportHiddenSections
        : null;
  }
  if (p.tagPermission !== undefined) row.tag_permission = p.tagPermission;
  if (p.isPrivate !== undefined) row.is_private = p.isPrivate;

  if (p.username !== undefined) {
    // Invariant: handle is canonical, username mirrors it; both lowercase.
    p.username = p.username.toLowerCase().trim();
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
      const msSince = nowMs - lastChanged.getTime();
      const daysSince = msSince / (1000 * 60 * 60 * 24);
      if (daysSince < 30) {
        const daysLeft = Math.ceil(30 - daysSince);
        sendError(res, "rate_limited", `Username can only be changed once every 30 days. ${daysLeft} day${daysLeft !== 1 ? "s" : ""} remaining.`);
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
    row.handle = p.username; // invariant: username === handle (handle canonical)
    row.username_updated_at = new Date(nowMs).toISOString();
  }

  // Capture old avatar / cover URLs before the update so we can clean up the
  // storage files after the profile row is successfully committed.  Failure is
  // fail-open: we just skip the old-file cleanup.
  let oldAvatarUrl: string | null = null;
  let oldCoverUrl: string | null = null;
  if (p.avatarUrl !== undefined || p.coverUrl !== undefined) {
    const sc = getServiceClient();
    if (sc) {
      try {
        const { data: cur } = await sc
          .from("profiles")
          .select("avatar_url, cover_photo_url")
          .eq("id", user.id)
          .maybeSingle();
        oldAvatarUrl = (cur as any)?.avatar_url ?? null;
        oldCoverUrl = (cur as any)?.cover_photo_url ?? null;
      } catch { /* fail-open */ }
    }
  }

  if (Object.keys(row).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  // Fire-and-forget: delete old storage files once the profile row is
  // confirmed saved. Shared by both success paths (normal and schema-drift
  // fallback) so replaced avatars/covers never orphan the old file.
  // `savedRow` is the row actually written — a field's old file is only
  // deleted if its column was persisted (the schema-drift fallback strips
  // cover_photo_url, in which case the old cover is still live).
  // This is the highest-volume orphan producer in the codebase: it runs on
  // every avatar or cover change, where the admin delete path runs almost
  // never. It previously searched the old URL for `/object/public/<bucket>/`
  // and `continue`d when that was absent — which is the common case, not the
  // rare one, because the upload endpoints below return a BUCKET-QUALIFIED
  // path (`profile-media/avatars/…`, see `res.json({ url: ... })` in
  // POST /me/avatar/file and /me/cover/file). So the format this server writes
  // was exactly the format this cleanup could not parse, and every replaced
  // avatar left its predecessor behind. Measured 2026-08-09: 20 orphaned
  // objects in profile-media across 6 users, one of them holding 11.
  //
  // FAIL LOUD, adapted to the context. Unlike the admin delete paths this runs
  // in setImmediate AFTER the response is sent, so there is no request to fail
  // and no column left to protect — the profile row is already updated. The
  // equivalent obligation here is that an object we cannot account for is
  // LOGGED with enough detail to find it, never dropped on the floor.
  const cleanupOldMedia = (savedRow: Record<string, unknown>) => {
    setImmediate(() => {
      const sc = getServiceClient();
      if (!sc) return;
      for (const [field, newUrl, oldUrl] of [
        ["avatar_url", "avatar_url" in savedRow ? p.avatarUrl : undefined, oldAvatarUrl],
        ["cover_photo_url", "cover_photo_url" in savedRow ? p.coverUrl : undefined, oldCoverUrl],
      ] as Array<[string, string | undefined, string | null]>) {
        if (newUrl === undefined || !oldUrl || oldUrl === newUrl) continue;

        const ref = resolveStoragePath(oldUrl, AVATAR_BUCKET);
        if (ref.kind === "none") continue;
        if (ref.kind === "external") continue; // seed/CDN URL — no object of ours

        if (ref.kind === "unresolvable") {
          req.log?.error?.(
            { field, userId: user.id, storedValue: ref.value },
            "profile media cleanup: cannot derive a storage path from the replaced value — " +
              "object orphaned, needs manual removal",
          );
          continue;
        }

        sc.storage
          .from(AVATAR_BUCKET)
          .remove([ref.path])
          .then(
            ({ error }: any) => {
              if (error) {
                req.log?.error?.(
                  { field, userId: user.id, path: ref.path, err: error },
                  "profile media cleanup: storage removal failed — object orphaned",
                );
              }
            },
            (err: unknown) => {
              req.log?.error?.(
                { field, userId: user.id, path: ref.path, err },
                "profile media cleanup: storage removal threw — object orphaned",
              );
            },
          );
      }
    });
  };

  let { data: updated, error: updateError } = await client
    .from("profiles")
    .update(row)
    .eq("id", user.id)
    .select(PROFILE_COLUMNS)
    .single();

  if (updateError && ((updateError as any).code === "42703" || (updateError as any).code === "PGRST204")) {
    // The DB schema is missing one or more newer columns (schema drift).
    // Retry with only the base columns — but never silently drop fields the
    // client explicitly asked to change.
    // Column → client-facing field name, for reporting which requested fields
    // could not be saved by the fallback write.
    const FALLBACK_STRIPPED_COLUMNS: Record<string, string> = {
      display_name: "displayName",
      spoken_languages: "spokenLanguages",
      default_language: "defaultLanguage",
      travel_styles: "travelStyles",
      travel_pace: "travelPace",
      budget_style: "budgetStyle",
      travel_group_style: "travelGroupStyle",
      looking_for: "lookingFor",
      comfort_level: "comfortLevel",
      availability_tags: "availabilityTags",
      planning_style: "planningStyle",
      public_social_links: "publicSocialLinks",
      cover_photo_url: "coverUrl",
      preferred_language: "preferredLanguage",
      passport_section_order: "passportSectionOrder",
      passport_tab_order: "passportTabOrder",
      passport_hidden_sections: "passportHiddenSections",
    };
    const safeRow = { ...row };
    const stripped: string[] = [];
    for (const col of Object.keys(FALLBACK_STRIPPED_COLUMNS)) {
      if (col in safeRow) {
        stripped.push(col);
        delete safeRow[col];
      }
    }
    // Fields the client asked to change that will NOT be persisted by the
    // fallback write. display_name is exempt when the base `name` column is
    // still being written — mapProfile falls back to `name`, so the display
    // name is effectively saved.
    const unsavedFields = stripped
      .filter((col) => !(col === "display_name" && "name" in safeRow))
      .map((col) => FALLBACK_STRIPPED_COLUMNS[col]);

    // passport_section_order / passport_tab_order saves must never silently
    // no-op: if the column is missing from the live schema, surface a real
    // error instead of returning 200 while dropping the user's preference.
    if (stripped.includes("passport_section_order")) {
      req.log.error(
        { code: (updateError as any).code, stripped },
        "PATCH /api/me/profile: passport_section_order column appears to be missing from the profiles table (schema drift) — apply migration 0120. Refusing to silently drop the layout save.",
      );
      sendError(
        res,
        "db_error",
        "Could not save passport layout: the database is missing the passport_section_order column (schema drift). Apply migration 0120_passport_section_order.sql.",
        // Hand-written operator-facing message (names only the drifted column) — safe to expose.
        { exposeDetail: true },
      );
      return;
    }
    if (stripped.includes("passport_tab_order")) {
      req.log.error(
        { code: (updateError as any).code, stripped },
        "PATCH /api/me/profile: passport_tab_order column appears to be missing from the profiles table (schema drift) — apply migration 0143. Refusing to silently drop the tab order save.",
      );
      sendError(
        res,
        "db_error",
        "Could not save tab order: the database is missing the passport_tab_order column (schema drift). Apply migration 0143_passport_tab_order.sql.",
        // Hand-written operator-facing message (names only the drifted column) — safe to expose.
        { exposeDetail: true },
      );
      return;
    }

    if (stripped.length > 0) {
      req.log.warn(
        { code: (updateError as any).code, stripped },
        "PATCH /api/me/profile: retrying update without newer columns due to schema drift — these requested fields will NOT be saved",
      );
    }

    if (Object.keys(safeRow).length === 0) {
      // Everything the client asked to change was stripped — nothing would be
      // saved, so a 200 here would be a lie.
      sendError(
        res,
        "db_error",
        `Could not save profile: the database is missing the required column(s) for every requested field (schema drift). Fields not saved: ${unsavedFields.join(", ")}.`,
        // Hand-written message naming only the client's own requested camelCase fields — safe to expose.
        { exposeDetail: true },
      );
      return;
    }

    ({ data: updated, error: updateError } = await client
      .from("profiles")
      .update(safeRow)
      .eq("id", user.id)
      .select(PROFILE_COLUMNS_FALLBACK)
      .single());

    if (!updateError && unsavedFields.length > 0) {
      // Partial success: base columns saved, but some requested fields were
      // dropped by the fallback. Tell the client exactly which ones.
      cleanupOldMedia(safeRow);
      invalidateCompassHomeCache(user.id);
      res.status(200).json({
        ...mapProfile(updated),
        unsavedFields,
        warning: `Some fields could not be saved because the database is missing their columns (schema drift): ${unsavedFields.join(", ")}.`,
      });
      return;
    }
  }

  if (updateError) {
    req.log.error({ err: updateError }, "Failed to update profile");
    if ((updateError as any).code === "23505") {
      sendError(res, "conflict", "Username is already taken");
      return;
    }
    sendError(res, "db_error", updateError.message);
    return;
  }

  // Fire-and-forget re-translation sweep when preferred_language changes.
  if (p.preferredLanguage !== undefined && p.preferredLanguage !== null) {
    const sc = getServiceClient();
    if (sc) {
      // Gated on auto_translate_messages, matching messaging.ts. Ungated, this
      // sent a 200-message provider sweep for users who never enabled message
      // translation. NOTE: unlike messaging.ts this branch has no change
      // detection -- any present value re-fires it, even an unchanged one --
      // because the update has already run here and the prior language is not
      // in scope. Recorded rather than restructured.
      const { data: prefRow } = await sc
        .from('profiles')
        .select('auto_translate_messages')
        .eq('id', user.id)
        .single();
      if (shouldRetranslateOnLanguageChange({
        newLanguage: p.preferredLanguage,
        autoTranslateMessages: (prefRow as any)?.auto_translate_messages,
      })) {
        retranslateForUser(sc, user.id, p.preferredLanguage, req.log).catch(() => {});
      }
    }
  }

  // Bio language detection — fire-and-forget; bio is stored with entity_type='bio',
  // entity_id=profile.id. Invalidate cached bio translations when bio changes.
  if (p.bio !== undefined) {
    const sc = getServiceClient();
    if (sc) {
      if (p.bio && p.bio.trim()) {
        detectAndStoreLanguage(sc, 'bio', user.id, p.bio, req.log).catch(() => {});
      }
      // Bio changed — purge stale cached translations.
      invalidateContentTranslations(sc, 'bio', user.id).catch(() => {});
    }
  }

  // Fire-and-forget: delete old storage files now that the profile row is confirmed saved.
  cleanupOldMedia(row);

  // Profile changes (current city, visibility, interests…) shape Compass Home
  // — evict the cached payload so the next open reflects them immediately.
  invalidateCompassHomeCache(user.id);

  // ── Onboarding auto-follow ───────────────────────────────────────────────
  // When the client signals onboarding completion, silently auto-follow the
  // @Portava account so the new user's Pulse/Roam feed is non-empty from day
  // one.  Wrapped in a fire-and-forget try/catch so any failure here never
  // blocks the profile save response.
  if (p.onboardingComplete === true) {
    setImmediate(async () => {
      try {
        const sc = getServiceClient();
        if (!sc) return;
        // Look up the @portava account id.
        const { data: portavaProfile } = await sc
          .from("profiles")
          .select("id")
          .eq("username", "portava")
          .maybeSingle();
        if (!portavaProfile?.id) return;
        // Idempotent upsert — safe to call multiple times.
        await sc
          .from("user_follows")
          .upsert(
            { follower_id: user.id, following_id: portavaProfile.id },
            { onConflict: "follower_id,following_id", ignoreDuplicates: true },
          );
      } catch (err) {
        req.log.warn({ err }, "onboarding auto-follow @portava failed (non-fatal)");
      }
    });
  }

  res.status(200).json(mapProfile(updated));
});

/* ---------------------------------------------------------------------------
 * GET /users/check-username — check username availability
 * ---------------------------------------------------------------------------
 */
router.get("/users/check-username", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

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

  const { data } = await client
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

/* ---------------------------------------------------------------------------
 * POST /me/avatar/upload — upload avatar image
 * ---------------------------------------------------------------------------
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

    // Emergency stop: disable_media_uploads — fail-CLOSED on DB error
    if (await isKillSwitchEngaged(sc, 'disable_media_uploads')) {
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

    // Strip EXIF/GPS + auto-orient + cap dimensions (audit privacy fix).
    const prepped = await prepareProfileImage(rawBody, 1024);
    if ("error" in prepped) { sendError(res, "invalid_payload", prepped.error); return; }

    await ensureStorageBucket(sc, AVATAR_BUCKET, req);

    const { randomUUID } = await import("crypto");
    const uuid = randomUUID();
    const path = `avatars/${user.id}/${uuid}.${prepped.img.ext}`;

    const { error } = await sc.storage
      .from(AVATAR_BUCKET)
      .upload(path, prepped.img.buffer, { contentType: prepped.img.mime, upsert: true });

    if (error) {
      req.log.error({ err: error, path }, "Avatar upload failed");
      sendError(res, "db_error", `Upload failed: ${error.message}`);
      return;
    }

    res.status(201).json({ url: `${AVATAR_BUCKET}/${path}`, path, width: prepped.img.width, height: prepped.img.height });
  },
);

/* ---------------------------------------------------------------------------
 * POST /me/cover/upload — upload cover photo image
 * ---------------------------------------------------------------------------
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

    // Emergency stop: disable_media_uploads — fail-CLOSED on DB error
    if (await isKillSwitchEngaged(sc, 'disable_media_uploads')) {
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

    // Strip EXIF/GPS + auto-orient + cap dimensions (audit privacy fix).
    const prepped = await prepareProfileImage(rawBody, 2048);
    if ("error" in prepped) { sendError(res, "invalid_payload", prepped.error); return; }

    await ensureStorageBucket(sc, AVATAR_BUCKET, req);

    const path = `covers/${user.id}/cover.${prepped.img.ext}`;

    const { error } = await sc.storage
      .from(AVATAR_BUCKET)
      .upload(path, prepped.img.buffer, { contentType: prepped.img.mime, upsert: true });

    if (error) {
      req.log.error({ err: error, path }, "Cover upload failed");
      sendError(res, "db_error", `Upload failed: ${error.message}`);
      return;
    }

    res.status(201).json({ url: `${AVATAR_BUCKET}/${path}`, path, width: prepped.img.width, height: prepped.img.height });
  },
);

/* ---------------------------------------------------------------------------
 * DELETE /me/avatar/file — purge an orphaned avatar upload
 * ---------------------------------------------------------------------------
 * Called by the mobile client when the avatar upload succeeded but the
 * subsequent PATCH /me/profile call failed, leaving the new file orphaned in
 * storage.  Path must be scoped to the authenticated user's own directory.
 * Returns 204 regardless of whether the file existed.
 */
router.delete("/me/avatar/file", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const path = req.body?.path;
  if (typeof path !== "string" || !path.startsWith(`avatars/${user.id}/`)) {
    sendError(res, "invalid_payload", "Invalid or unauthorised path");
    return;
  }

  try {
    await sc.storage.from(AVATAR_BUCKET).remove([path]);
  } catch { /* best-effort: storage may already be gone */ }

  res.status(204).end();
});

/* ---------------------------------------------------------------------------
 * DELETE /me/cover/file — purge an orphaned cover upload
 * ---------------------------------------------------------------------------
 * Same contract as DELETE /me/avatar/file but for cover photos stored at
 * covers/{userId}/cover.{ext}.
 */
router.delete("/me/cover/file", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const path = req.body?.path;
  if (typeof path !== "string" || !path.startsWith(`covers/${user.id}/`)) {
    sendError(res, "invalid_payload", "Invalid or unauthorised path");
    return;
  }

  try {
    await sc.storage.from(AVATAR_BUCKET).remove([path]);
  } catch { /* best-effort */ }

  res.status(204).end();
});

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

/* ---------------------------------------------------------------------------
 * GET /me/account-status — lightweight account health check
 * ---------------------------------------------------------------------------
 * Returns accountStatus ("active" | "deactivated" | "pending_deletion") and,
 * when pending_deletion, the scheduled deletion date.
 * Uses the service client so the read bypasses RLS reliably.
 */
router.get("/me/account-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("account_status")
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr) {
    req.log.error({ err: profileErr }, "account-status: profile query failed");
    sendError(res, "db_error", "Could not load account status");
    return;
  }
  if (!profile) {
    sendError(res, "not_found", "Profile not found");
    return;
  }

  const rawStatus: string = (profile as any).account_status ?? "active";

  // If the profile is deactivated, check whether there is a pending deletion
  // request — if so, surface the more specific "pending_deletion" status so
  // the mobile client can show the correct interstitial.
  if (rawStatus === "deactivated") {
    const { data: deletionRow } = await sc
      .from("user_deletion_requests")
      .select("scheduled_at, status")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .maybeSingle()
      .then(
        (r: any) => r,
        () => ({ data: null }),
      );

    if (deletionRow) {
      res.status(200).json({
        accountStatus: "pending_deletion",
        deletionScheduledAt: (deletionRow as any).scheduled_at ?? null,
      });
      return;
    }
  }

  res.status(200).json({ accountStatus: rawStatus, deletionScheduledAt: null });
});

/* ---------------------------------------------------------------------------
 * POST /me/reactivate — re-activate a self-deactivated account
 * ---------------------------------------------------------------------------
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

  // Cancel any pending deletion request (awaited so that a subsequent
  // GET /me/account-status call does not race with the cancellation write).
  // Fail-open: if the table doesn't exist yet (pre-migration 0094) or the
  // update fails for any reason, the reactivation itself already succeeded.
  await sc.from("user_deletion_requests")
    .update({ status: "cancelled", cancelled_at: now })
    .eq("user_id", user.id)
    .eq("status", "pending")
    .then(undefined, () => {});

  // Secondary writes are best-effort after the primary write succeeds.
  // Note: user_account_states is unique on (user_id, state), so clear the
  // 'deactivated' row rather than upserting on user_id alone. try/catch keeps
  // this fire-and-forget even if the client shim lacks .delete().
  try {
    sc.from("user_account_states")
      .delete()
      .eq("user_id", user.id)
      .eq("state", "deactivated")
      .then(undefined, () => {});
  } catch { /* best-effort */ }

  sc.from("profile_privacy_settings")
    .upsert({ user_id: user.id, allow_profile_discovery: true, updated_at: now }, { onConflict: "user_id" })
    .then(undefined, () => {});

  res.status(200).json({ reactivated: true });
});

/* ---------------------------------------------------------------------------
 * POST /me/deactivate — temporarily deactivate the caller's account
 * ---------------------------------------------------------------------------
 * Sets user_account_states to 'deactivated' and flags discovery off.
 */
router.post("/me/deactivate", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const now = new Date().toISOString();
  // user_account_states is unique on (user_id, state), not user_id alone.
  const { error } = await sc
    .from("user_account_states")
    .upsert({ user_id: user.id, state: "deactivated", updated_at: now }, { onConflict: "user_id,state" });

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

  // Pause Circle sharing on deactivation — server-side, not client-dependent.
  // Sets paused=true on ALL circle_context_settings rows for this user so
  // their presence is hidden even if the client never calls pause-on-session-end.
  // Note: circle_context_settings uses "paused" (not "is_paused"); the global
  //       circle_visibility_settings uses "is_paused".
  sc.from("circle_context_settings")
    .update({ paused: true, updated_at: now })
    .eq("user_id", user.id)
    .then(undefined, (err) => {
      req.log.warn({ err }, "deactivate: failed to pause circle context settings (non-fatal)");
    });

  // Also pause any active presence rows so they stop appearing on other members' maps.
  sc.from("circle_presence")
    .update({ status: "paused", updated_at: now })
    .eq("user_id", user.id)
    .eq("status", "active")
    .then(undefined, () => {});

  res.status(200).json({ deactivated: true });
});

/* ---------------------------------------------------------------------------
 * POST /me/delete-request — schedule account deletion (30-day hold)
 * ---------------------------------------------------------------------------
 * Creates a deletion request record and flags the account as deactivated
 * so it becomes invisible to other users during the hold period.
 */
router.post("/me/delete-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const scheduledAt = new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString();

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
    .upsert({ user_id: user.id, state: "deactivated", updated_at: now }, { onConflict: "user_id,state" })
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

/* ---------------------------------------------------------------------------
 * GET /me/delete-request — check whether a pending deletion request exists
 * ---------------------------------------------------------------------------
 * Returns { pending: true, scheduledAt } if a pending request exists,
 * or { pending: false, scheduledAt: null } otherwise.
 */
router.get("/me/delete-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const { data, error } = await sc
    .from("user_deletion_requests")
    .select("status, scheduled_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "delete-request GET: failed to query");
    sendError(res, "db_error", error.message);
    return;
  }

  const pending = (data as any)?.status === "pending";
  res.status(200).json({
    pending,
    scheduledAt: pending ? (data as any).scheduled_at : null,
  });
});

/* ---------------------------------------------------------------------------
 * DELETE /me/delete-request — cancel a pending account deletion
 * ---------------------------------------------------------------------------
 * Sets user_deletion_requests.status = 'cancelled', cancelled_at = now().
 * Restores profiles.account_status = 'active' and
 * user_account_states.state = 'active'.
 * Returns { cancelled: true }.
 */
router.delete("/me/delete-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // Verify there is actually a pending deletion request to cancel
  const { data: existing, error: fetchErr } = await sc
    .from("user_deletion_requests")
    .select("status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (fetchErr) {
    req.log.error({ err: fetchErr }, "delete-request DELETE: failed to fetch request");
    sendError(res, "db_error", fetchErr.message);
    return;
  }

  if (!existing || (existing as any).status !== "pending") {
    sendError(res, "not_found", "No pending deletion request found");
    return;
  }

  const now = new Date().toISOString();

  // Mark the deletion request as cancelled
  const { error: cancelErr } = await sc
    .from("user_deletion_requests")
    .update({ status: "cancelled", cancelled_at: now })
    .eq("user_id", user.id);

  if (cancelErr) {
    req.log.error({ err: cancelErr }, "delete-request DELETE: failed to cancel");
    sendError(res, "db_error", cancelErr.message);
    return;
  }

  // Restore profile account_status to active (primary write — fail closed)
  const { error: profileErr } = await sc
    .from("profiles")
    .update({ account_status: "active" })
    .eq("id", user.id);

  if (profileErr) {
    req.log.error({ err: profileErr }, "delete-request DELETE: failed to restore profile status");
    sendError(res, "db_error", "Failed to restore account status");
    return;
  }

  // Secondary writes are best-effort after the primary write succeeds.
  // Note: user_account_states is unique on (user_id, state), so clear the
  // 'deactivated' row rather than upserting on user_id alone. try/catch keeps
  // this fire-and-forget even if the client shim lacks .delete().
  try {
    sc.from("user_account_states")
      .delete()
      .eq("user_id", user.id)
      .eq("state", "deactivated")
      .then(undefined, () => {});
  } catch { /* best-effort */ }

  sc.from("profile_privacy_settings")
    .upsert({ user_id: user.id, allow_profile_discovery: true, updated_at: now }, { onConflict: "user_id" })
    .then(undefined, () => {});

  res.status(200).json({ cancelled: true });
});

/* ---------------------------------------------------------------------------
 * POST /internal/deletion-requests/execute-due — deletion worker endpoint
 * ---------------------------------------------------------------------------
 * Service-to-service endpoint (NOT user-facing). Executes the full deletion
 * cascade (services/accountDeletion/AccountDeletionService.ts — the same
 * implementation used by the admin execute route and the in-process
 * scheduler) for every user_deletion_requests row whose 30-day hold has
 * elapsed (scheduled_at <= now, status pending/confirmed).
 *
 * Auth: X-Internal-Secret header must match INTERNAL_API_SECRET — the same
 * fail-closed pattern as routes/notifications.ts requireInternalSecret. When
 * the env var is unset the endpoint is disabled (503).
 *
 * SAFETY: like lib/accountDeletionScheduler.ts, execution is additionally
 * gated behind the `account_deletion_worker_enabled` feature flag and fails
 * CLOSED — when the flag row is missing, unreadable, or false the endpoint
 * responds 503/skipped and touches nothing.
 *
 * SCHEDULING: hit this endpoint once a day via a Replit Scheduled Deployment
 * (or any external cron):
 *   curl -X POST "$API_BASE_URL/api/internal/deletion-requests/execute-due" \
 *        -H "X-Internal-Secret: $INTERNAL_API_SECRET"
 * Batch is capped at 20 per run; the endpoint is idempotent (a request is
 * only marked completed when its cascade fully succeeds, and completed rows
 * are never re-selected — failed ones stay pending for retry), so overlapping
 * runs are safe.
 */
function requireInternalSecret(req: any, res: any): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    res.status(503).json({
      error: "misconfigured",
      message: "INTERNAL_API_SECRET is not set; internal endpoints are disabled",
    });
    return false;
  }
  const provided = req.headers["x-internal-secret"];
  if (!safeSecretEquals(provided, secret)) {
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid internal secret" });
    return false;
  }
  return true;
}

router.post("/internal/deletion-requests/execute-due", async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // Same fail-closed flag gate as lib/accountDeletionScheduler.ts: account
  // deletion is irreversible and this endpoint acts without a human in the
  // loop, so it does nothing until the flag is explicitly enabled.
  if (!(await isFlagEnabled(sc, "account_deletion_worker_enabled"))) {
    res.status(503).json({
      ok: false,
      skipped: true,
      error: "feature_disabled",
      message: "account_deletion_worker_enabled feature flag is off; deletion worker is disabled",
    });
    return;
  }

  const now = new Date().toISOString();
  const BATCH_CAP = 20;

  const { data: due, error: dueErr } = await sc
    .from("user_deletion_requests")
    .select("user_id, scheduled_at, status")
    .in("status", ["pending", "confirmed"])
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .limit(BATCH_CAP);

  if (dueErr) {
    req.log.error({ err: dueErr }, "deletion worker: failed to query due requests");
    sendError(res, "db_error", dueErr.message);
    return;
  }

  let executed = 0;
  const failed: Array<{ userId: string; failedSteps: { step: string; error?: string }[] }> = [];
  const outcomes: Array<Awaited<ReturnType<typeof executeAccountDeletion>>> = [];

  for (const row of (due ?? []) as { user_id: string }[]) {
    const userId = row.user_id;
    try {
      // The service marks the request completed itself — but ONLY when the
      // cascade outcome is ok (profile anonymised + auth user removed). A
      // failed cascade leaves the row pending/confirmed so the next run
      // retries it.
      const outcome = await executeAccountDeletion(sc, userId, {
        actorId: null, // executed by the worker, not an admin
        reason: "Scheduled account deletion executed",
      });
      outcomes.push(outcome);
      if (outcome.ok) {
        executed += 1;
        if (outcome.warnings.length > 0) {
          req.log.warn({ userId, warnings: outcome.warnings }, "deletion worker: completed with warnings");
        }
      } else {
        const failedSteps = outcome.steps.filter((s) => !s.ok).map((s) => ({ step: s.step, error: s.error }));
        failed.push({ userId, failedSteps });
        req.log.error(
          { userId, failedSteps },
          "deletion worker: deletion did not complete; request left pending for retry",
        );
      }
    } catch (err: any) {
      failed.push({ userId, failedSteps: [{ step: "execute", error: err?.message ?? String(err) }] });
      req.log.error({ err, userId }, "deletion worker: executeAccountDeletion threw");
    }
  }

  res.status(200).json({
    ok: true,
    processed: (due ?? []).length,
    executed,
    failed,
    executedAt: now,
    outcomes,
  });
});

/* ---------------------------------------------------------------------------
 * GET /me/privacy — fetch caller's privacy settings
 * ---------------------------------------------------------------------------
 * Returns the profile_privacy_settings row, or defaults if none exists yet.
 */
const PRIVACY_DEFAULTS = {
  profile_visibility: "public",
  // Universal display-name rule: real names are OPT-IN. Default off means
  // every user reference across the app shows @handle only.
  show_real_name: false,
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

/**
 * Fetch the show_profile_picture_publicly flag from the profiles table.
 * Defaults to true (public) when the row or column is absent.
 */
async function fetchShowProfilePicPublicly(sc: ReturnType<typeof getServiceClient>, userId: string): Promise<boolean> {
  if (!sc) return true;
  const { data } = await sc
    .from("profiles")
    .select("show_profile_picture_publicly")
    .eq("id", userId)
    .maybeSingle();
  if (data && typeof data.show_profile_picture_publicly === "boolean") {
    return data.show_profile_picture_publicly;
  }
  return true;
}

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
      const showPicPublicly = await fetchShowProfilePicPublicly(sc, user.id);
      res.status(200).json({ ...PRIVACY_DEFAULTS, user_id: user.id, show_profile_picture_publicly: showPicPublicly });
      return;
    }
    req.log.error({ err: error }, "privacy/get: query failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const showPicPublicly = await fetchShowProfilePicPublicly(sc, user.id);

  if (!data) {
    // First access: persist defaults so PATCH can merge against a real row
    const defaults = { ...PRIVACY_DEFAULTS, user_id: user.id };
    sc.from("profile_privacy_settings")
      .upsert(defaults, { onConflict: "user_id" })
      .then(undefined, (e: any) => req.log.warn({ err: e }, "privacy/get: failed to seed defaults"));
    res.status(200).json({ ...defaults, show_profile_picture_publicly: showPicPublicly });
    return;
  }

  res.status(200).json({ ...data, show_profile_picture_publicly: showPicPublicly });
});

/* ---------------------------------------------------------------------------
 * PATCH /me/privacy — update privacy settings
 * ---------------------------------------------------------------------------
 * Upserts profile_privacy_settings and syncs profile_visibility to
 * user_privacy_settings so the interactionPermissions engine stays consistent.
 */
const patchPrivacySchema = z.object({
  profile_visibility: z.enum(["public", "followers_only", "private"]).optional(),
  show_real_name: z.boolean().optional(),
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
  show_profile_picture_publicly: z.boolean().optional(),
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

  // Fetch existing to merge (prevents overwriting fields not in this PATCH).
  //
  // A FAILED read is not an EMPTY read. supabase-js RESOLVES `{ data, error }`
  // rather than throwing, so a query that fails arrives here as `data: null`
  // with a populated `error` — indistinguishable, if the error is dropped, from
  // "this user has no saved preferences". Merging PRIVACY_DEFAULTS on top of
  // that null and upserting the result would PERSIST the maximally permissive
  // defaults over whatever the user had actually chosen: a user who had hidden
  // their city, home country, trips and stamps, flipping one unrelated switch
  // during a transient DB blip, would have every one of those choices reset to
  // public — and the reset survives the outage, because it was written.
  //
  // So: read the error, and never write a merge built on a read we could not
  // perform. `.then(undefined, ...)` is kept for the rejecting-client case
  // (a thrown network error) and normalised into the same {data, error} shape.
  const existingRes = await sc
    .from("profile_privacy_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle()
    .then(
      (r: any) => r,
      (e: any) => ({ data: null, error: e ?? new Error("privacy settings read rejected") }),
    );
  const existingErr = (existingRes as any)?.error ?? null;
  if (existingErr) {
    req.log.error(
      { err: existingErr },
      "privacy/patch: could not read existing settings — refusing to overwrite them with defaults",
    );
    sendError(
      res,
      "degraded_unavailable",
      "Could not read your current privacy settings, so nothing was changed. Please try again.",
    );
    return;
  }
  const existing = (existingRes as any)?.data ?? null;

  // show_profile_picture_publicly lives on `profiles`, not `profile_privacy_settings`.
  // Extract it before building the upsert row so it never reaches the wrong table.
  const { show_profile_picture_publicly: showPicPublicly, ...privacyFields } = parsed.data;

  const mergedRow = {
    ...PRIVACY_DEFAULTS,
    ...(existing ?? {}),
    ...privacyFields,
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

  // Sync show_profile_picture_publicly to the profiles table when the caller changed it.
  // Column added by migration 20260808_header_image_privacy.sql.
  // Fire-and-forget: a failure here is non-fatal — the caller still gets a 200.
  if (showPicPublicly !== undefined) {
    sc.from("profiles")
      .update({ show_profile_picture_publicly: showPicPublicly, updated_at: now })
      .eq("id", user.id)
      .then(undefined, (e: any) =>
        req.log.warn({ err: e }, "privacy/patch: failed to sync show_profile_picture_publicly to profiles"),
      );
  }

  // Keep user_privacy_settings.profile_visibility in sync
  if (parsed.data.profile_visibility !== undefined) {
    const syncVisibility = parsed.data.profile_visibility === "followers_only"
      ? null   // user_privacy_settings encodes "followers_only" as null (falsy private)
      : parsed.data.profile_visibility;
    sc.from("user_privacy_settings")
      .upsert({ user_id: user.id, profile_visibility: syncVisibility, updated_at: now }, { onConflict: "user_id" })
      .then(undefined, () => {});

    // Keep profiles.is_private in sync so discovery/search exclusion is applied immediately
    sc.from("profiles")
      .update({ is_private: parsed.data.profile_visibility === "private", updated_at: now })
      .eq("id", user.id)
      .then(undefined, (e: any) => req.log.warn({ err: e }, "privacy/patch: failed to sync is_private to profiles"));
  }

  invalidateCompassHomeCache(user.id);

  // Determine the effective show_profile_picture_publicly value for the response.
  // If the caller just changed it, use that value directly; otherwise fetch from profiles.
  const effectiveShowPicPublicly = showPicPublicly !== undefined
    ? showPicPublicly
    : await fetchShowProfilePicPublicly(sc, user.id);

  res.status(200).json({ ...data, show_profile_picture_publicly: effectiveShowPicPublicly });
});

export default router;
