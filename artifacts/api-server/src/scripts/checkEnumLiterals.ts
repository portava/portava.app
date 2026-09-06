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
import { extractWriteLiterals } from "./lib/writeLiteralExtract.js";
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
  // TWO ENTRIES WERE STRUCK OFF HERE, and both were struck for the same reason:
  // the sites they named are repaired by other PRs in this batch, and a ratchet
  // entry whose site no longer exists fails this check exactly as loudly as a
  // new dead literal does.
  //
  //   1. `TrustGamingDetectionService.ts:plan_attendance_events.event_type:
  //      checked_in` — struck for PR #416, which replaces that `.eq` with
  //      `.in("event_type", CHECKIN_CLUSTER_EVENT_TYPES)` (checked_in_successfully
  //      | late_check_in). Its note was also WRONG on the fact it rested on: it
  //      claimed plan_attendance_events "has no production writer anywhere in
  //      src/", but routes/geofence.ts:153 inserts into it from three call sites
  //      (:557, :588, :852). The table is empty because its CHECK rejects every
  //      one of those inserts 23514 — a constraint defect, not a missing
  //      producer — and #416's migration 2302 is what fixes it.
  //   2. `CreatorActivityScoreService.ts:posts.status:published` — struck for
  //      PR #413, exactly as this entry's own note instructed.
  //
  // Both of those PRs are on main as of this branch's merge, so both sites are
  // repaired here and the ratchet is 4 -> 2.
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

/**
 * WRITE-side dead literals — a SEPARATE ratchet, deliberately.
 *
 * These could have gone into KNOWN_DEAD_LITERALS above, and that would have been
 * the wrong call: that list carries the invariant "must reach zero, must never
 * grow", it is down to 2, and dropping 13 pre-existing write defects into it
 * would destroy the one number that says how close the filter side is to done.
 * A new check that finds pre-existing debt needs its own starting line.
 *
 * EVERY ENTRY HERE IS A LIVE DEFECT, not a tolerated quirk. A write literal the
 * column cannot hold is worse than a read one: the read merely returns nothing,
 * the write is REJECTED — 22P02 on an enum, 23514 on a text CHECK — so the row is
 * never stored at all. In this repo the rejection is then swallowed by a
 * fire-and-forget `catch {}` or a `logger.warn`, which is why every one of these
 * has been shipping as a working feature.
 *
 * All 13 were verified against the LIVE CI schema (hwokxgbmezheskbzskfr,
 * read-only), not merely against the baseline — the baseline alone would have
 * mis-judged several, and did produce one false positive during development
 * (media_assets.moderation_status:'active', legal since migration 2250).
 *
 * Ranked by consequence, worst first. These are FIXES, not exemptions.
 */
