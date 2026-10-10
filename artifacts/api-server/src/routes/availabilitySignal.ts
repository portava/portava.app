/**
 * Telegraph §4.1 / §4.3 — the doors that write the AvailabilitySignal contract (census-telegraph T22,
 * T23, T27; migration 3652). Every route answers 404 `feature_disabled` unless
 * `availability_signal_contract_enabled` is ON (seeded FALSE; an unreadable flag reads as off here,
 * because these doors only ever write a person's OWN choices and refusing them is the safe side).
 *
 *   GET/PUT  /me/nearby-consent                       — NEARBY as its own opt-in (T22)
 *   GET/POST /me/availability-audience-policies       — the owner's named audiences (T23; P-T10)
 *   PATCH    /me/availability-windows/:windowId/signal — a window's audiencePolicyId, proximityVisibility
 *                                                       and geographyScope (T23)
 *   GET      /me/eta-grants, PUT/DELETE /me/eta-grants/:userId — the time-boxed mutual ETA grant (T27)
 *
 * All four tables are service-role only (3652 REVOKEs every client privilege), so these routes are the
 * only writers. Each write is the caller's own row: a window is updated only when the caller owns it,
 * a policy can be attached only when the caller owns it (3652's composite foreign key says the same),
 * and an ETA grant is always FROM the caller. A grant to someone in a block with the caller, either
 * way, is refused — and an unreadable block state refuses it too.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { isUuid } from "../lib/followDecisions.js";
import { readPairExclusion } from "../lib/exclusionSet.js";
import {
  AUDIENCES,
  GEOGRAPHY_SCOPES,
  PROXIMITY_RUNGS,
} from "../services/telegraph/availabilitySignalContract.js";

const router = Router();

/** T27: a grant lasts at most this long (3652 CHECKs the same bound). */
export const MAX_ETA_GRANT_HOURS = 12;

async function gate(req: any, res: any): Promise<{ db: any; userId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const db = getServiceClient();
  if (!db) {
    sendError(res, "server_not_configured");
    return null;
  }
  if (!(await isFlagEnabled(db, "availability_signal_contract_enabled"))) { // SIGNAL_CONTRACT_FLAG, as a literal for check:flag-polarity
    sendError(res, "feature_disabled", "This is not available yet.");
    return null;
  }
  return { db, userId: auth.user.id };
}

// ── T22: the Nearby opt-in ────────────────────────────────────────────────────

router.get(
  "/me/nearby-consent",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const { data, error } = await g.db.from("nearby_consents").select("opted_in, updated_at").eq("user_id", g.userId).maybeSingle();
    if (error) {
      sendError(res, "degraded_unavailable", "Your Nearby setting could not be read.");
      return;
    }
    res.json({ optedIn: (data as any)?.opted_in === true, updatedAt: (data as any)?.updated_at ?? null });
  }),
);

router.put(
  "/me/nearby-consent",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const optedIn = (req.body as any)?.optedIn;
    if (typeof optedIn !== "boolean") {
      sendError(res, "invalid_payload", "optedIn must be true or false.");
      return;
    }
    const { error } = await g.db
      .from("nearby_consents")
      .upsert({ user_id: g.userId, opted_in: optedIn, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) {
      sendError(res, "degraded_unavailable", "Your Nearby setting could not be saved.");
      return;
    }
    res.json({ optedIn });
  }),
);

// ── T23: audience policies (proposed ruling P-T10) ───────────────────────────

router.get(
  "/me/availability-audience-policies",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const { data, error } = await g.db
      .from("availability_audience_policies")
      .select("id, audience, created_at")
      .eq("owner_id", g.userId)
      .order("created_at", { ascending: true });
    if (error) {
      sendError(res, "degraded_unavailable", "Your audiences could not be read.");
      return;
    }
    res.json({
      // A window with no policy has this audience (P-T10). Nothing wider without an explicit choice.
      defaultAudience: "mutual_follow_and_crew",
      policies: ((data ?? []) as any[]).map((p) => ({ id: p.id, audience: p.audience })),
    });
  }),
);

router.post(
  "/me/availability-audience-policies",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const audience = (req.body as any)?.audience;
    if (typeof audience !== "string" || !(AUDIENCES as readonly string[]).includes(audience)) {
      sendError(res, "invalid_payload", `audience must be one of ${AUDIENCES.join(", ")}.`);
      return;
    }
    const { data, error } = await g.db
      .from("availability_audience_policies")
      .insert({ owner_id: g.userId, audience })
      .select("id, audience")
      .maybeSingle();
    if (error || !data) {
      sendError(res, "degraded_unavailable", "The audience could not be saved.");
      return;
    }
    res.status(201).json({ id: (data as any).id, audience: (data as any).audience });
  }),
);

// ── T23: a window's signal fields ────────────────────────────────────────────

