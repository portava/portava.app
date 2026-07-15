#!/usr/bin/env node
/**
 * Rent Buddy contract check script.
 * Validates that required route METHOD+PATH pairs are registered in route files,
 * that required DB tables/views exist in migrations, and that required enum types
 * exist in migrations.  Exits 0 on full pass, 1 if any check fails.
 *
 * Usage: pnpm --filter @workspace/scripts run check:rent-buddy-contract
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routeDir = path.resolve(__dirname, "../../artifacts/api-server/src/routes");
const migDir   = path.resolve(__dirname, "../../artifacts/api-server/migrations");

/**
 * [method, canonicalPath] pairs.
 * "canonicalPath" is the path registered in the router (after any app.ts alias rewrite).
 * app.ts rewrites:
 *   /api/me/buddy-profile         → /api/rent-a-buddy/me/profile
 *   /api/admin/buddy-reports      → /api/rent-a-buddy/admin/buddy-reports
 *   /api/admin/rent-a-buddy/*     → /api/rent-a-buddy/admin/*
 *   /api/admin/buddy-bookings/*   → /api/rent-a-buddy/admin/bookings/*
 *   /api/admin/buddy-payouts/*    → /api/rent-a-buddy/admin/payouts/*
 *   /api/buddies/*                → /api/rent-a-buddy/buddies/*
 */
