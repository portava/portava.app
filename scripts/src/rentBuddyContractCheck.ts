#!/usr/bin/env node
/**
 * Rent Buddy contract check script.
 * Verifies that required route paths and DB table/view names exist in the
 * codebase.  Exits 0 on full pass, 1 if any check fails.
 *
 * Usage: pnpm --filter @workspace/scripts run check:rent-buddy-contract
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routeDir = path.resolve(__dirname, "../../artifacts/api-server/src/routes");
const migDir   = path.resolve(__dirname, "../../artifacts/api-server/migrations");

const REQUIRED_ROUTES: string[] = [
  // Discovery
  "/api/buddies",
  "/api/rent-a-buddy/buddies/:buddyId",
  "/api/rent-a-buddy/buddies/:buddyId/services",
  "/api/rent-a-buddy/buddies/:buddyId/availability-exceptions",
  "/api/rent-a-buddy/buddies/:buddyId/favorite",
  "/api/rent-a-buddy/buddies/:buddyId/unfavorite",
  "/api/rent-a-buddy/buddies/:buddyId/request",
  // Bookings
  "/api/rent-a-buddy/bookings",
  "/api/rent-a-buddy/bookings/:bookingId",
  "/api/rent-a-buddy/bookings/:bookingId/accept",
  "/api/rent-a-buddy/bookings/:bookingId/decline",
  "/api/rent-a-buddy/bookings/:bookingId/start",
  "/api/rent-a-buddy/bookings/:bookingId/complete",
  "/api/rent-a-buddy/bookings/:bookingId/cancel",
  "/api/rent-a-buddy/bookings/:bookingId/events",
  "/api/rent-a-buddy/bookings/:bookingId/check-in",
  "/api/rent-a-buddy/bookings/:bookingId/report-no-show",
  "/api/rent-a-buddy/bookings/:bookingId/change-request",
  "/api/rent-a-buddy/bookings/:bookingId/respond-change-request",
  "/api/rent-a-buddy/bookings/:bookingId/rebook",
  // My services / exceptions
  "/api/me/buddy-services",
  "/api/me/buddy-availability-exceptions",
  "/api/me/buddy-bookings",
  // My profile
  "/api/rent-a-buddy/me/profile",
  "/api/rent-a-buddy/me/profile/submit",
  "/api/rent-a-buddy/me/profile/pause",
  "/api/rent-a-buddy/me/profile/resume",
  // Application
  "/api/rent-a-buddy/apply",
  // Admin — buddies
  "/api/rent-a-buddy/admin/buddies",
  "/api/rent-a-buddy/admin/buddies/pending",
  "/api/rent-a-buddy/admin/buddies/:buddyId/approve",
  "/api/rent-a-buddy/admin/buddies/:buddyId/reject",
  "/api/rent-a-buddy/admin/buddies/:buddyId/unsuspend",
  // Admin — applications
  "/api/rent-a-buddy/admin/applications",
  // Admin — safety & support
  "/api/rent-a-buddy/admin/safety/flags",
  "/api/rent-a-buddy/admin/support/reports",
  // Admin — booking dispute resolution
  "/api/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute",
  // Admin — kill-switch / city / category controls
  "/api/rent-a-buddy/admin/kill-switch",
  "/api/rent-a-buddy/admin/city-status",
  "/api/rent-a-buddy/admin/category-status",
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

// Read all route files
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

console.log("\n=== Rent Buddy Contract Check ===\n");

console.log("Routes (must exist in src/routes/*.ts):");
for (const route of REQUIRED_ROUTES) {
  const escaped = route.replace(/:[^/]+/g, "[^/]+").replace(/\./g, "\\.");
  const re = new RegExp(`["'\`]${escaped}["'\`]`);
  check(route, re.test(routeContent));
}

console.log("\nTables / Views (must appear in migrations/*.sql or src/routes/*.ts):");
for (const table of REQUIRED_TABLES) {
  const inMig = new RegExp(
    `(CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${table}|CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${table})`,
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