router.patch(
  "/me/availability-windows/:windowId/signal",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const { windowId } = req.params;
    if (!isUuid(windowId)) {
      sendError(res, "invalid_payload", "Invalid windowId.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if ("proximityVisibility" in body) {
      if (typeof body.proximityVisibility !== "string" || !(PROXIMITY_RUNGS as readonly string[]).includes(body.proximityVisibility)) {
        sendError(res, "invalid_payload", `proximityVisibility must be one of ${PROXIMITY_RUNGS.join(", ")}.`);
        return;
      }
      patch.proximity_visibility = body.proximityVisibility;
    }
    if ("geographyScope" in body) {
      const s = body.geographyScope;
      if (s !== null && (typeof s !== "string" || !(GEOGRAPHY_SCOPES as readonly string[]).includes(s))) {
        sendError(res, "invalid_payload", `geographyScope must be null or one of ${GEOGRAPHY_SCOPES.join(", ")}.`);
        return;
      }
      patch.geography_scope = s;
    }
    if ("audiencePolicyId" in body) {
      const id = body.audiencePolicyId;
      if (id !== null && (typeof id !== "string" || !isUuid(id))) {
        sendError(res, "invalid_payload", "audiencePolicyId must be null (the default audience) or a policy id.");
        return;
      }
      if (typeof id === "string") {
        const { data: pol, error: polErr } = await g.db
          .from("availability_audience_policies")
          .select("id, owner_id")
          .eq("id", id)
          .maybeSingle();
        if (polErr) {
          sendError(res, "degraded_unavailable", "The audience could not be checked.");
          return;
        }
        if (!pol || (pol as any).owner_id !== g.userId) {
          sendError(res, "not_found", "Audience not found.");
          return;
        }
      }
      patch.audience_policy_id = id;
    }
    if (Object.keys(patch).length === 0) {
      sendError(res, "invalid_payload", "Nothing to change.");
      return;
    }
    const { data: win, error: winErr } = await g.db
      .from("availability_windows")
      .select("id, user_id")
      .eq("id", windowId)
      .maybeSingle();
    if (winErr) {
      sendError(res, "degraded_unavailable", "The window could not be read.");
      return;
    }
    if (!win || (win as any).user_id !== g.userId) {
      sendError(res, "not_found", "Window not found.");
      return;
    }
    const { data: updated, error: upErr } = await g.db
      .from("availability_windows")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", windowId)
      .eq("user_id", g.userId)
      .select("id, audience_policy_id, proximity_visibility, geography_scope")
      .maybeSingle();
    if (upErr || !updated) {
      sendError(res, "degraded_unavailable", "The window could not be saved.");
      return;
    }
    res.json({
      id: (updated as any).id,
      audiencePolicyId: (updated as any).audience_policy_id ?? null,
      proximityVisibility: (updated as any).proximity_visibility,
      geographyScope: (updated as any).geography_scope ?? null,
    });
  }),
);

// ── T27: the mutual ETA grant ─────────────────────────────────────────────────

router.get(
  "/me/eta-grants",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const nowIso = new Date().toISOString();
    const [given, received] = await Promise.all([
      g.db.from("eta_coordination_grants").select("grantee_id, expires_at").eq("grantor_id", g.userId).gt("expires_at", nowIso),
      g.db.from("eta_coordination_grants").select("grantor_id, expires_at").eq("grantee_id", g.userId).gt("expires_at", nowIso),
    ]);
    if (given.error || received.error) {
      sendError(res, "degraded_unavailable", "Your ETA grants could not be read.");
      return;
    }
    const toMe = new Set(((received.data ?? []) as any[]).map((r) => String(r.grantor_id)));
    res.json({
      // Only the caller's OWN grants are listed; `mutual` says whether that person granted back.
      grants: ((given.data ?? []) as any[]).map((r) => ({
        userId: r.grantee_id,
        expiresAt: r.expires_at,
        mutual: toMe.has(String(r.grantee_id)),
      })),
    });
  }),
);

router.put(
  "/me/eta-grants/:userId",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const { userId } = req.params;
    if (!isUuid(userId) || userId === g.userId) {
      sendError(res, "invalid_payload", "Choose someone else.");
      return;
    }
    const hours = (req.body as any)?.hours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > MAX_ETA_GRANT_HOURS) {
      sendError(res, "invalid_payload", `hours must be a whole number from 1 to ${MAX_ETA_GRANT_HOURS}.`);
      return;
    }
    const pair = await readPairExclusion(g.db, g.userId, userId);
    if (!pair.ok) {
      sendError(res, "degraded_unavailable", "This could not be checked right now.");
      return;
    }
    if (pair.ids.size > 0) {
      sendError(res, "not_found", "That person is not available.");
      return;
    }
    const now = Date.now();
    const { error } = await g.db.from("eta_coordination_grants").upsert(
      {
        grantor_id: g.userId,
        grantee_id: userId,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + hours * 3_600_000).toISOString(),
      },
      { onConflict: "grantor_id,grantee_id" },
    );
    if (error) {
      sendError(res, "degraded_unavailable", "The grant could not be saved.");
      return;
    }
    res.json({ userId, expiresAt: new Date(now + hours * 3_600_000).toISOString() });
  }),
);

router.delete(
  "/me/eta-grants/:userId",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const { userId } = req.params;
    if (!isUuid(userId)) {
      sendError(res, "invalid_payload", "Invalid userId.");
      return;
    }
    const { error } = await g.db.from("eta_coordination_grants").delete().eq("grantor_id", g.userId).eq("grantee_id", userId);
    if (error) {
      sendError(res, "degraded_unavailable", "The grant could not be withdrawn.");
      return;
    }
    res.json({ userId, withdrawn: true });
  }),
);

export default router;
