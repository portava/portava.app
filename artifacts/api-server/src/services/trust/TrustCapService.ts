/**
 * TrustCapService
 *
 * Creates, enforces, and expires score caps per category.
 * Caps prevent easy positive actions from hiding serious negative behaviour.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrustCategory } from "./TrustEventService.js";

export interface CreateCapInput {
  userId: string;
  category: TrustCategory;
  ceilingScore: number;
  reasonCode: string;
  sourceEventId?: string;
  /** ISO string; null = permanent until admin lifts */
  expiresAt?: string | null;
}

export interface TrustCap {
  id: string;
  userId: string;
  category: string;
  ceilingScore: number;
  reasonCode: string;
  sourceEventId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** Create a new cap (or tighten existing one for same category/reasonCode) */
export async function createCap(
  db: SupabaseClient,
  input: CreateCapInput,
): Promise<TrustCap> {
  const { data, error } = await db
    .from("trust_caps")
    .insert({
      user_id:         input.userId,
      category:        input.category,
      ceiling_score:   input.ceilingScore,
      reason_code:     input.reasonCode,
      source_event_id: input.sourceEventId ?? null,
      expires_at:      input.expiresAt ?? null,
    })
    .select("id, user_id, category, ceiling_score, reason_code, source_event_id, expires_at, created_at")
    .single();

  if (error) throw new Error(`createCap DB error: ${error.message}`);
  const d = data as any;
  return {
    id:            d.id,
    userId:        d.user_id,
    category:      d.category,
    ceilingScore:  d.ceiling_score,
    reasonCode:    d.reason_code,
    sourceEventId: d.source_event_id,
    expiresAt:     d.expires_at,
    createdAt:     d.created_at,
  };
}

/** Lift a specific cap (admin or expiry) */
export async function liftCap(
  db: SupabaseClient,
  capId: string,
  liftedBy: string,
): Promise<void> {
  const { error } = await db
    .from("trust_caps")
    .update({ lifted_at: new Date().toISOString(), lifted_by: liftedBy })
    .eq("id", capId)
    .is("lifted_at", null);
  if (error) throw new Error(`liftCap DB error: ${error.message}`);
}

/** Expire all caps whose expires_at has passed (call from cleanup job) */
export async function expireOldCaps(db: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await db
      .from("trust_caps")
      .update({ lifted_at: new Date().toISOString() })
      .lt("expires_at", new Date().toISOString())
      .is("lifted_at", null)
      .select("id");
    if (error) return 0;
    return (data as any[])?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Get all active caps for a user */
export async function getActiveCaps(
  db: SupabaseClient,
  userId: string,
): Promise<TrustCap[]> {
  try {
    const now = new Date().toISOString();
    const { data } = await db
      .from("trust_caps")
      .select("id, user_id, category, ceiling_score, reason_code, source_event_id, expires_at, created_at")
      .eq("user_id", userId)
      .is("lifted_at", null)
      .or(`expires_at.is.null,expires_at.gt.${now}`);
    return ((data as any[]) ?? []).map((d) => ({
      id:            d.id,
      userId:        d.user_id,
      category:      d.category,
      ceilingScore:  d.ceiling_score,
      reasonCode:    d.reason_code,
      sourceEventId: d.source_event_id,
      expiresAt:     d.expires_at,
      createdAt:     d.created_at,
    }));
  } catch {
    return [];
  }
}

/** Apply caps triggered by a confirmed serious event */
export async function applyEventCaps(
  db: SupabaseClient,
  userId: string,
  eventType: string,
  severity: string,
  eventId: string,
): Promise<void> {
  // Standard caps by event type
  const capMap: Record<string, { category: TrustCategory; ceiling: number; reasonCode: string; expiresInDays?: number }[]> = {
    PLAN_NO_SHOW:              [{ category: "plan_attendance",  ceiling: 60, reasonCode: "no_show",              expiresInDays: 30 }],
    BEHAVIOR_REPORT_CONFIRMED: [{ category: "respect_safety",   ceiling: 40, reasonCode: "behavior_confirmed"                      },
                                { category: "hosting",          ceiling: 30, reasonCode: "behavior_confirmed" } as any],
    FAKE_GPS_CONFIRMED:        [{ category: "location_honesty", ceiling: 35, reasonCode: "fake_gps_confirmed"                      }],
    GPS_IMPOSSIBLE_SPEED:      [{ category: "location_honesty", ceiling: 55, reasonCode: "impossible_speed",     expiresInDays: 14 }],
    CONTENT_REMOVED:           [{ category: "content_quality",  ceiling: 50, reasonCode: "content_removed",      expiresInDays: 30 }],
    MESSAGE_REPORT_CONFIRMED:  [{ category: "communication",    ceiling: 45, reasonCode: "message_report",       expiresInDays: 60 }],
  };

  const toApply = capMap[eventType] ?? [];
  // For severe events, also cap overall by restricting the primary category to 40
  if (severity === "severe" && toApply.length === 0) {
    toApply.push({ category: "respect_safety", ceiling: 40, reasonCode: `severe_${eventType.toLowerCase()}` });
  }

  for (const cap of toApply) {
    const expiresAt = cap.expiresInDays
      ? new Date(Date.now() + cap.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    await createCap(db, {
      userId,
      category:      (cap as any).category as TrustCategory,
      ceilingScore:  cap.ceiling,
      reasonCode:    cap.reasonCode,
      sourceEventId: eventId,
      expiresAt,
    }).catch(() => {/* non-fatal */});
  }
}
