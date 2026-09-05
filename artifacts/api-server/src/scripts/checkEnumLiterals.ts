/**
 * Static dead-literal check — `check:enum-literals`.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * A 2026-09-05 audit found THIRTY-TWO live production call sites filtering a
 * column on a value that column cannot hold. Twenty-five were enum columns:
 * Postgres rejects an unknown enum literal outright (22P02) rather than
 * matching nothing, so PostgREST failed the WHOLE request. supabase-js RETURNS
 * that error instead of throwing, so the surrounding `try/catch` never fired
 * and a `{ data }` destructure quietly produced `undefined`. Compass chat could
 * never return an event; Compass Home's event rail was permanently empty;
 * Compass Live had no trip grounding at all; discovery search returned [] for
 * trips, plans and posts; the hidden-gem duplicate check never fired. Each one
 * degraded to *plausible emptiness*, which is precisely why they survived years
 * of inspection. The remaining seven were CHECK-constrained TEXT, which is
 * quieter still: no error, the predicate simply matches nothing forever.
 *
 * WHY NO TEST COULD SEE ANY OF IT
 * -------------------------------
 * Every fake Supabase client in this repo implements a filter as
 * `filters.push(r => r[col] === val)`. It answers "does my fixture's value
 * appear in what you passed?" — never "is what you passed a real label of that
 * column?". It is structurally incapable of returning 22P02.
 *
 * The audit proved that mechanism with a pair of mutations. Replacing BOTH
 * literals of an `.in('status', […])` with nonsense turned the suite RED (so
 * the double does filter on the list); replacing only the ALREADY-DEAD literal
 * and leaving the valid one left it GREEN, 33/33. So a fixture written from a
 * fiction PINS the fiction, and three suites were found to be load-bearing on
 * values the database rejects — a test that is green AND load-bearing and still
 * guarantees the code can never work.
 *
 * That is why this check compares literals against the SCHEMA rather than
 * against a test double. Until the doubles can fail the way PostgREST fails, no
 * amount of test-writing can see this class.
 *
 * SOURCE OF TRUTH — not `src/lib/database.types.ts`
 * -------------------------------------------------
 * The vocabulary comes from `baseline/20260819_baseline_structure.sql` plus
 * every migration that alters a type or a CHECK (lib/canonicalVocabulary.ts).
 * `database.types.ts` OVER-reports — it carries union members the live enums do
 * not have — and believing it is how several of these literals were written.
 * Like check:schema-references, this needs no network and no credentials, so it
 * cannot be starved by the live-DB lane.
 *
 * FAILURE POSTURE
 * ---------------
 * Over-permissive by construction: a column with no enum type and no parseable
 * CHECK is never judged, an identifier bound to two tables in one file is never
 * judged, and interpolated values are never judged. A false failure here would
 * block unrelated work; a missed catch costs at most one more entry on the
 * ratchet below.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:enum-literals
 *   pnpm run check:enum-literals -- --verbose
 *
 * Exit 0 → every judged literal is a declared value (or is on the ratchet).
 * Exit 1 → at least one literal names a value the column cannot hold.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFilterLiterals, type LiteralSite } from "./lib/filterLiteralExtract.js";
import {
  buildCanonicalVocabulary,
  type CanonicalVocabulary,
} from "./lib/canonicalVocabulary.js";

const __dir = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = resolve(__dir, "../..");
export const SCAN_DIRS = [
  resolve(__dir, "../routes"),
  resolve(__dir, "../services"),
  resolve(__dir, "../lib"),
  resolve(__dir, "../compass"),
  resolve(__dir, "../scripts"),
];
export const BASELINE = resolve(API_ROOT, "baseline/20260819_baseline_structure.sql");
export const MIGRATION_DIRS = [
  resolve(API_ROOT, "migrations"),
  resolve(API_ROOT, "src/migrations"),
];

/**
 * Dead literals that survive this check — a RATCHET, not an allowlist.
 *
 * Every entry is a literal the column genuinely cannot hold, left in place
 * because NO REAL LABEL CARRIES THE INTENT and inventing one would be worse
 * than the deadness. Repointing an abuse detector at the nearest-looking label
 * does not restore it; it makes it flag the wrong people. Each of these needs a
 * PRODUCER that does not exist — the same shape as the `activity_events`
 * event types with no writer — and that is a build, not a rename.
 *
 * The count per key is EXACT, so this fails in both directions: a new dead
 * literal at a listed site fails, and a fixed one that was not struck off
 * fails. This list must reach zero. It must never grow.
 */
