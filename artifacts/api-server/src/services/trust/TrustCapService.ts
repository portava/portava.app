/**
 * TrustCapService
 *
 * Creates, enforces, and expires score caps per category.
 * Caps prevent easy positive actions from hiding serious negative behaviour.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrustCategory } from "./TrustEventService.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "TrustCapService" });

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

/**
 * Lift every active cap that originated from one of `sourceEventIds`.
 *
 * This is the reversal half of applyEventCaps, and it did not exist. Caps are
 * how a serious finding actually bites — the ceiling, not the delta, is what
 * survives a long good history — and `behavior_report_confirmed` writes a
 * respect_safety ceiling of 40 with NO expiry. So before this, un-banning a user
 * left that ceiling standing permanently: the sanction was reversible and its
 * trust consequence was not.
 *
 * Keyed on source_event_id rather than on the user, so lifting the consequence
 * of ONE reversed finding cannot silently clear an unrelated one that still
 * stands.
 *
 * Never throws — a reversal must not fail because its bookkeeping did.
 *
 * ── WHY THIS RETURNS A RESULT AND NOT A NUMBER ──────────────────────────────
 * It used to return `number`, and returned 0 both when there was nothing to lift
 * and when the UPDATE errored. Those are opposite facts. `behavior_confirmed`
 * writes a respect_safety ceiling of 40 with NO expiry and no other code path
 * ever lifts it, so a failed lift reported as 0 meant: the admin restored the
 * account, the API answered success, and the permanent ceiling stayed — the
 * exact permanent-consequence-of-a-reversed-sanction this function was written
 * to prevent, reintroduced through its own error handling. `failed` makes the
 * two distinguishable so the caller can say so.
 */
export interface LiftCapsResult {
  /** Caps this call actually lifted. Meaningful only when `failed` is false. */
  lifted: number;
  /** True when the lift could not be performed. DISTINCT from lifted:0. */
  failed: boolean;
}

export async function liftCapsBySourceEvents(
  db: SupabaseClient,
  sourceEventIds: readonly string[],
  liftedBy: string,
): Promise<LiftCapsResult> {
  if (sourceEventIds.length === 0) return { lifted: 0, failed: false };
  try {
    const { data, error } = await db
      .from("trust_caps")
      .update({ lifted_at: new Date().toISOString(), lifted_by: liftedBy })
      .in("source_event_id", sourceEventIds as string[])
      .is("lifted_at", null)
      .select("id");
    if (error) {
      logger.warn({ err: error, sourceEvents: sourceEventIds.length }, "liftCapsBySourceEvents failed — ceilings may still stand");
      return { lifted: 0, failed: true };
    }
    return { lifted: ((data as any[]) ?? []).length, failed: false };
  } catch (err) {
    logger.warn({ err, sourceEvents: sourceEventIds.length }, "liftCapsBySourceEvents threw — ceilings may still stand");
    return { lifted: 0, failed: true };
  }
}

export interface ActiveCapsResult {
  caps: TrustCap[];
  /**
   * True when trust_caps could not be read. DISTINCT from `caps: []`.
   *
   * "This user has no ceilings" and "I could not find out whether this user has
   * ceilings" are opposite facts about a moderation subject, and the empty array
   * asserted the first while meaning the second — the old body destructured
   * `const { data }` and dropped `error` entirely, and supabase-js RETURNS
   * errors rather than throwing, so every failure became a clean empty list.
   */
  failed: boolean;
}

/**
 * Get all active caps for a user, saying whether the read succeeded.
 *
 * Prefer this over `getActiveCaps` anywhere the answer informs a decision or is
 * shown to an admin: a silently-empty cap list reads as "nothing is holding this
 * account down", which is the single most misleading thing this table can say.
 */
export async function getActiveCapsResult(
  db: SupabaseClient,
  userId: string,
): Promise<ActiveCapsResult> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("trust_caps")
      .select("id, user_id, category, ceiling_score, reason_code, source_event_id, expires_at, created_at")
      .eq("user_id", userId)
      .is("lifted_at", null)
      .or(`expires_at.is.null,expires_at.gt.${now}`);
    if (error) {
      logger.warn({ err: error, userId }, "getActiveCaps read failed — cap list is unknown, not empty");
      return { caps: [], failed: true };
    }
    return {
      caps: ((data as any[]) ?? []).map((d) => ({
        id:            d.id,
        userId:        d.user_id,
        category:      d.category,
        ceilingScore:  d.ceiling_score,
        reasonCode:    d.reason_code,
        sourceEventId: d.source_event_id,
        expiresAt:     d.expires_at,
        createdAt:     d.created_at,
      })),
      failed: false,
    };
  } catch (err) {
    logger.warn({ err, userId }, "getActiveCaps threw — cap list is unknown, not empty");
    return { caps: [], failed: true };
  }
}

/**
 * Array-only view of {@link getActiveCapsResult}, kept for call sites that have
 * no way to render the difference. It cannot distinguish a failed read from an
 * uncapped user — use getActiveCapsResult wherever that distinction can be shown.
 */
export async function getActiveCaps(
  db: SupabaseClient,
  userId: string,
): Promise<TrustCap[]> {
  return (await getActiveCapsResult(db, userId)).caps;
}

/** Apply caps triggered by a confirmed serious event */
export async function applyEventCaps(
  db: SupabaseClient,
  userId: string,
  eventType: string,
  severity: string,
  eventId: string,
): Promise<void> {
  // Standard caps by event type.
  // Keys are lowercase — callers must have already lowercased eventType
  // (TrustEventService.recordTrustEvent normalizes on entry; confirmEvent passes the
  // stored value which is always lowercase after that normalization).
  const capMap: Record<string, { category: TrustCategory; ceiling: number; reasonCode: string; expiresInDays?: number }[]> = {
    plan_no_show:              [{ category: "plan_attendance",  ceiling: 60, reasonCode: "no_show",              expiresInDays: 30 }],
    behavior_report_confirmed: [{ category: "respect_safety",  ceiling: 40, reasonCode: "behavior_confirmed" }],
    fake_gps_confirmed:        [{ category: "location_honesty", ceiling: 35, reasonCode: "fake_gps_confirmed"                      }],
    gps_impossible_speed:      [{ category: "location_honesty", ceiling: 55, reasonCode: "impossible_speed",     expiresInDays: 14 }],
    coordinate_jump:           [{ category: "location_honesty", ceiling: 55, reasonCode: "coordinate_jump",      expiresInDays: 7  }],
    content_removed:           [{ category: "content_quality",  ceiling: 50, reasonCode: "content_removed",      expiresInDays: 30 }],
    message_report_confirmed:  [{ category: "communication",    ceiling: 45, reasonCode: "message_report",       expiresInDays: 60 }],
  };

  // Normalize so callers that pass uppercase names still work
  const normalizedType = eventType.toLowerCase();
  const toApply = capMap[normalizedType] ?? [];
  // For severe events, also cap respect_safety to 40 if no specific map entry
  if (severity === "severe" && toApply.length === 0) {
    toApply.push({ category: "respect_safety", ceiling: 40, reasonCode: `severe_${normalizedType}` });
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
