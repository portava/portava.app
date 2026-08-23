/**
 * journeyShadowBoundary.test.ts
 *
 * Static boundary proof that Journey observations / segments / quality /
 * rollout modules cannot influence any forbidden product surface.
 *
 * Proofs:
 *  1. Forbidden consumer roots (Compass, Discovery/Pulse/search,
 *     notifications/push, Autopilot, route plans/itineraries/trips,
 *     social/feed/messaging/matching, behavior/latent-needs/trust/ranking/
 *     outcome learning, analytics/training/telemetry) contain no Journey
 *     table, module, or field references.
 *  2. No GET route handler body mentions Journey raw/shadow output.
 *  3. Only the POST observation ingestion route and admin-only Journey
 *     controls (if/when added) may reference Journey modules.
 *  4. Migration triggers / functions contain no writes FROM Journey tables
 *     INTO forbidden product tables.
 *
 * Run standalone:
 *   node --import tsx/esm --test src/test/journeyShadowBoundary.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Helpers ────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "..");

/**
 * Recursively collect all .ts/.tsx files under a directory.
 * Silently returns [] if the directory does not exist.
 */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const walk = (root: string) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(target);
    }
  };
  walk(dir);
  return files;
}

/**
 * Read a file and return its text. Returns "" if file does not exist.
 */
