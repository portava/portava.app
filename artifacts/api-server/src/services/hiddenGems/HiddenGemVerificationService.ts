/**
 * HiddenGemVerificationService
 *
 * GPS proximity check-in + community/guide/admin verification events.
 * Anti-spoofing from LocationSafetyService is applied before granting credit.
 * Suspicious check-ins write a review event instead of upgrading the gem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserTrustLevel, checkAndRecordSnapshot } from "../location/LocationSafetyService.js";

const GPS_PROXIMITY_THRESHOLD_M = 200; // within 200 m → valid check-in
const COMMUNITY_CONFIRMATIONS_NEEDED = 5; // upgrades unverified → community

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface GpsCheckinResult {
  ok: boolean;
  visitId: string | null;
  distanceM: number | null;
  withinRange: boolean;
  trustLevel: string;
  isSuspicious: boolean;
  verificationUpgraded: boolean;
  error?: string;
}

/**
 * Record a GPS check-in attempt for a gem.
 * Applies anti-spoofing; returns suspicious = true and writes review event for fake GPS.
 */
export async function recordGpsCheckin(
  db: SupabaseClient,
  gemId: string,
  userId: string,
  userLat: number,
  userLng: number,
): Promise<GpsCheckinResult> {
  // Load gem coords
  const { data: gem, error: gemErr } = await db
    .from("hidden_gems")
    .select("id, latitude, longitude, approx_latitude, approx_longitude, verification_level, status")
    .eq("id", gemId)
    .maybeSingle();

  if (gemErr || !gem) {
    return { ok: false, visitId: null, distanceM: null, withinRange: false, trustLevel: "unknown", isSuspicious: false, verificationUpgraded: false, error: "gem_not_found" };
  }
  if ((gem as any).status !== "active") {
    return { ok: false, visitId: null, distanceM: null, withinRange: false, trustLevel: "unknown", isSuspicious: false, verificationUpgraded: false, error: "gem_not_active" };
  }

  const gemLat: number | null = (gem as any).latitude ?? (gem as any).approx_latitude;
  const gemLng: number | null = (gem as any).longitude ?? (gem as any).approx_longitude;

  let distanceM: number | null = null;
  let withinRange = false;
  if (gemLat != null && gemLng != null) {
    distanceM = Math.round(haversineM(userLat, userLng, gemLat, gemLng));
    withinRange = distanceM <= GPS_PROXIMITY_THRESHOLD_M;
  }

  // Anti-spoofing: (1) snapshot-based coordinate-jump / impossible-speed check at check-in time,
  // (2) historical trust-event review. Either flagging makes the check-in suspicious.
  const [snapshotCheck, userTrust] = await Promise.all([
    checkAndRecordSnapshot(db, userId, userLat, userLng).catch(() => ({ trusted: true })),
    getUserTrustLevel(db, userId),
  ]);
  const isSuspicious = !snapshotCheck.trusted || userTrust !== "trusted";
  const trustLevel = isSuspicious ? "pending_review" : "gps_verified";

  // Record the visit (always — even suspicious, for audit trail)
  const { data: visitRow, error: visitErr } = await db
    .from("hidden_gem_visits")
    .insert({
      gem_id: gemId,
      user_id: userId,
      distance_m: distanceM,
      trust_level: trustLevel,
      is_suspicious: isSuspicious,
      latitude: userLat,
      longitude: userLng,
    })
    .select("id")
    .single();

  const visitId = visitErr ? null : (visitRow as any)?.id ?? null;

  if (!withinRange) {
    return { ok: false, visitId, distanceM, withinRange, trustLevel, isSuspicious, verificationUpgraded: false, error: "too_far" };
  }

  let verificationUpgraded = false;

  if (!isSuspicious) {
    // Record GPS verification event (ignore duplicate constraint)
    try {
      await db
        .from("hidden_gem_verifications")
        .insert({
          gem_id: gemId,
          user_id: userId,
          method: "gps_proximity",
          result: "approved",
          distance_m: distanceM,
        })
        .select("id")
        .single();
    } catch { /* ignore duplicate constraint */ }

    // Check if gem should be upgraded to community level
    const currentLevel = (gem as any).verification_level;
    if (currentLevel === "unverified") {
      const { count } = await db
        .from("hidden_gem_verifications")
        .select("id", { count: "exact", head: true })
        .eq("gem_id", gemId)
        .eq("result", "approved");

      if ((count ?? 0) >= COMMUNITY_CONFIRMATIONS_NEEDED) {
        await db
          .from("hidden_gems")
          .update({ verification_level: "community", updated_at: new Date().toISOString() })
          .eq("id", gemId);
        verificationUpgraded = true;
      }
    }

    // Increment visit_count — direct UPDATE, no RPC dependency
    try {
      const { data: cur } = await db.from("hidden_gems").select("visit_count").eq("id", gemId).maybeSingle();
      const next = ((cur as any)?.visit_count ?? 0) + 1;
      await db.from("hidden_gems").update({ visit_count: next }).eq("id", gemId);
    } catch { /* non-fatal counter drift */ }
  } else {
    // Write manual_review trust event
    try {
      await db
        .from("hidden_gem_verifications")
        .insert({
          gem_id: gemId,
          user_id: userId,
          method: "gps_proximity",
          result: "suspicious",
          distance_m: distanceM,
          notes: "Flagged by anti-spoofing check",
        })
        .select("id")
        .single();
    } catch { /* ignore */ }
  }

  return { ok: true, visitId, distanceM, withinRange, trustLevel, isSuspicious, verificationUpgraded };
}

/** Guide or admin verification event. */
export async function recordGuideVerification(
  db: SupabaseClient,
  gemId: string,
  guideId: string,
  result: "approved" | "rejected",
  notes?: string,
): Promise<void> {
  try {
    await db
      .from("hidden_gem_verifications")
      .insert({
        gem_id: gemId,
        user_id: guideId,
        method: "guide",
        result,
        notes: notes ?? null,
      })
      .select("id")
      .single();
  } catch { /* ignore */ }

  if (result === "approved") {
    await db
      .from("hidden_gems")
      .update({
        verification_level: "guide",
        guide_verified_by: guideId,
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", gemId);
  }
}

/** Admin final verification. */
export async function recordAdminVerification(
  db: SupabaseClient,
  gemId: string,
  adminId: string,
  result: "approved" | "rejected" | "hidden",
  notes?: string,
): Promise<void> {
  try {
    await db
      .from("hidden_gem_verifications")
      .insert({
        gem_id: gemId,
        user_id: adminId,
        method: "admin",
        result: result === "hidden" ? "rejected" : result,
        notes: notes ?? null,
      })
      .select("id")
      .single();
  } catch { /* ignore */ }

  const newStatus = result === "approved" ? "active" : result === "hidden" ? "hidden" : "hidden";
  const newVerificationLevel = result === "approved" ? "admin" : undefined;

  const patch: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (newVerificationLevel) patch.verification_level = newVerificationLevel;

  await db.from("hidden_gems").update(patch).eq("id", gemId);
}
