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
  "/api/buddies",
  "/api/rent-a-buddy/buddies/:buddyId",
  "/api/rent-a-buddy/bookings",
  "/api/rent-a-buddy/bookings/:bookingId",
  "/api/rent-a-buddy/bookings/:bookingId/accept",
  "/api/rent-a-buddy/bookings/:bookingId/decline",
  "/api/rent-a-buddy/bookings/:bookingId/start",
  "/api/rent-a-buddy/bookings/:bookingId/complete",
  "/api/rent-a-buddy/bookings/:bookingId/cancel",
  "/api/rent-a-buddy/bookings/:bookingId/events",
  "/api/me/buddy-services",
  "/api/me/buddy-availability-exceptions",
  "/api/rent-a-buddy/buddies/:buddyId/services",
  "/api/rent-a-buddy/buddies/:buddyId/availability-exceptions",
  "/api/rent-a-buddy/me/profile",
  "/api/rent-a-buddy/admin/buddies",
  "/api/rent-a-buddy/admin/applications",
  "/api/rent-a-buddy/admin/safety/flags",
  "/api/rent-a-buddy/admin/support/reports",
  "/api/rent-a-buddy/apply",
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

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
