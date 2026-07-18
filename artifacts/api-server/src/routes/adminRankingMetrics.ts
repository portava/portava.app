/**
 * GET /api/admin/ranking/metrics
 *
 * Returns the §9 algorithm health metrics from rank_events for the past N days.
 * Admin role required.
 *
 * Query params:
 *   days  — look-back window in days (default 7, max 90)
 *
 * Response shape:
 * {
 *   period_days, impressions, taps, saves, joins, rsvps, attended,
 *   realized_connection_rate,   // (joins + rsvps) / impressions
 *   tap_through_rate,           // taps / impressions
 *   tap_through_by_kind: { [kind]: { impressions, taps, rate } },
 *   exploration_slot: { impressions, taps, rate },   // positions where pos % 7 === 6
 *   by_surface: { [surface]: { impressions, taps } },
 * }
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";

const router = Router();

async function requireAdmin(req: any, res: any): Promise<{ sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  const sc = getServiceClient() ?? client;
  return { sc };
}

router.get("/admin/ranking/metrics", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const rawDays = parseInt((req.query.days as string) ?? "7");
  const days = Math.min(90, Math.max(1, isNaN(rawDays) ? 7 : rawDays));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  // Fetch all rank_events rows in the window — small during beta, aggregate in JS.
  const { data: rows, error } = await sc
    .from("rank_events")
    .select("outcome, item_kind, position, surface")
    .gte("served_at", cutoff);

  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  const all = (rows as any[]) ?? [];

  // ── Totals ──────────────────────────────────────────────────────────────────
  const totals = { impressions: 0, taps: 0, saves: 0, joins: 0, rsvps: 0, attended: 0 };
  for (const r of all) {
    const o: string = r.outcome ?? "";
    if (o === "impression") totals.impressions++;
    else if (o === "tap")        totals.taps++;
    else if (o === "save")       totals.saves++;
    else if (o === "join")       totals.joins++;
    else if (o === "rsvp")       totals.rsvps++;
    else if (o === "attended")   totals.attended++;
  }

  const safe = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000);

  // ── By kind ─────────────────────────────────────────────────────────────────
  const kindMap: Record<string, { impressions: number; taps: number }> = {};
  for (const r of all) {
    const k: string = r.item_kind ?? "unknown";
    if (!kindMap[k]) kindMap[k] = { impressions: 0, taps: 0 };
    if (r.outcome === "impression") kindMap[k].impressions++;
    else if (r.outcome === "tap")   kindMap[k].taps++;
  }
  const tap_through_by_kind: Record<string, { impressions: number; taps: number; rate: number }> = {};
  for (const [k, v] of Object.entries(kindMap)) {
    tap_through_by_kind[k] = { ...v, rate: safe(v.taps, v.impressions) };
  }

  // ── Exploration slots (every 7th position: 6, 13, 20 …) ──────────────────
  const explRows = all.filter((r) => typeof r.position === "number" && r.position % 7 === 6);
  const explImpressions = explRows.filter((r) => r.outcome === "impression").length;
  const explTaps        = explRows.filter((r) => r.outcome === "tap").length;

  // ── By surface ───────────────────────────────────────────────────────────────
  const surfaceMap: Record<string, { impressions: number; taps: number }> = {};
  for (const r of all) {
    const s: string = r.surface ?? "unknown";
    if (!surfaceMap[s]) surfaceMap[s] = { impressions: 0, taps: 0 };
    if (r.outcome === "impression") surfaceMap[s].impressions++;
    else if (r.outcome === "tap")   surfaceMap[s].taps++;
  }

  res.json({
    period_days: days,
    ...totals,
    realized_connection_rate: safe(totals.joins + totals.rsvps, totals.impressions),
    tap_through_rate:         safe(totals.taps, totals.impressions),
    tap_through_by_kind,
    exploration_slot: {
      impressions: explImpressions,
      taps:        explTaps,
      rate:        safe(explTaps, explImpressions),
    },
    by_surface: surfaceMap,
  });
});

export default router;