export const KNOWN_DEAD_WRITE_LITERALS: Record<string, { count: number; note: string }> = {
  "src/routes/admin.ts:profiles.account_status:suspended": {
    count: 2,
    note:
      "THE ADMIN SUSPEND ROUTE CANNOT SUCCEED. profiles_account_status_check " +
      "permits active | deactivated | pending_deletion | deleted and no migration " +
      "widens it. POST /admin/users/:userId/suspend surfaces the error, so the " +
      "route always fails; the moderation path at :1134 folds it into " +
      "sideEffects.accountState = 'error' and records the suspension only in " +
      "user_account_states, while the access gates read profiles.account_status. " +
      "Needs a decision: widen the CHECK, or point the gates at user_account_states.",
  },
  "src/routes/admin.ts:profiles.account_status:banned": {
    count: 2,
    note:
      "THE ADMIN BAN ROUTE CANNOT SUCCEED — same column, same cause as 'suspended' " +
      "above. POST /admin/users/:userId/ban returns db_error every time. Ban and " +
      "suspend are the two strongest moderation actions and neither has ever " +
      "written the field the access gates consult.",
  },
  "src/routes/rentABuddy.ts:message_threads.thread_type:rent_buddy_booking": {
    count: 2,
    note:
      "RENT-A-BUDDY BOOKING CHAT CANNOT BE CREATED BY EITHER PATH. " +
      "message_threads_thread_type_check permits circle | direct | trip. At :1917 " +
      "the error is discarded (only `{ data: newThread }` is read) so the thread " +
      "silently never exists; at :2542 it surfaces as 500 thread_creation_failed. " +
      "Either add the label by migration or reuse 'direct' — a product decision.",
  },
  "src/routes/rentABuddySpec.ts:rent_buddy_profiles.status:draft": {
    count: 1,
    note:
      "BUDDY-PROFILE CREATION VIA THIS ROUTE ALWAYS FAILS. rent_buddy_status is an " +
      "ENUM (active | paused | pending | rejected | suspended) with no 'draft', so " +
      "the upsert raises 22P02 and the handler returns db_error. 'pending' is the " +
      "closest real label but means something different to the review queue, so " +
      "this is a decision, not a rename.",
  },
  "src/routes/passport.ts:passport_postcards.status:removed_from_passport": {
    count: 1,
    note:
      "'Remove postcard from passport' always 500s. The column is the post_status " +
      "enum (active | deleted | hidden | reported). The intent — removed from the " +
      "passport surface but not deleted — has no label; 'hidden' is the nearest and " +
      "may be right, but it is a product call about whether the postcard is gone or " +
      "merely unlisted.",
  },
  "src/routes/mediaFeed.ts:hidden_gems.status:deleted": {
    count: 1,
    note:
      "Owner-delete of a hidden gem returns db_error. hidden_gem_status is " +
      "active | hidden | merged | pending. Note the posts delete on the line above " +
      "uses the same literal and IS legal, because posts.status is a different enum " +
      "that does have 'deleted' — the two were written from one mental model.",
  },
  "src/services/appeals/resolveAppeal.ts:event_rsvps.status:attending": {
    count: 1,
    note:
      "A GRANTED APPEAL NEVER RESTORES THE RSVP. event_rsvp_status is " +
      "cant_go | going | interested | maybe; the intended label is 'going'. The " +
      "event_membership branch returns { ok: false, action: 'noop' } every time, so " +
      "an upheld appeal silently does nothing. This one looks like a plain rename, " +
      "but it changes user-visible outcomes and belongs with the others.",
  },
  "src/routes/admin.ts:posts.post_status:removed": {
    count: 1,
    note:
      "Admin report-resolution content removal fails for a post. The column is the " +
      "delayed_post_status enum (canceled | draft | expired | pending_delay | " +
      "pending_location_exit | pending_safety_review | private | published) — note " +
      "it is NOT posts.status, which is the enum that does have removal labels. Two " +
      "status columns on one table, and the wrong one was written.",
  },
  "src/routes/tripCrewLocation.ts:trip_crew_location_events.event_type:ghost_mode_on": {
    count: 1,
    note:
      "Ghost-mode audit events are never recorded. The CHECK admits ghost_on, and " +
      "NOTHING writes it — TripCrewLiveShareService.logEvent only emits " +
      "live_share_started/stopped/expired and access_revoked. The insert failure is " +
      "logged at warn and dropped, so the privacy-relevant audit trail for entering " +
      "ghost mode is empty in every environment.",
  },
  "src/routes/tripCrewLocation.ts:trip_crew_location_events.event_type:ghost_mode_off": {
    count: 1,
    note:
      "The exit half of the ghost-mode audit trail, same cause as ghost_mode_on. " +
      "The admitted label is ghost_off.",
  },
  "src/routes/circle.ts:circle_audit_events.event_type:sharing_paused": {
    count: 1,
    note:
      "Found only through call-site forwarding: writeAuditEvent writes " +
      "event_type from opts.eventType and the caller at :572 supplies this. The " +
      "CHECK's neighbour is 'presence_paused'. The audit row for a Circle privacy " +
      "pause has never been written, and the insert logs 'circle audit insert " +
      "failed (non-fatal)'. Note circle_presence.status = 'paused' on the SAME code " +
      "path is legal — 2298 widened it — so this is the residue 2298 left behind.",
  },
  "src/routes/circle.ts:circle_audit_events.event_type:sharing_paused_on_session_end": {
    count: 1,
    note:
      "The session-end half of the same audit gap, from the caller at :1867. No " +
      "admitted label distinguishes 'paused because the session ended' from a " +
      "manual pause, so collapsing both onto presence_paused loses a distinction " +
      "the code is deliberately drawing. Needs a label or a decision to drop it.",
  },
  "src/services/hiddenGems/HiddenGemModerationService.ts:hidden_gem_reports.status:upheld": {
    count: 1,
    note:
      "An UPHELD gem report is never closed and stays 'pending' forever. The CHECK " +
      "is dismissed | pending | resolved, so only the ternary's 'upheld' VALUE " +
      "branch is dead — the 'dismissed' branch works, and the 'upheld' on the left " +
      "of the === is a comparison operand, not a write. The intended label is " +
      "almost certainly 'resolved'.",
  },
};