const REQUIRED_ROUTES: Array<[string, string]> = [
  // Discovery
  ["get",    "/api/buddies"],
  ["get",    "/api/rent-a-buddy/buddies/:buddyId"],
  ["get",    "/api/rent-a-buddy/buddies/:buddyId/services"],
  ["get",    "/api/rent-a-buddy/buddies/:buddyId/availability-exceptions"],
  ["post",   "/api/rent-a-buddy/buddies/:buddyId/favorite"],
  ["post",   "/api/rent-a-buddy/buddies/:buddyId/unfavorite"],
  ["post",   "/api/rent-a-buddy/buddies/:buddyId/request"],
  // Bookings lifecycle
  ["get",    "/api/rent-a-buddy/bookings"],
  ["get",    "/api/rent-a-buddy/bookings/:bookingId"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/accept"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/decline"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/start"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/complete"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/cancel"],
  ["get",    "/api/rent-a-buddy/bookings/:bookingId/events"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/check-in"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/report-no-show"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/change-request"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/respond-change-request"],
  ["post",   "/api/rent-a-buddy/bookings/:bookingId/rebook"],
  // My services / exceptions / availability
  ["get",    "/api/me/buddy-services"],
  ["get",    "/api/me/buddy-availability-exceptions"],
  // Note: /api/me/buddy-bookings → /api/rent-a-buddy/bookings (via alias; same GET)
  ["get",    "/api/me/buddy-bookings"],
  // Buddy-requests and availability at me paths
  ["get",    "/api/me/buddy-requests"],
  ["patch",  "/api/me/buddy-availability"],
  ["patch",  "/api/me/buddy-availability-exceptions"],
  // My buddy profile (canonical path; app.ts rewrites /api/me/buddy-profile → here)
  ["get",    "/api/rent-a-buddy/me/profile"],
  ["post",   "/api/rent-a-buddy/me/profile"],
  ["get",    "/api/rent-a-buddy/me/profile/checklist"],
  ["post",   "/api/rent-a-buddy/me/profile/submit"],
  ["post",   "/api/rent-a-buddy/me/profile/pause"],
  ["post",   "/api/rent-a-buddy/me/profile/resume"],
  // Application
  ["post",   "/api/rent-a-buddy/apply"],
  // Admin — buddies
  ["get",    "/api/rent-a-buddy/admin/buddies"],
  ["get",    "/api/rent-a-buddy/admin/buddies/pending"],
  ["post",   "/api/rent-a-buddy/admin/buddies/:buddyId/approve"],
  ["post",   "/api/rent-a-buddy/admin/buddies/:buddyId/reject"],
  ["post",   "/api/rent-a-buddy/admin/buddies/:buddyId/unsuspend"],
  // Admin — applications
  ["get",    "/api/rent-a-buddy/admin/applications"],
  // Admin — safety & support
  ["get",    "/api/rent-a-buddy/admin/safety/flags"],
  // Admin — buddy reports (canonical path; app.ts rewrites /api/admin/buddy-reports → here)
  ["get",    "/api/rent-a-buddy/admin/buddy-reports"],
  // Admin — booking dispute resolution
  ["post",   "/api/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute"],
  // Admin — kill-switch / city / category controls
  ["post",   "/api/rent-a-buddy/admin/kill-switch"],
  ["get",    "/api/rent-a-buddy/admin/city-status"],
  ["post",   "/api/rent-a-buddy/admin/city-status"],
  ["post",   "/api/rent-a-buddy/admin/city-status/:city"],
  ["get",    "/api/rent-a-buddy/admin/category-status"],
  ["post",   "/api/rent-a-buddy/admin/category-status"],
  ["post",   "/api/rent-a-buddy/admin/category-status/:category"],
  // Admin — payouts
  ["post",   "/api/rent-a-buddy/admin/payouts/:payoutId/hold"],
  ["post",   "/api/rent-a-buddy/admin/payouts/:payoutId/release"],
];

const REQUIRED_TABLES: string[] = [
  "rent_buddy_profiles",
  "rent_buddy_bookings",
  "rent_buddy_applications",
  "rent_buddy_reviews",
  "rent_buddy_disputes",
  "rent_buddy_safety_checkins",
  "rent_buddy_safety_events",
  "rent_buddy_route_change_requests",
  "rent_buddy_saved",
  "rent_buddy_admin_actions",
  "rent_buddy_city_rollouts",
  "rent_buddy_launch_controls",
  "rent_buddy_payouts",
  "buddy_services",
  "buddy_availability_exceptions",
  "buddy_booking_events",
  "buddy_booking_checkins",
  "buddy_change_requests",
  "buddy_favorites",
  "buddy_booking_requests",
  "buddy_disputes",
  "buddy_profiles",
  "buddy_availability",
  "buddy_reviews",
];

const REQUIRED_ENUMS: string[] = [
  "rent_buddy_status",
  "rent_buddy_application_status",
  "rent_buddy_booking_status",
  "rent_buddy_payment_mode",
  "rent_buddy_safety_status",
  "rent_buddy_dispute_reason",
  "rent_buddy_dispute_status",
  "rent_buddy_checkin_type",
  "rent_buddy_safety_event_type",
  "rent_buddy_verification_status",
  "rent_buddy_change_request_status",
  "rent_buddy_payment_status",
];

// Read all route files into one combined string
const routeContent = fs.readdirSync(routeDir)
  .filter(f => f.endsWith(".ts"))
  .map(f => fs.readFileSync(path.join(routeDir, f), "utf8"))
  .join("\n");

// Read all migration files
const migContent = fs.readdirSync(migDir)
  .filter(f => f.endsWith(".sql"))
  .map(f => fs.readFileSync(path.join(migDir, f), "utf8"))
  .join("\n");

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}  ← MISSING`);
    failed++;
  }
}

/**
 * Check that a router.<method>("<path>") call exists in the route source.
 * Escapes the path pattern so :param segments match literally, then checks
 * for the combination of method + path in source code — not just the path
 * in any context (e.g. a comment).
 */
function routeExists(method: string, routePath: string): boolean {
  // Escape regex metacharacters except colon (for :param)
  const escapedPath = routePath
    .replace(/\./g, "\\.")
    .replace(/:[^/]+/g, "[^/\"\\']+");

  // Match: router.method( <quote> <path> <quote>
  const re = new RegExp(
    `router\\.${method}\\s*\\(\\s*["'\`]${escapedPath}["'\`]`,
    "m",
  );
  return re.test(routeContent);
}

console.log("\n=== Rent Buddy Contract Check ===\n");

console.log("Routes (method + path must match a router.<method>(\"path\") call in src/routes/*.ts):");
for (const [method, routePath] of REQUIRED_ROUTES) {
  check(`${method.toUpperCase()} ${routePath}`, routeExists(method, routePath));
}

console.log("\nTables / Views (must appear in migrations/*.sql or src/routes/*.ts):");
for (const table of REQUIRED_TABLES) {
  const inMig = new RegExp(
    `(CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${table}|CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${table}|'${table}')`,
    "i",
  ).test(migContent);
  const inRoutes = routeContent.includes(`"${table}"`);
  check(table, inMig || inRoutes);
}

console.log("\nEnum types (must appear in migrations/*.sql):");
for (const enumType of REQUIRED_ENUMS) {
  check(enumType, migContent.includes(enumType));
}

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