export const KNOWN_DEAD_LITERALS: Record<string, { count: number; note: string }> = {
  "src/compass/CompassAbuseDefenseEngine.ts:compass_active_user_events.event_type:availability_toggle": {
    count: 1,
    note:
      "Abuse detector 7 (available-now abuse) counts availability toggles. The " +
      "CHECK vocabulary is booking_completed | buddy_session_completed | " +
      "dispute_raised | event_attended | no_show | post_published | " +
      "report_received | review_posted | stamp_earned | trip_created — none of " +
      "which is an availability toggle, and nothing in src/ writes one. " +
      "Repointing this at any existing label would make the detector count a " +
      "different behaviour and flag people for it. Needs a producer.",
  },
  "src/services/trust/TrustGamingDetectionService.ts:plan_attendance_events.event_type:checked_in": {
    count: 1,
    note:
      "Gaming detector: same-location check-in clusters. plan_attendance_events " +
      "is an ANOMALY log — its CHECK is suspicious | late | override | excused — " +
      "and it has no production writer anywhere in src/. The routine check-in it " +
      "wants is not in that vocabulary and plan_checkins is a per-user SNAPSHOT " +
      "(upserted, one row per user+geofence), so it cannot answer 'more than N " +
      "check-ins in 24 h' either. Repointing this at `suspicious` would turn a " +
      "check-in-frequency detector into one that opens gaming reviews for " +
      "already-flagged anomalies. Needs an event producer.",
  },
  // NOT of the same kind as the three below, and the only entry here with a
  // real label waiting for it. `posts.status` is active | hidden | reported |
  // deleted, so every creator's post contribution has always been zero. It is
  // recorded rather than fixed because PR #413 — open, and the founding example
  // of this whole class — changes exactly this line, and two PRs editing one
  // literal is how a merge silently reverts a fix. WHEN #413 LANDS, DELETE THIS
  // ENTRY IN THE SAME COMMIT: the check fails on a stale ratchet entry as well
  // as a new dead literal, so it will tell you.
  "src/services/ranking/CreatorActivityScoreService.ts:posts.status:published": {
    count: 1,
    note: "Fixed by open PR #413. Strike this entry off in that PR, not this one.",
  },
  "src/services/location/GeoZoneService.ts:location_sessions.session_type:private_stay": {
    count: 1,
    note:
      "isNearPrivateStay powers PulseGeoTagService's hotel blur — a real " +
      "production caller. location_sessions_session_type_check permits " +
      "live_share | trip_check_in | auto, and LocationSessionService's own " +
      "SessionType union (private_stay | safe_return | trusted_circle | " +
      "plan_checkin) shares NOT ONE value with it, so every session that " +
      "service would create is rejected 23514 and it has no production caller " +
      "either. That is a whole-vocabulary divergence, not a literal to swap; " +
      "fixing it means deciding what location_sessions is for.",
  },
};

export interface Finding extends LiteralSite {
  allowed: string[];
  origin: string;
}

/** Pure core, so a test can drive it against a fixture vocabulary. */
export function findDeadLiterals(
  sites: LiteralSite[],
  vocab: CanonicalVocabulary,
): Finding[] {
  const out: Finding[] = [];
  for (const s of sites) {
    const key = `${s.table}.${s.column}`;
    const allowed = vocab.values.get(key);
    if (!allowed) continue; // unmodelled — decline to judge
    if (allowed.has(s.literal)) continue;
    out.push({
      ...s,
      allowed: [...allowed].sort(),
      origin: vocab.origin.get(key) ?? "unknown",
    });
  }
  return out;
}

