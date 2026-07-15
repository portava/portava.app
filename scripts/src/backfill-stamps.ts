/**
 * backfill-stamps.ts — Passport stamp backfill via StampAwardEngine.
 *
 * In LIVE mode each award is sent through POST /api/stamps/award — the same
 * internal HTTP endpoint all route triggers use — so awards go through
 * StampAwardEngine.awardStamp() with full idempotency and policy checks.
 *
 * In DRY-RUN mode the script only queries the DB to identify eligible candidates
 * and checks whether they already have an award event — no writes occur.
 *
 * Usage:
 *   tsx ./src/backfill-stamps.ts                    # dry run (default — no writes)
 *   tsx ./src/backfill-stamps.ts --dry-run           # same as default
 *   tsx ./src/backfill-stamps.ts --apply             # live (applies all awards)
 *   tsx ./src/backfill-stamps.ts --apply --user=<uid>
 *   tsx ./src/backfill-stamps.ts --apply --slug=first_trip_created
 *   tsx ./src/backfill-stamps.ts --dry-run --user=<uid>
 *   tsx ./src/backfill-stamps.ts --dry-run --slug=first_trip_created
 *
 * Required env vars (dry-run / default mode):
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key for DB queries
 *
 * Additional env vars required for --apply (live) mode:
 *   INTERNAL_API_SECRET       — must match INTERNAL_API_SECRET in api-server
 *   API_PORT                  — api-server port (default: 8080)
 */

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const APPLY    = process.argv.includes("--apply");
const DRY_RUN  = !APPLY; // default: dry-run; pass --apply to write awards
const USER_ARG = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const SLUG_ARG = process.argv.find((a) => a.startsWith("--slug="))?.split("=")[1];

// ── Env ───────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INTERNAL_SECRET      = process.env.INTERNAL_API_SECRET;
const API_PORT             = process.env.API_PORT ?? "8080";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