function readSrc(file: string): string {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

/**
 * Return the relative path from srcRoot for error messages.
 */
function rel(file: string): string {
  return path.relative(srcRoot, file);
}

// ── Journey identity tokens ────────────────────────────────────────────────────
//
// Any of these appearing in a forbidden file is a boundary violation.

/** TypeScript/module-level Journey identifiers */
const JOURNEY_TS_TOKENS = [
  // Table names
  "journey_observations",
  "journey_segment_revisions",
  "journey_revocation_jobs",
  "journey_retention_health",
  // Module / class names
  "JourneyObservationService",
  "JourneySegmentationShadowService",
  "JourneySegmenter",
  "JourneyShadowMetrics",
  "JourneyObservationQuality",
  // Exported function / type names from those modules
  "ingestJourneyObservationBatch",
  "journeyObservationSchema",
  "segmentJourney",
  "persistJourneySegmentsShadow",
  "processJourneySegmentationShadowSession",
  "measureJourneyShadowQuality",
  "purgeExpiredJourneySegments",
  "deleteJourneySegmentsForUser",
  "revokeJourneyConsentAndDeleteSegments",
  "revokesJourneyConsent",
  // Consent/field names that appear in DB column references
  "journey_observation_enabled",
  "journey_consent_scope",
  "journey_consent_version",
  "journey_consent_granted_at",
  "journey_consent_revoked_at",
  "journey_purpose",
  // Feature flags
  "COMPASS_JOURNEY_ENGINE_ENABLED",
  "COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED",
  "COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED",
  // Lib module names
  "journeySegmentRetention",
  "journeyObservationPurge",
  // Rollout / shadow output fields
  "shadowRevisionCount",
  "shadowEligibleSessionIds",
  "JourneyShadowPersistResult",
  "JourneySegmentRevision",
  "JourneyConsentRevocationPatch",
  "RestrictedJourneyObservation",
];

/** SQL-level Journey identifiers for migration checks */
const JOURNEY_SQL_TOKENS = [
  "journey_observations",
  "journey_segment_revisions",
  "journey_revocation_jobs",
  "journey_retention_health",
  "journey_observation_enabled",
  "journey_consent",
  "journey_purpose",
];

// A combined regex for .ts source scans
const JOURNEY_TS_PATTERN = new RegExp(JOURNEY_TS_TOKENS.join("|"));

// ── Allowlist: files/directories that are permitted to reference Journey ───────

/**
 * Route files that are explicitly allowed to reference Journey modules.
 * Only the ingestion POST route and (future) admin-only controls belong here.
 */
const ALLOWED_JOURNEY_ROUTE_FILES = new Set([
  path.join(srcRoot, "routes", "journeyObservations.ts"),
  // Admin Journey route – may be added later; allowlisted proactively.
  path.join(srcRoot, "routes", "adminJourney.ts"),
]);

/**
 * Non-route source files that are permitted to reference Journey:
 *  - The Journey services themselves
 *  - The shared retention / purge lib modules
 *  - The location-preferences route (consent toggle + revocation)
 *  - Location infrastructure services that manage Journey consent fields
 *    or purpose columns (read/classify only – not product consumers)
 *  - Account-deletion service that must directly purge Journey tables
 */
const ALLOWED_JOURNEY_SRC_FILES = new Set([
  // Journey services
  path.join(srcRoot, "services", "journey", "JourneyObservationService.ts"),
  path.join(srcRoot, "services", "journey", "JourneyObservationQuality.ts"),
  path.join(srcRoot, "services", "location", "JourneySegmentationShadowService.ts"),
  path.join(srcRoot, "services", "location", "JourneySegmenter.ts"),
  path.join(srcRoot, "services", "location", "JourneyShadowMetrics.ts"),
  // Controlled-rollout admin services (internal/service-only, no product consumer)
  path.join(srcRoot, "services", "journey", "JourneyShadowRolloutService.ts"),
  path.join(srcRoot, "services", "journey", "JourneyShadowQaService.ts"),
  // Lib modules (retention / purge)
  path.join(srcRoot, "lib", "journeySegmentRetention.ts"),
  path.join(srcRoot, "lib", "journeyObservationPurge.ts"),
  // Location-preferences route: consent toggle and revocation
  path.join(srcRoot, "routes", "locationPreferences.ts"),
  // Location infrastructure: permission / session / safety services read
  // Journey consent fields and purpose columns to gate access. They are
  // privacy infrastructure, not product consumers of Journey output.
  path.join(srcRoot, "services", "location", "LocationPermissionService.ts"),
  path.join(srcRoot, "services", "location", "LocationSessionService.ts"),
  path.join(srcRoot, "services", "location", "LocationSafetyService.ts"),
  // Account-deletion service must directly purge Journey tables as part of
  // the full deletion pipeline. It does not consume Journey output for
  // product features.
  path.join(srcRoot, "services", "accountDeletion", "AccountDeletionService.ts"),
]);

/**
 * Migration SQL files that are permitted to define Journey schema / logic.
 */
const ALLOWED_JOURNEY_MIGRATION_FILES = new Set([
  path.join(srcRoot, "migrations", "2103_journey_segment_shadow.sql"),
  path.join(srcRoot, "migrations", "2119_journey_observation_foundation.sql"),
  path.join(srcRoot, "migrations", "2124_journey_privacy_foundation.sql"),
  path.join(srcRoot, "migrations", "2126_account_deletion_journey_revocation_compat.sql"),
  // Controlled-rollout scaffold: internal/service-only, no product consumer
  path.join(srcRoot, "migrations", "2127_journey_shadow_controlled_rollout.sql"),
]);

// ── Forbidden consumer directory roots ────────────────────────────────────────

/**
 * Each entry is resolved relative to srcRoot. All .ts files inside these
 * directories must contain no Journey token.
 */
const FORBIDDEN_DIRS: Array<{ label: string; dir: string }> = [
  // Compass: recommendation / map engine
  { label: "compass (engine)", dir: "compass" },
  // Compass routes
  { label: "compass routes", dir: "routes/compass.ts" },
  { label: "compassHome route", dir: "routes/compassHome.ts" },
  { label: "compassSense route", dir: "routes/compassSense.ts" },
  { label: "compassLive route", dir: "routes/compassLive.ts" },
  { label: "compassAutopilot route", dir: "routes/compassAutopilot.ts" },
  { label: "compassOutcomes route", dir: "routes/compassOutcomes.ts" },
  { label: "compassGraph route", dir: "routes/compassGraph.ts" },
  { label: "adminCompass route", dir: "routes/adminCompass.ts" },
  // Discovery / Pulse / search
  { label: "discovery route", dir: "routes/discovery.ts" },
  { label: "discoverySearch route", dir: "routes/discoverySearch.ts" },
  { label: "discoverySearchHelpers", dir: "routes/discoverySearchHelpers.ts" },
  { label: "pulse route", dir: "routes/pulse.ts" },
  { label: "searchHistory route", dir: "routes/searchHistory.ts" },
  // Discovery ranking services
  { label: "ranking service", dir: "services/ranking" },
  // Notifications / push
  { label: "notifications route", dir: "routes/notifications.ts" },
  { label: "notifications service", dir: "services/notifications" },
  // Autopilot
  // (compassAutopilot.ts already covered above)
  // Route plans / itineraries / trips
  { label: "trips route", dir: "routes/trips.ts" },
  { label: "trips-expansion route", dir: "routes/trips-expansion.ts" },
  { label: "tripDraft route", dir: "routes/tripDraft.ts" },
  { label: "tripBudgetIntel route", dir: "routes/tripBudgetIntel.ts" },
  { label: "tripReadiness route", dir: "routes/tripReadiness.ts" },
  { label: "tripReservations route", dir: "routes/tripReservations.ts" },
  { label: "tripCrewLocation route", dir: "routes/tripCrewLocation.ts" },
  { label: "routePlan route", dir: "routes/routePlan.ts" },
  { label: "plan route", dir: "routes/plan.ts" },
  { label: "tripCrew service", dir: "services/tripCrew" },
  // Social / feed / messaging / matching
  { label: "posts route", dir: "routes/posts.ts" },
  { label: "follows route", dir: "routes/follows.ts" },
  { label: "friends route", dir: "routes/friends.ts" },
  { label: "messaging route", dir: "routes/messaging.ts" },
  { label: "groupChat route", dir: "routes/groupChat.ts" },
  { label: "meetups route", dir: "routes/meetups.ts" },
  { label: "requests route", dir: "routes/requests.ts" },
  { label: "mediaFeed route", dir: "routes/mediaFeed.ts" },
  { label: "circle route", dir: "routes/circle.ts" },
  { label: "closeFriends route", dir: "routes/closeFriends.ts" },
  // Behavior / latent-needs / trust / ranking / outcome learning
  { label: "trust service", dir: "services/trust" },
  { label: "trust-admin route", dir: "routes/trust-admin.ts" },
  { label: "interactionContext route", dir: "routes/interactionContext.ts" },
  { label: "rankEvents route", dir: "routes/rankEvents.ts" },
  { label: "adminRankingMetrics route", dir: "routes/adminRankingMetrics.ts" },
  { label: "adminRankingConfig route", dir: "routes/adminRankingConfig.ts" },
  // Analytics / training / telemetry
  { label: "visuals analytics lib", dir: "lib/visuals/analytics.ts" },
  { label: "engagement route", dir: "routes/engagement.ts" },
  { label: "mediaAnalyticsBatch route", dir: "routes/mediaAnalyticsBatch.ts" },
];

// ── Named files that must be Journey-clean ─────────────────────────────────────

const FORBIDDEN_NAMED_FILES: Array<{ label: string; file: string }> = [
  { label: "compassSenseScheduler", file: "lib/compassSenseScheduler.ts" },
  { label: "intelligenceGraphScheduler", file: "lib/intelligenceGraphScheduler.ts" },
  { label: "rankingFatigueSweeper", file: "lib/rankingFatigueSweeper.ts" },
  { label: "trustScore lib", file: "lib/trustScore.ts" },
];

// ── Forbidden product tables (for migration trigger scan) ─────────────────────

const FORBIDDEN_PRODUCT_TABLES = [
  // Compass
  "compass_feed",
  "compass_recommendations",
  "compass_memory",
  "compass_context",
  "compass_pipeline_logs",
  // Discovery / ranking
  "discovery_places",
  "rank_debug_samples",
  "ranking_config",
  // Notifications / push
  "notifications",
  "push_tokens",
  "notification_preferences",
  // Trips / plans / itineraries
  "trips",
  "trip_plans",
  "trip_crew",
  "route_plans",
  // Social / messaging
  "posts",
  "follows",
  "messages",
  "group_chats",
  "meetups",
  // Trust / outcomes
  "trust_scores",
  "trust_events",
  "trust_restrictions",
  "compass_outcome",
  // Profiles (direct writes from Journey triggers are forbidden)
  "profiles",
];

// ── Test suite ─────────────────────────────────────────────────────────────────

describe("Journey shadow boundary — static proof", () => {
  // ── 1. Forbidden consumer files contain no Journey token ─────────────────

  it("forbidden consumer directories and files contain no Journey module/table/field references", () => {
    const violations: string[] = [];

    // Collect files from directory specs (some may be individual .ts files)
    const allFiles: Array<{ label: string; file: string }> = [];

    for (const { label, dir } of FORBIDDEN_DIRS) {
      const fullPath = path.join(srcRoot, dir);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        for (const f of collectTsFiles(fullPath)) {
          allFiles.push({ label, file: f });
        }
      } else if (fs.existsSync(fullPath) && fullPath.endsWith(".ts")) {
        allFiles.push({ label, file: fullPath });
      }
      // If the file/dir does not exist yet, there is nothing to violate.
    }

    for (const { label, file } of FORBIDDEN_NAMED_FILES) {
      const fullPath = path.join(srcRoot, file);
      if (fs.existsSync(fullPath)) {
        allFiles.push({ label, file: fullPath });
      }
    }

    for (const { label, file } of allFiles) {
      // Skip if the file is explicitly allowlisted
      if (ALLOWED_JOURNEY_ROUTE_FILES.has(file) || ALLOWED_JOURNEY_SRC_FILES.has(file)) continue;

      const src = readSrc(file);
      if (JOURNEY_TS_PATTERN.test(src)) {
        // Find which token(s) triggered the violation
        const found = JOURNEY_TS_TOKENS.filter((t) => src.includes(t));
        violations.push(
          `[${label}] ${rel(file)}: forbidden Journey token(s): ${found.join(", ")}`,
        );
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Journey isolation violated in ${violations.length} file(s):\n${violations.join("\n")}`,
    );
  });

  // ── 2. No GET route handler mentions Journey raw/shadow output ────────────

  it("no GET route handler body mentions Journey raw or shadow output tokens", () => {
    /**
     * We scan every route file that is NOT in the Journey allowlist and
     * look for Journey tokens that appear inside the textual vicinity of a
     * GET handler.  We use a pragmatic approach: extract text between each
     * `router.get(` opener and its matching next `router.` or end-of-file,
     * then test each chunk.
     */
    const routesDir = path.join(srcRoot, "routes");
    const violations: string[] = [];

    for (const entry of fs.readdirSync(routesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ts$/.test(entry.name)) continue;
      const file = path.join(routesDir, entry.name);
      // Skip files that are explicitly allowed to reference Journey tokens:
      // - journeyObservations.ts (the ingestion POST route)
      // - adminJourney.ts (future admin controls)
      // - locationPreferences.ts (user's own consent settings GET/PATCH)
      if (ALLOWED_JOURNEY_ROUTE_FILES.has(file) || ALLOWED_JOURNEY_SRC_FILES.has(file)) continue;

      const src = readSrc(file);

      // Extract all GET handler blocks heuristically.
      // A "block" runs from `router.get(` up to the next `router.` keyword
      // or to EOF.
      const getHandlerPattern = /router\.get\s*\(/g;
      const routeKeywordPattern = /\brouter\.(get|post|put|patch|delete|use)\s*\(/g;

      let getMatch: RegExpExecArray | null;
      while ((getMatch = getHandlerPattern.exec(src)) !== null) {
        const blockStart = getMatch.index;

        // Find next `router.` occurrence after this GET block starts
        routeKeywordPattern.lastIndex = blockStart + getMatch[0].length;
        const nextRoute = routeKeywordPattern.exec(src);
        const blockEnd = nextRoute ? nextRoute.index : src.length;

        const block = src.slice(blockStart, blockEnd);
        if (JOURNEY_TS_PATTERN.test(block)) {
          const found = JOURNEY_TS_TOKENS.filter((t) => block.includes(t));
          violations.push(`${rel(file)}: GET handler references Journey token(s): ${found.join(", ")}`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `GET routes must not expose Journey data. Violations:\n${violations.join("\n")}`,
    );
  });

  // ── 3. Only POST observation ingestion and admin-only controls may mention Journey ──

  it("only the Journey POST ingestion route and allowlisted admin controls reference Journey in routes/", () => {
    const routesDir = path.join(srcRoot, "routes");
    const violations: string[] = [];

    for (const entry of fs.readdirSync(routesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ts$/.test(entry.name)) continue;
      const file = path.join(routesDir, entry.name);

      // Allowlist: observation ingestion, admin journey (future), location prefs
      if (
        ALLOWED_JOURNEY_ROUTE_FILES.has(file) ||
        ALLOWED_JOURNEY_SRC_FILES.has(file)
      ) {
        continue;
      }

      const src = readSrc(file);
      if (JOURNEY_TS_PATTERN.test(src)) {
        const found = JOURNEY_TS_TOKENS.filter((t) => src.includes(t));
        violations.push(`${rel(file)}: unexpected Journey reference: ${found.join(", ")}`);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Only journeyObservations.ts, adminJourney.ts (future), and locationPreferences.ts may reference Journey in routes/.\n${violations.join("\n")}`,
    );
  });

  // ── 4. Non-route src files outside Journey/location-prefs allowlists ──────

  it("non-route source files outside the Journey allowlist contain no Journey tokens", () => {
    /**
     * Scans the full src tree (excluding routes/ which is covered above,
     * test/ which tests Journey on purpose, migrations/ covered separately)
     * and flags any file not in ALLOWED_JOURNEY_SRC_FILES.
     */
    const dirsToScan = ["compass", "services", "lib", "middlewares", "scripts", "types"];
    const violations: string[] = [];

    for (const dir of dirsToScan) {
      const fullDir = path.join(srcRoot, dir);
      for (const file of collectTsFiles(fullDir)) {
        if (ALLOWED_JOURNEY_SRC_FILES.has(file)) continue;

        const src = readSrc(file);
        if (JOURNEY_TS_PATTERN.test(src)) {
          const found = JOURNEY_TS_TOKENS.filter((t) => src.includes(t));
          violations.push(`${rel(file)}: unexpected Journey reference: ${found.join(", ")}`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Unexpected Journey references in non-Journey src files:\n${violations.join("\n")}`,
    );
  });

  // ── 5. Migration triggers/functions contain no writes from Journey tables
  //       into forbidden product tables ──────────────────────────────────────

  it("migration SQL triggers and functions do not write Journey data into forbidden product tables", () => {
    /**
     * Strategy:
     * 1. For each non-allowed SQL migration file, check whether it contains
     *    any Journey SQL token. If not, skip it.
     * 2. For each allowed Journey migration file, extract function/trigger
     *    bodies and scan for INSERT INTO / UPDATE / DELETE FROM targeting
     *    a forbidden product table.
     */
    const migrationsDir = path.join(srcRoot, "migrations");
    const violations: string[] = [];

    if (!fs.existsSync(migrationsDir)) return;

    const sqlFiles = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => path.join(migrationsDir, f));

    // Pattern: INSERT INTO <table> or UPDATE <table> or DELETE FROM <table>
    // where <table> is a forbidden product table.
    const buildProductWritePattern = () =>
      new RegExp(
        `(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?(?:${FORBIDDEN_PRODUCT_TABLES.join("|")})\\b`,
        "i",
      );
    const productWritePattern = buildProductWritePattern();

    for (const file of sqlFiles) {
      const sql = readSrc(file);

      if (ALLOWED_JOURNEY_MIGRATION_FILES.has(file)) {
        // These files are allowed to define Journey schema but must NOT write
        // into forbidden product tables FROM Journey trigger/function bodies.
        //
        // Heuristic: find CREATE FUNCTION / CREATE OR REPLACE FUNCTION blocks
        // and check for forbidden product table writes inside them.
        const functionBodyPattern =
          /(?:CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER)[\s\S]*?(?=\nCREATE\s|\nALTER\s|\nINSERT\s|\nDROP\s|\nREVOKE\s|\nGRANT\s|\nCOMMIT\s*;|\nROLLBACK\s*;|$)/gi;

        let fnMatch: RegExpExecArray | null;
        while ((fnMatch = functionBodyPattern.exec(sql)) !== null) {
          const body = fnMatch[0];

          // Skip if this function body doesn't reference any Journey token
          // (then it's not a Journey-triggered write).
          const hasJourneyRef = JOURNEY_SQL_TOKENS.some((t) =>
            body.toLowerCase().includes(t.toLowerCase()),
          );
          if (!hasJourneyRef) continue;

          // Now check whether the Journey function body writes to a forbidden
          // product table.
          if (productWritePattern.test(body)) {
            const found = FORBIDDEN_PRODUCT_TABLES.filter((t) => {
              const re = new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${t}\\b`, "i");
              return re.test(body);
            });
            violations.push(
              `${rel(file)}: Journey trigger/function writes into forbidden product table(s): ${found.join(", ")}`,
            );
          }
        }
      } else {
        // Non-Journey migration files must contain no Journey SQL tokens.
        const foundTokens = JOURNEY_SQL_TOKENS.filter((t) =>
          sql.toLowerCase().includes(t.toLowerCase()),
        );
        if (foundTokens.length > 0) {
          violations.push(
            `${rel(file)}: non-Journey migration references Journey SQL token(s): ${foundTokens.join(", ")}`,
          );
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Journey migration SQL boundary violations:\n${violations.join("\n")}`,
    );
  });

  // ── 6. Journey route emits only POST (no raw GET output exposed) ─────────

  it("journeyObservations route defines no GET handlers (no raw/shadow output exposed)", () => {
    const file = path.join(srcRoot, "routes", "journeyObservations.ts");
    const src = readSrc(file);

    // The route file must exist
    assert.ok(fs.existsSync(file), "journeyObservations.ts must exist");

    // No GET handler may be defined in the observation ingestion file
    assert.ok(
      !/router\.get\s*\(/.test(src),
      `${rel(file)}: Journey observation route must not expose any GET endpoint`,
    );

    // Must define at least one POST handler (the ingestion endpoint)
    assert.ok(
      /router\.post\s*\(/.test(src),
      `${rel(file)}: Journey observation route must define a POST ingestion endpoint`,
    );
  });

  // ── 7. The Journey POST route path itself is correctly scoped ────────────

  it("Journey POST route path is under /me/journey/ and not under a public or product namespace", () => {
    const file = path.join(srcRoot, "routes", "journeyObservations.ts");
    const src = readSrc(file);

    // Extract all route paths from router.post(...) calls
    const postPaths: string[] = [];
    const postPattern = /router\.post\s*\(\s*["'`]([^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = postPattern.exec(src)) !== null) {
      postPaths.push(m[1]);
    }

    assert.ok(postPaths.length > 0, "Journey route must define at least one POST path");

    for (const routePath of postPaths) {
      // Must be scoped to /me/journey/
      assert.ok(
        routePath.startsWith("/me/journey/") || routePath.startsWith("/admin/journey/"),
        `Journey POST path "${routePath}" must start with /me/journey/ or /admin/journey/`,
      );

      // Must not be under a forbidden product namespace
      const forbiddenPrefixes = [
        "/compass",
        "/discovery",
        "/pulse",
        "/notifications",
        "/trips/",
        "/plan",
        "/social",
        "/feed",
        "/messaging",
        "/ranking",
        "/autopilot",
        "/trust",
        "/analytics",
      ];
      for (const prefix of forbiddenPrefixes) {
        assert.ok(
          !routePath.startsWith(prefix),
          `Journey POST path "${routePath}" must not be under forbidden namespace "${prefix}"`,
        );
      }
    }
  });

  // ── 8. locationPreferences route does not expose raw Journey segment data ─

  it("locationPreferences route handles Journey consent settings but does not expose segment data", () => {
    const file = path.join(srcRoot, "routes", "locationPreferences.ts");
    if (!fs.existsSync(file)) return; // pre-creation state

    const src = readSrc(file);

    // Consent toggle references are allowed
    // Raw segment / observation data must NOT be returned
    const rawSegmentTokens = [
      "journey_segment_revisions",
      "journey_observations",
      "JourneySegmentationShadowService",
      "JourneySegmenter",
      "segmentJourney",
      "persistJourneySegmentsShadow",
      "measureJourneyShadowQuality",
      "shadowRevisionCount",
      "JourneySegmentRevision",
    ];

    const found = rawSegmentTokens.filter((t) => src.includes(t));
    assert.deepEqual(
      found,
      [],
      `locationPreferences route must not expose raw Journey segment/observation data. Found: ${found.join(", ")} in ${rel(file)}`,
    );
  });

  // ── 9. accountDeletion service must not consume Journey output for
  //       product features – it may only purge Journey tables ───────────────

  it("accountDeletion service does not consume Journey segment/observation output for product features", () => {
    const deletionDir = path.join(srcRoot, "services", "accountDeletion");
    const violations: string[] = [];

    // These tokens would indicate that accountDeletion is *reading* Journey
    // segment output for product decisions – a forbidden consumer pattern.
    // Directly deleting Journey tables for purge is permitted; the forbidden
    // pattern is SELECT/read usage of segment output or importing shadow services.
    const forbiddenConsumerTokens = [
      "JourneySegmentationShadowService",
      "JourneySegmenter",
      "segmentJourney",
      "persistJourneySegmentsShadow",
      "measureJourneyShadowQuality",
      "JourneyShadowMetrics",
      "JourneySegmentRevision",
      "JourneyObservationQuality",
    ];
    const forbiddenPattern = new RegExp(forbiddenConsumerTokens.join("|"));

    for (const file of collectTsFiles(deletionDir)) {
      // AccountDeletionService.ts is allowed (it purges Journey tables);
      // other files in the deletion directory must not consume Journey output.
      if (file === path.join(srcRoot, "services", "accountDeletion", "AccountDeletionService.ts")) {
        // For AccountDeletionService itself: verify it does NOT import shadow
        // segmentation services (i.e., it only purges, doesn't read output).
        const src = readSrc(file);
        if (forbiddenPattern.test(src)) {
          const found = forbiddenConsumerTokens.filter((t) => src.includes(t));
          violations.push(
            `${rel(file)}: accountDeletion must not import Journey shadow/segmentation services: ${found.join(", ")}`,
          );
        }
        continue;
      }
      // All other files in the deletion directory must contain no Journey tokens at all.
      const src = readSrc(file);
      if (JOURNEY_TS_PATTERN.test(src)) {
        const found = JOURNEY_TS_TOKENS.filter((t) => src.includes(t));
        violations.push(`${rel(file)}: unexpected Journey reference in accountDeletion helper: ${found.join(", ")}`);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `accountDeletion service boundary violation:\n${violations.join("\n")}`,
    );
  });

  // ── 10. Migrations allowlist is complete – no unknown Journey migrations ──

  it("all Journey migration files are accounted for in the allowlist", () => {
    const migrationsDir = path.join(srcRoot, "migrations");
    if (!fs.existsSync(migrationsDir)) return;

    const unknownJourneyMigrations: string[] = [];

    for (const entry of fs.readdirSync(migrationsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
      const file = path.join(migrationsDir, entry.name);

      if (ALLOWED_JOURNEY_MIGRATION_FILES.has(file)) continue;

      const sql = readSrc(file);
      const hasJourneyToken = JOURNEY_SQL_TOKENS.some((t) =>
        sql.toLowerCase().includes(t.toLowerCase()),
      );

      // Exclude references that are just comments or context (no structural
      // Journey DDL/DML).  We check for tokens that indicate structural usage:
      // CREATE TABLE/FUNCTION referencing a journey_ prefix, or DML on journey_ tables.
      const structuralJourneyPattern =
        /CREATE\s+(?:TABLE|FUNCTION|OR\s+REPLACE\s+FUNCTION|TRIGGER)\s+(?:public\.)?journey_|(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?journey_|ALTER\s+TABLE\s+(?:public\.)?journey_/i;

      if (hasJourneyToken && structuralJourneyPattern.test(sql)) {
        unknownJourneyMigrations.push(
          `${rel(file)}: contains structural Journey SQL but is not in the allowlist`,
        );
      }
    }

    assert.deepEqual(
      unknownJourneyMigrations,
      [],
      `New Journey migrations must be added to ALLOWED_JOURNEY_MIGRATION_FILES:\n${unknownJourneyMigrations.join("\n")}`,
    );
  });
});