export function ratchetKey(f: Pick<Finding, "file" | "table" | "column" | "literal">): string {
  return `${f.file}:${f.table}.${f.column}:${f.literal}`;
}

/**
 * Split findings into "on the ratchet" and "new", and report ratchet entries
 * that no longer correspond to any finding (i.e. were fixed and not struck off).
 */
export function partition(
  findings: Finding[],
  ratchet: Record<string, { count: number; note: string }>,
): { fresh: Finding[]; known: Finding[]; staleRatchetKeys: string[]; miscounted: string[] } {
  const byKey = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = ratchetKey(f);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(f);
  }
  const fresh: Finding[] = [];
  const known: Finding[] = [];
  const miscounted: string[] = [];
  for (const [k, group] of byKey) {
    const entry = ratchet[k];
    if (!entry) { fresh.push(...group); continue; }
    known.push(...group);
    if (group.length !== entry.count) {
      miscounted.push(`${k} — ratchet says ${entry.count}, found ${group.length}`);
    }
  }
  const staleRatchetKeys = Object.keys(ratchet).filter((k) => !byKey.has(k));
  return { fresh, known, staleRatchetKeys, miscounted };
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const vocab = buildCanonicalVocabulary(BASELINE, MIGRATION_DIRS);
  const { sites, filesScanned } = extractFilterLiterals(SCAN_DIRS, API_ROOT);
  const judged = sites.filter((s) => vocab.values.has(`${s.table}.${s.column}`));

  console.log(
    `Canonical vocabulary: ${vocab.values.size} column(s) with a declared value set ` +
      `(baseline + ${vocab.sources.migrationFiles} migrations).`,
  );
  console.log(
    `Extracted ${sites.length} filter literal(s) across ${filesScanned} file(s); ` +
      `${judged.length} sit on a column whose vocabulary is known.`,
  );

  const findings = findDeadLiterals(sites, vocab);
  const { fresh, known, staleRatchetKeys, miscounted } = partition(findings, KNOWN_DEAD_LITERALS);

  if (verbose) {
    for (const f of known) {
      console.log(`  [ratchet] ${f.file}:${f.line} ${f.table}.${f.column} ${f.op} "${f.literal}"`);
    }
  }

  let failed = false;

  if (fresh.length > 0) {
    failed = true;
    console.error(`\n✗ ${fresh.length} filter literal(s) name a value the column cannot hold:\n`);
    for (const f of fresh) {
      console.error(`  ${f.file}:${f.line}`);
      console.error(`    ${f.table}.${f.column} (${f.origin}) ${f.op} "${f.literal}"`);
      console.error(`    real values: ${f.allowed.join(" | ")}`);
    }
    console.error(
      "\n  An unknown ENUM literal is rejected 22P02 and fails the WHOLE request;\n" +
        "  an unknown CHECK value matches nothing, forever. Neither is visible to a\n" +
        "  fake Supabase client, so a green test proves nothing here. Use a real\n" +
        "  label, or — if none carries the intent — say so at the site and add it to\n" +
        "  KNOWN_DEAD_LITERALS with the reason.\n",
    );
  }

  if (miscounted.length > 0) {
    failed = true;
    console.error("\n✗ KNOWN_DEAD_LITERALS counts are wrong:");
    for (const m of miscounted) console.error(`  ${m}`);
  }

  if (staleRatchetKeys.length > 0) {
    failed = true;
    console.error(
      "\n✗ KNOWN_DEAD_LITERALS entries no longer match any site — fixed but not struck off:",
    );
    for (const k of staleRatchetKeys) console.error(`  ${k}`);
  }

  if (failed) process.exit(1);

  console.log(
    `\n✓ No dead filter literals. ${known.length} known dead literal(s) remain on the ` +
      `ratchet (expected ${Object.keys(KNOWN_DEAD_LITERALS).length}); that list must shrink.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  await main();
}
