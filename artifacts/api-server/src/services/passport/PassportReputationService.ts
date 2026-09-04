/**
 * PassportReputationService — §20 "Contributions, Expertise and Reputation"
 * (TABLE 21). Projects a traveller's contribution history into the read-only
 * summary the client ContributionCard renders:
 *
 *     CONTRIBUTIONS
 *     Level 4 · Trusted Contributor
 *     81 accepted reports · 23 confirmations · 12 hidden gems
 *     Top expertise: Nightlife · Food · Events
 *
 * SOURCE OF TRUTH: `passport_contribution_events` — the append-only log that
 * `PassportContributionService.recordContribution` writes. This is the canonical
 * "usefulness and qualified real-world evidence" ledger (§20). Reputation is
 * derived here on read; it is never a stored, editable profile fact.
 *
 * §20 PRIVACY RULES enforced here:
 *   1. PAID CONTRIBUTIONS NEVER INFLATE CONFIDENCE. Any event a caller marked
 *      paid / sponsored (`metadata.paid`, `metadata.sponsored`, or
 *      `metadata.source === 'paid'|'sponsored'`) is EXCLUDED from the
 *      confidence-bearing counts and from the level — a paid contribution can
 *      never raise a factual-reputation number merely because it was paid.
 *   2. NO PRIVATE MODERATION DATA. Only positive, aggregate counts + a derived
 *      level + top expertise categories leave this service. No report-against
 *      counts, no moderation evidence, no source ids, no raw event rows (§10,
 *      §34 "not a public moderation record").
 *
 * The projection selects ONLY the columns guaranteed by the ledger migration
 * (0042: event_type, metadata, created_at), so it is robust whether or not the
 * optional source_type / verification_level columns exist in a given
 * environment.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Contribution event types that carry factual reputation weight (positive only). */
const ACCEPTED_REPORT_TYPES = new Set<string>(["pulse_contribution"]);
const CONFIRMATION_TYPES = new Set<string>([
  "city_visit_verified",
  "plan_attendance_verified",
  "qr_checkin_validated",
]);
const HIDDEN_GEM_TYPES = new Set<string>(["hidden_gem_verified"]);
/** Other positive events that add to the total (and thus level) but not a headline count. */
const OTHER_POSITIVE_TYPES = new Set<string>([
  "plan_hosted",
  "safe_return_completed",
  "trip_crew_participation",
]);

export interface ReputationSummary {
  userId: string;
  /** 1..5 contributor level derived from qualified (non-paid) contribution volume. */
  level: number;
  /** Human label for the level (e.g. "Trusted Contributor"). */
  levelLabel: string;
  /** Accepted factual reports (§20). Paid contributions excluded. */
  acceptedReports: number;
  /** Confirmations of real-world presence / plans. Paid contributions excluded. */
  confirmations: number;
  /** Hidden gems surfaced by this traveller. */
  hiddenGems: number;
  /** Up to three expertise categories, most-contributed first. */
  topExpertise: string[];
  /** Total qualified (non-paid) contributions counted toward the level. */
  totalContributions: number;
}

/** A paid / sponsored contribution must never inflate factual confidence (§20). */
function isPaid(metadata: any): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  if (metadata.paid === true || metadata.sponsored === true) return true;
  const source = typeof metadata.source === "string" ? metadata.source.trim().toLowerCase() : "";
  return source === "paid" || source === "sponsored";
}

/** Derive a contributor level (1..5) + label from qualified contribution volume. */
function deriveLevel(total: number): { level: number; label: string } {
  if (total >= 200) return { level: 5, label: "Legendary Contributor" };
  if (total >= 75) return { level: 4, label: "Trusted Contributor" };
  if (total >= 25) return { level: 3, label: "Established Contributor" };
  if (total >= 5) return { level: 2, label: "Rising Contributor" };
  return { level: 1, label: "New Contributor" };
}

/** Pull candidate expertise categories out of one event's metadata. */
function categoriesOf(metadata: any): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  };
  push(metadata.category);
  push(metadata.expertise);
  for (const arr of [metadata.categories, metadata.tags, metadata.expertise_tags]) {
    if (Array.isArray(arr)) for (const v of arr) push(v);
  }
  return out;
}

/** Title-case a category label for display ("nightlife" → "Nightlife"). */
function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/**
 * Build the §20 reputation summary for a user from their contribution ledger.
 * Best-effort and fail-soft: an unreadable ledger yields an all-zero, Level 1
 * summary rather than an error, so the ContributionCard always has something to
 * render.
 */
export async function buildReputationSummary(
  sc: SupabaseClient,
  userId: string,
): Promise<ReputationSummary> {
  const empty: ReputationSummary = {
    userId,
    level: 1,
    levelLabel: "New Contributor",
    acceptedReports: 0,
    confirmations: 0,
    hiddenGems: 0,
    topExpertise: [],
    totalContributions: 0,
  };

  let rows: any[] = [];
  try {
    const { data, error } = await sc
      .from("passport_contribution_events")
      .select("event_type, metadata, created_at")
      .eq("user_id", userId);
    if (error || !Array.isArray(data)) return empty;
    rows = data as any[];
  } catch {
    return empty;
  }

  let acceptedReports = 0;
  let confirmations = 0;
  let hiddenGems = 0;
  let other = 0;
  const categoryCounts = new Map<string, { display: string; count: number }>();

  for (const r of rows) {
    const type = typeof r.event_type === "string" ? r.event_type : "";
    // §20 rule 1: a paid/sponsored contribution never inflates a factual count.
    if (isPaid(r.metadata)) continue;

    let counted = false;
    if (ACCEPTED_REPORT_TYPES.has(type)) { acceptedReports++; counted = true; }
    else if (CONFIRMATION_TYPES.has(type)) { confirmations++; counted = true; }
    else if (HIDDEN_GEM_TYPES.has(type)) { hiddenGems++; counted = true; }
    else if (OTHER_POSITIVE_TYPES.has(type)) { other++; counted = true; }

    if (!counted) continue;
    for (const cat of categoriesOf(r.metadata)) {
      const keyLc = cat.toLowerCase();
      const existing = categoryCounts.get(keyLc);
      if (existing) existing.count++;
      else categoryCounts.set(keyLc, { display: titleCase(cat), count: 1 });
    }
  }

  const totalContributions = acceptedReports + confirmations + hiddenGems + other;
  const { level, label } = deriveLevel(totalContributions);

  const topExpertise = [...categoryCounts.values()]
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
    .slice(0, 3)
    .map((c) => c.display);

  return {
    userId,
    level,
    levelLabel: label,
    acceptedReports,
    confirmations,
    hiddenGems,
    topExpertise,
    totalContributions,
  };
}