if (APPLY && !INTERNAL_SECRET) {
  console.error("ERROR: INTERNAL_API_SECRET is required for --apply mode (start the api-server first).");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface Candidate {
  userId:     string;
  sourceType: string;
  sourceId:   string;
  city?:      string;
  country?:   string;
}

interface BackfillRule {
  slug:        string;
  description: string;
  candidates(): Promise<Candidate[]>;
}

interface ReportRow {
  userId:     string;
  slug:       string;
  sourceType: string;
  result:     "awarded" | "skipped" | "dry_run_eligible" | "dry_run_skip" | "error";
  reason:     string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the first qualifying row per distinct user, ordered oldest-first. */
async function firstPerUser<T extends Record<string, any>>(
  query: any,
  userKey: string,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of (data ?? []) as T[]) {
    const uid: string = r[userKey];
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(r);
  }
  return out;
}

/**
 * Check the idempotency_key column in stamp_award_events to see whether this
 * (user, definition, sourceType, sourceId) combination was already awarded.
 * Used exclusively in dry-run mode to report pre-existing awards.
 */
async function alreadyAwarded(
  userId: string,
  definitionSlug: string,
  sourceType: string,
  sourceId: string,
): Promise<boolean> {
  // Resolve definition id for the idempotency key
  const { data: def } = await db
    .from("stamp_definitions")
    .select("id")
    .eq("slug", definitionSlug)
    .eq("is_active", true)
    .maybeSingle();
  const defId: string | undefined = (def as any)?.id;
  if (!defId) return false;

  const key = `${userId}:${defId}:${sourceType}:${sourceId}`;
  const { data } = await db
    .from("stamp_award_events")
    .select("id")
    .eq("idempotency_key", key)
    .maybeSingle();
  return !!data;
}

/**
 * Check whether the definition exists and is active.
 * Dry-run warns when it doesn't so the operator knows to add the DB row first.
 */
async function definitionExists(slug: string): Promise<boolean> {
  const { data } = await db
    .from("stamp_definitions")
    .select("id")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  return !!(data as any)?.id;
}

/**
 * POST to the internal /api/stamps/award endpoint — same path all live triggers
 * use — so awards go through StampAwardEngine.awardStamp() with full policy checks.
 */
async function callAwardEndpoint(
  c: Candidate & { definitionSlug: string },
): Promise<{ awarded: boolean; reason: string }> {
  const res = await fetch(`http://localhost:${API_PORT}/api/stamps/award`, {
    method: "POST",
    headers: {
      "Content-Type":     "application/json",
      "X-Internal-Secret": INTERNAL_SECRET!,
    },
    body: JSON.stringify({
      userId:        c.userId,
      definitionSlug: c.definitionSlug,
      sourceType:    c.sourceType,
      sourceId:      c.sourceId,
      city:          c.city,
      country:       c.country,
      awardReason:   "backfill",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  }

  return res.json() as Promise<{ awarded: boolean; reason: string }>;
}

// ── Backfill rules ────────────────────────────────────────────────────────────

const RULES: BackfillRule[] = [
  // ── Trip stamps ─────────────────────────────────────────────────────────────
  {
    slug: "first_trip_created",
    description: "Users who created at least one non-draft, non-cancelled, non-deleted trip",
    async candidates() {
      let q = db
        .from("trips")
        .select("owner_id, id, destination_city, destination_country")
        // Exclude draft/cancelled/deleted/disputed per award exclusion policy
        .in("status", ["planning", "upcoming", "active", "completed"])
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("owner_id", USER_ARG);
      return firstPerUser<any>(q, "owner_id").then((rows) =>
        rows.map((r) => ({
          userId: r.owner_id,
          sourceType: "trips",
          sourceId: r.id,
          city:    r.destination_city    ?? undefined,
          country: r.destination_country ?? undefined,
        })),
      );
    },
  },
  {
    slug: "first_trip_completed",
    description: "Users who completed at least one trip",
    async candidates() {
      let q = db
        .from("trips")
        .select("owner_id, id, destination_city, destination_country")
        .eq("status", "completed")
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("owner_id", USER_ARG);
      return firstPerUser<any>(q, "owner_id").then((rows) =>
        rows.map((r) => ({
          userId: r.owner_id,
          sourceType: "trips",
          sourceId: r.id,
          city:    r.destination_city    ?? undefined,
          country: r.destination_country ?? undefined,
        })),
      );
    },
  },
  {
    slug: "solo_traveler",
    description: "Users who completed a solo trip (1 member)",
    async candidates() {
      const { data: trips } = await db
        .from("trips")
        .select("id, owner_id, destination_city, destination_country")
        .eq("status", "completed")
        .order("created_at", { ascending: true });

      const out: Candidate[] = [];
      const seen = new Set<string>();
      for (const trip of (trips ?? []) as any[]) {
        if (USER_ARG && trip.owner_id !== USER_ARG) continue;
        if (seen.has(trip.owner_id)) continue;
        const { count } = await db
          .from("trip_members")
          .select("id", { count: "exact", head: true })
          .eq("trip_id", trip.id)
          .in("role", ["owner", "member"]);
        if ((count ?? 0) === 1) {
          seen.add(trip.owner_id);
          out.push({ userId: trip.owner_id, sourceType: "trips", sourceId: trip.id, city: trip.destination_city ?? undefined, country: trip.destination_country ?? undefined });
        }
      }
      return out;
    },
  },
  {
    slug: "group_tripper",
    description: "Trip owners who completed a group trip (3+ members)",
    async candidates() {
      const { data: trips } = await db
        .from("trips")
        .select("id, owner_id, destination_city, destination_country")
        .eq("status", "completed")
        .order("created_at", { ascending: true });

      const out: Candidate[] = [];
      const seen = new Set<string>();
      for (const trip of (trips ?? []) as any[]) {
        if (USER_ARG && trip.owner_id !== USER_ARG) continue;
        if (seen.has(trip.owner_id)) continue;
        const { count } = await db
          .from("trip_members")
          .select("id", { count: "exact", head: true })
          .eq("trip_id", trip.id)
          .in("role", ["owner", "member"]);
        if ((count ?? 0) >= 3) {
          seen.add(trip.owner_id);
          out.push({ userId: trip.owner_id, sourceType: "trips", sourceId: trip.id, city: trip.destination_city ?? undefined, country: trip.destination_country ?? undefined });
        }
      }
      return out;
    },
  },
  {
    slug: "weekend_wanderer",
    description: "Users who completed a weekend trip (≤3 days spanning a Sat or Sun)",
    async candidates() {
      let q = db
        .from("trips")
        .select("owner_id, id, destination_city, destination_country, start_date, end_date")
        .eq("status", "completed")
        .not("start_date", "is", null)
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("owner_id", USER_ARG);
      const { data: trips } = await q;

      const out: Candidate[] = [];
      const seen = new Set<string>();
      for (const trip of (trips ?? []) as any[]) {
        if (seen.has(trip.owner_id)) continue;
        const s   = new Date(trip.start_date + "T00:00:00Z");
        const end = trip.end_date ? new Date(trip.end_date + "T00:00:00Z") : new Date(s);
        const days = Math.max(0, Math.round((end.getTime() - s.getTime()) / 86_400_000));
        if (days > 3) continue;
        let isWeekend = false;
        for (const d = new Date(s); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
          if (d.getUTCDay() === 0 || d.getUTCDay() === 6) { isWeekend = true; break; }
        }
        if (isWeekend) {
          seen.add(trip.owner_id);
          out.push({ userId: trip.owner_id, sourceType: "trips", sourceId: trip.id, city: trip.destination_city ?? undefined, country: trip.destination_country ?? undefined });
        }
      }
      return out;
    },
  },
  {
    slug: "long_haul",
    description: "Users who completed a trip lasting more than 14 days",
    async candidates() {
      let q = db
        .from("trips")
        .select("owner_id, id, destination_city, destination_country, start_date, end_date")
        .eq("status", "completed")
        .not("start_date", "is", null)
        .not("end_date", "is", null)
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("owner_id", USER_ARG);
      const { data: trips } = await q;

      const out: Candidate[] = [];
      const seen = new Set<string>();
      for (const trip of (trips ?? []) as any[]) {
        if (seen.has(trip.owner_id)) continue;
        const s    = new Date(trip.start_date + "T00:00:00Z");
        const e    = new Date(trip.end_date   + "T00:00:00Z");
        const days = Math.max(0, Math.round((e.getTime() - s.getTime()) / 86_400_000));
        if (days > 14) {
          seen.add(trip.owner_id);
          out.push({ userId: trip.owner_id, sourceType: "trips", sourceId: trip.id, city: trip.destination_city ?? undefined, country: trip.destination_country ?? undefined });
        }
      }
      return out;
    },
  },
  {
    slug: "international_voyager",
    description: "Users who completed a trip with a destination_country set",
    async candidates() {
      let q = db
        .from("trips")
        .select("owner_id, id, destination_city, destination_country")
        .eq("status", "completed")
        .not("destination_country", "is", null)
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("owner_id", USER_ARG);
      return firstPerUser<any>(q, "owner_id").then((rows) =>
        rows.map((r) => ({ userId: r.owner_id, sourceType: "trips", sourceId: r.id, city: r.destination_city ?? undefined, country: r.destination_country ?? undefined })),
      );
    },
  },
  {
    slug: "road_warrior",
    description: "Trip owners who completed 5 or more trips",
    async candidates() {
      let q = db
        .from("trips")
        .select("owner_id, id, destination_city, destination_country")
        .eq("status", "completed")
        .order("created_at", { ascending: false });
      if (USER_ARG) q = (q as any).eq("owner_id", USER_ARG);
      const { data: trips, error } = await q;
      if (error) throw new Error(error.message);

      // count per owner, pick their 5th trip as the source
      const countMap = new Map<string, number>();
      const tripMap  = new Map<string, any>();
      for (const t of (trips ?? []) as any[]) {
        const prev = countMap.get(t.owner_id) ?? 0;
        countMap.set(t.owner_id, prev + 1);
        if ((prev + 1) === 5) tripMap.set(t.owner_id, t);
      }
      return [...tripMap.entries()]
        .filter(([uid]) => (countMap.get(uid) ?? 0) >= 5)
        .map(([uid, t]) => ({ userId: uid, sourceType: "trips", sourceId: t.id, city: t.destination_city ?? undefined, country: t.destination_country ?? undefined }));
    },
  },
  {
    slug: "frequent_flyer",
    description: "Trip owners who completed 10 or more trips",
    async candidates() {
      let q = db
        .from("trips")
        .select("owner_id, id, destination_city, destination_country")
        .eq("status", "completed")
        .order("created_at", { ascending: false });
      if (USER_ARG) q = (q as any).eq("owner_id", USER_ARG);
      const { data: trips, error } = await q;
      if (error) throw new Error(error.message);

      const countMap = new Map<string, number>();
      const tripMap  = new Map<string, any>();
      for (const t of (trips ?? []) as any[]) {
        const prev = countMap.get(t.owner_id) ?? 0;
        countMap.set(t.owner_id, prev + 1);
        if ((prev + 1) === 10) tripMap.set(t.owner_id, t);
      }
      return [...tripMap.entries()]
        .filter(([uid]) => (countMap.get(uid) ?? 0) >= 10)
        .map(([uid, t]) => ({ userId: uid, sourceType: "trips", sourceId: t.id, city: t.destination_city ?? undefined, country: t.destination_country ?? undefined }));
    },
  },

  // ── Post stamps ──────────────────────────────────────────────────────────────
  {
    slug: "first_postcard",
    description: "Users who created at least one passport postcard",
    async candidates() {
      let q = db
        .from("passport_postcards")
        .select("user_id, id, location_city, location_country")
        .eq("status", "active")
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("user_id", USER_ARG);
      return firstPerUser<any>(q, "user_id").then((rows) =>
        // sourceType "postcards" matches what the live posts.ts trigger uses —
        // avoids validateSource() checking the posts table for a postcard ID.
        rows.map((r) => ({ userId: r.user_id, sourceType: "postcards", sourceId: r.id, city: r.location_city ?? undefined, country: r.location_country ?? undefined })),
      );
    },
  },

  // ── Safe Return stamps ───────────────────────────────────────────────────────
  {
    slug: "safe_return_ready",
    description: "Users who created at least one active Safe Return session (excludes cancelled/deleted)",
    async candidates() {
      let q = db
        .from("safe_return_sessions")
        .select("user_id, id")
        // Exclude cancelled/deleted per award exclusion policy
        .not("status", "in", '("cancelled","deleted","expired_cancelled")')
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("user_id", USER_ARG);
      return firstPerUser<any>(q, "user_id").then((rows) =>
        rows.map((r) => ({ userId: r.user_id, sourceType: "safe_return", sourceId: r.id })),
      );
    },
  },
  {
    slug: "safe_return_completed",
    description: "Users who confirmed at least one Safe Return session",
    async candidates() {
      let q = db
        .from("safe_return_sessions")
        .select("user_id, id")
        .eq("status", "safe_confirmed")
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("user_id", USER_ARG);
      return firstPerUser<any>(q, "user_id").then((rows) =>
        rows.map((r) => ({ userId: r.user_id, sourceType: "safe_return", sourceId: r.id })),
      );
    },
  },

  // ── Rent a Buddy stamps ──────────────────────────────────────────────────────
  {
    slug: "first_buddy_booking",
    description: "Travelers who completed at least one Rent a Buddy booking",
    async candidates() {
      let q = db
        .from("rent_buddy_bookings")
        .select("traveler_id, id")
        .eq("status", "completed")
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("traveler_id", USER_ARG);
      return firstPerUser<any>(q, "traveler_id").then((rows) =>
        rows.map((r) => ({ userId: r.traveler_id, sourceType: "rent_buddy", sourceId: r.id })),
      );
    },
  },
  {
    slug: "first_buddy_hosted",
    description: "Buddies who completed at least one booking as a buddy",
    async candidates() {
      const { data, error } = await db
        .from("rent_buddy_bookings")
        .select("id, rent_buddy_profiles!inner(user_id)")
        .eq("status", "completed")
        .order("created_at", { ascending: true });
      if (error) throw new Error(`first_buddy_hosted: ${error.message}`);

      const out: Candidate[] = [];
      const seen = new Set<string>();
      for (const r of (data ?? []) as any[]) {
        const uid: string = r.rent_buddy_profiles?.user_id;
        if (!uid) continue;
        if (USER_ARG && uid !== USER_ARG) continue;
        if (seen.has(uid)) continue;
        seen.add(uid);
        out.push({ userId: uid, sourceType: "rent_buddy", sourceId: r.id });
      }
      return out;
    },
  },

  // ── Hidden Gem stamps ────────────────────────────────────────────────────────
  {
    slug: "hidden_gem_explorer",
    description: "Users whose submitted hidden gem was approved",
    async candidates() {
      let q = db
        .from("hidden_gems")
        .select("submitted_by, id, location_city, location_country")
        .eq("status", "active")
        .not("submitted_by", "is", null)
        .order("created_at", { ascending: true });
      if (USER_ARG) q = (q as any).eq("submitted_by", USER_ARG);
      return firstPerUser<any>(q, "submitted_by").then((rows) =>
        rows.map((r) => ({ userId: r.submitted_by, sourceType: "hidden_gems", sourceId: r.id, city: r.location_city ?? undefined, country: r.location_country ?? undefined })),
      );
    },
  },

  // ── Admin stamps ─────────────────────────────────────────────────────────────
  {
    slug: "verified_traveler",
    description: "Users whose account has been verified",
    async candidates() {
      let q = db
        .from("profiles")
        .select("id")
        .eq("verified", true)
        .eq("verification_status", "verified");
      if (USER_ARG) q = (q as any).eq("id", USER_ARG);
      const { data, error } = await q;
      if (error) throw new Error(`verified_traveler: ${error.message}`);
      return (data ?? []).map((r: any) => ({ userId: r.id, sourceType: "admin", sourceId: r.id }));
    },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"─".repeat(80)}`);
  console.log(`  Stamp Backfill — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE (writing to DB via /api/stamps/award)"}`);
  if (USER_ARG) console.log(`  User filter:  ${USER_ARG}`);
  if (SLUG_ARG) console.log(`  Slug filter:  ${SLUG_ARG}`);
  console.log(`${"─".repeat(80)}\n`);

  const report: ReportRow[] = [];

  const activeRules = SLUG_ARG
    ? RULES.filter((r) => r.slug === SLUG_ARG)
    : RULES;

  if (activeRules.length === 0) {
    console.error(`ERROR: No rule found for slug "${SLUG_ARG}"`);
    process.exit(1);
  }

  for (const rule of activeRules) {
    console.log(`[${rule.slug}] ${rule.description}`);

    // Warn early if the definition isn't in the DB yet (won't block dry-run).
    const defOk = await definitionExists(rule.slug);
    if (!defOk) {
      console.log(`  ⚠️  stamp_definitions row missing or inactive — ${DRY_RUN ? "showing eligible candidates anyway" : "awards will return definition_not_found via engine"}\n`);
    }

    let candidates: Candidate[];
    try {
      candidates = await rule.candidates();
    } catch (err: any) {
      console.error(`  ❌ candidates() error: ${err.message}`);
      report.push({ userId: "—", slug: rule.slug, sourceType: "—", result: "error", reason: err.message });
      continue;
    }

    console.log(`  Candidates: ${candidates.length}`);

    for (const c of candidates) {
      if (DRY_RUN) {
        const skip = defOk && await alreadyAwarded(c.userId, rule.slug, c.sourceType, c.sourceId);
        report.push({
          userId:     c.userId,
          slug:       rule.slug,
          sourceType: c.sourceType,
          result:     skip ? "dry_run_skip" : "dry_run_eligible",
          reason:     skip ? "already_awarded" : "eligible",
        });
      } else {
        try {
          const outcome = await callAwardEndpoint({ ...c, definitionSlug: rule.slug });
          report.push({
            userId:     c.userId,
            slug:       rule.slug,
            sourceType: c.sourceType,
            result:     outcome.awarded ? "awarded" : "skipped",
            reason:     outcome.reason,
          });
        } catch (err: any) {
          report.push({
            userId:     c.userId,
            slug:       rule.slug,
            sourceType: c.sourceType,
            result:     "error",
            reason:     err.message,
          });
        }
      }
    }

    // Per-slug summary line
    const n = (r: ReportRow["result"]) => report.filter((x) => x.slug === rule.slug && x.result === r).length;
    if (DRY_RUN) {
      console.log(`  → ${n("dry_run_eligible")} eligible, ${n("dry_run_skip")} already_awarded\n`);
    } else {
      console.log(`  → Awarded: ${n("awarded")}, Skipped: ${n("skipped")}, Errors: ${n("error")}\n`);
    }
  }

  // ── Summary table ────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(90)}`);
  console.log(`${"User".padEnd(14)} ${"Stamp".padEnd(26)} ${"SourceType".padEnd(16)} ${"Result".padEnd(18)} Reason`);
  console.log(`${"─".repeat(90)}`);
  for (const row of report) {
    const uid = row.userId === "—" ? row.userId : row.userId.slice(0, 8) + "…";
    console.log(
      `${uid.padEnd(14)} ${row.slug.padEnd(26)} ${row.sourceType.padEnd(16)} ${row.result.padEnd(18)} ${row.reason}`,
    );
  }
  console.log(`${"─".repeat(90)}`);

  const total    = report.length;
  const eligible = report.filter((r) => r.result === "dry_run_eligible").length;
  const awarded  = report.filter((r) => r.result === "awarded").length;
  const errors   = report.filter((r) => r.result === "error").length;

  if (DRY_RUN) {
    console.log(`\nSummary: ${eligible} eligible of ${total} candidates`);
    console.log(`ℹ  Re-run with --apply to write awards via the engine.\n`);
  } else {
    console.log(`\nSummary: ${awarded} awarded, ${errors} errors of ${total} candidates`);
    if (errors > 0) process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