/** insert / upsert / update, including the ".fwd1" / ".fwd2" forwarded forms. */
export function isWriteOp(op: string): boolean {
  const base = op.split(".")[0]!;
  return base === "insert" || base === "upsert" || base === "update";
}

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
  const filters = extractFilterLiterals(SCAN_DIRS, API_ROOT);
  const writes = extractWriteLiterals(SCAN_DIRS, API_ROOT);
  const sites = [...filters.sites, ...writes.sites];
  const filesScanned = filters.filesScanned;
  const judged = sites.filter((s) => vocab.values.has(`${s.table}.${s.column}`));

  console.log(
    `Canonical vocabulary: ${vocab.values.size} column(s) with a declared value set ` +
      `(baseline + ${vocab.sources.migrationFiles} migrations).`,
  );
  console.log(
    `Extracted ${filters.sites.length} filter literal(s) and ${writes.sites.length} write ` +
      `literal(s) across ${filesScanned} file(s); ${judged.length} sit on a column whose ` +
      `vocabulary is known.`,
  );

  // ── LIVENESS FLOORS — the script must not be able to pass by scanning nothing.
  //
  // `listTsFiles` swallows a readdir failure and returns [], so a wrong SCAN_DIRS
  // yields sites: 0, filesScanned: 0 and NO throw. Today that is caught only
  // because the ratchet is non-empty: its entries go stale and the run exits 1.
  // The ratchet's stated goal is to reach zero — and at zero, a completely broken
  // extractor would exit 0 and report success. The floors that prevent this lived
  // only in enumLiteralGuard.test.ts, which is one curated-test-list edit away from
  // not running. A check whose vacuity is caught only by another file is not a
  // check, so the floors are asserted here too.
  //
  // The numbers are deliberately far below reality (measured: ~311 vocabularies,
  // ~700 files, >1000 judged) so ordinary churn never trips them. They catch a
  // COLLAPSE, not a change.
  const floors: Array<[string, number, number]> = [
    ["canonical vocabularies", vocab.values.size, 200],
    ["files scanned", filesScanned, 300],
    ["literals judged against a known vocabulary", judged.length, 500],
  ];
  const collapsed = floors.filter(([, actual, floor]) => actual < floor);
  if (collapsed.length > 0) {
    console.error("");
    console.error("✗ check:enum-literals scanned far less than it should have — refusing to report success.");
    for (const [what, actual, floor] of collapsed) {
      console.error(`    ${what}: ${actual} (floor ${floor})`);
    }
    console.error(
      "  A run that reaches nothing finds nothing, and with an empty ratchet that is\n" +
      "  indistinguishable from a clean tree. Check SCAN_DIRS, the baseline path and the\n" +
      "  migration directories before touching these floors.",
    );
    process.exit(1);
  }

  const findings = findDeadLiterals(sites, vocab);
  // One partition over BOTH ratchets. They are separate maps so the filter list's
  // "must reach zero, must never grow" invariant stays a real number, but a
  // finding is a finding and the exact-count mechanism is identical for both.
  const { fresh, known, staleRatchetKeys, miscounted } = partition(findings, {
    ...KNOWN_DEAD_LITERALS,
    ...KNOWN_DEAD_WRITE_LITERALS,
  });

  if (verbose) {
    for (const f of known) {
      console.log(`  [ratchet] ${f.file}:${f.line} ${f.table}.${f.column} ${f.op} "${f.literal}"`);
    }
  }

  let failed = false;

  if (fresh.length > 0) {
    failed = true;
    console.error(`\n✗ ${fresh.length} literal(s) name a value the column cannot hold:\n`);
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

  // Report the two ratchets SEPARATELY. Summing them would hide the number that
  // matters: the filter list is down to 2 and must reach zero, and burying it
  // inside a combined 18 would make its progress invisible.
  const knownFilter = known.filter((f) => !isWriteOp(f.op)).length;
  const knownWrite = known.filter((f) => isWriteOp(f.op)).length;
  console.log(
    `\n✓ No undeclared literals off the ratchets.\n` +
      `    filter side: ${knownFilter} finding(s) across ` +
      `${Object.keys(KNOWN_DEAD_LITERALS).length} ratcheted key(s) — must reach zero.\n` +
      `    write side:  ${knownWrite} finding(s) across ` +
      `${Object.keys(KNOWN_DEAD_WRITE_LITERALS).length} ratcheted key(s) — each one is a ` +
      `rejected row, not a quiet miss.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  await main();
}
