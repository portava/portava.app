/**
 * PAY-002 — who writes a Rent-a-Buddy booking, read from the tree.
 *
 * Migration 3820 removes every client write privilege on rent_buddy_bookings
 * and rent_buddy_offers and takes the buddy_* compatibility views off their
 * owner's rights. That is only safe if no legitimate caller was using a client
 * privilege, and it only STAYS safe if none starts to. This file pins both:
 *
 *   A. The API's one Supabase client is built from the service-role key, and
 *      `requireUser` hands routes that same client — so `sc() ?? auth.client`
 *      is the service client on either side of the `??`.
 *   B. Exactly five places INSERT a booking, each on that client: the five API
 *      booking paths 3820's header lists.
 *   C. The app (travel-buddy-standalone) names none of the relations 3820
 *      bounds: it never reaches them through supabase-js, so no screen depends
 *      on the privileges that are gone.
 *
 * The behaviour itself — a client INSERT refused, the service INSERT working,
 * the party read unchanged — is src/test/db/rentBuddyBookingsWriteBoundary.db.test.ts,
 * against real PostgreSQL.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyBookingWriters.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../scripts/lib/stripComments.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = resolve(SRC, "../../../travel-buddy-standalone");

/** The relations 3820 bounds, and the nine views it takes off owner's rights. */
const BOUNDED = [
  "rent_buddy_bookings", "rent_buddy_offers",
  "buddy_availability", "buddy_booking_checkins", "buddy_booking_requests", "buddy_bookings",
  "buddy_change_requests", "buddy_disputes", "buddy_favorites", "buddy_profiles", "buddy_reviews",
];

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".expo" || name === "dist" || name === "build" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const code = (file: string) => stripComments(readFileSync(file, "utf8"));
const rel = (root: string, file: string) => relative(root, file).split("\\").join("/");

describe("PAY-002 — every booking write is the API's service client", () => {
  it("A. the API builds one Supabase client, from the service-role key, and requireUser hands routes that client", () => {
    const builders = walk(SRC, [".ts"])
      .filter((f) => !f.includes(`${join("src", "test")}`) && !f.includes(`${join("src", "scripts")}`) && !f.endsWith(".test.ts"))
      .filter((f) => /\bcreateClient\(/.test(code(f)))
      .map((f) => rel(SRC, f));
    assert.deepEqual(builders, ["lib/supabase.ts"], "a second Supabase client is built in the API; if it carries a user's JWT, 3820's boundary applies to it");

    const supabase = code(join(SRC, "lib", "supabase.ts"));
    assert.match(supabase, /createClient\(supabaseUrl, serviceRoleKey,/, "the API's client is no longer built from the service-role key");
    // The variable is NAMED here, so check:guard-coverage classes this file as
    // able to reach the database. It only matches source text; that is declared
    // in the EXEMPT list of scripts/check-guard-coverage.mjs, with the reason.
    assert.match(supabase, /const serviceRoleKey = process\.env\.SUPABASE_SERVICE_ROLE_KEY/);

    const http = code(join(SRC, "lib", "http.ts"));
    const requireUser = http.slice(http.indexOf("export async function requireUser("));
    assert.ok(requireUser.length > 100, "requireUser is gone from lib/http.ts");
    assert.match(requireUser.slice(0, 1500), /const client = \(_testClient \?\? getServiceClient\(\)!\) as SupabaseClient;/,
      "requireUser no longer returns the service client as `client`; `sc() ?? auth.client` could then be a user-scoped client");
  });

  it("B. exactly five places INSERT a booking, each on the service client", () => {
    const sites: string[] = [];
    for (const file of walk(SRC, [".ts"])) {
      if (file.includes(`${join("src", "test")}`) || file.endsWith(".test.ts")) continue;
      const text = code(file);
      // `<client>\n  .from("rent_buddy_bookings")\n  .insert(` — the client is the identifier the chain hangs from.
      for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.from\(\s*["'`](rent_buddy_bookings|buddy_bookings|buddy_booking_requests)["'`]\s*\)\s*\.(insert|upsert)\(/g)) {
        sites.push(`${rel(SRC, file)} ${m[1]}.${m[3]}(${m[2]})`);
      }
    }
    assert.deepEqual(sites.sort(), [
      "routes/rentABuddy.ts serviceClient.insert(rent_buddy_bookings)",
      "routes/rentABuddy.ts serviceClient.insert(rent_buddy_bookings)",
      "routes/rentABuddyMarketplace.ts svc.insert(rent_buddy_bookings)",
      "routes/rentABuddyMarketplace.ts svc.insert(rent_buddy_bookings)",
      "routes/rentABuddySpec.ts serviceClient.insert(rent_buddy_bookings)",
    ], "the set of booking INSERT sites changed. A new one must write through the service client and pass the gates the route applies (requireBookingKyc, the kill switches, the launch controls).");

    // `serviceClient` and `svc` are the service client in each of the three files.
    for (const [file, decl] of [
      ["routes/rentABuddy.ts", /function sc\(fallback\?: any\) \{\s*return getServiceClient\(\) \?\? fallback;\s*\}/],
      ["routes/rentABuddySpec.ts", /function sc\(fallback\?: any\) \{\s*return getServiceClient\(\) \?\? fallback;\s*\}/],
      ["routes/rentABuddyMarketplace.ts", /function sc\(\) \{\s*return getServiceClient\(\);\s*\}/],
    ] as const) {
      const text = code(join(SRC, file));
      assert.match(text, decl, `${file}: sc() is no longer the service client`);
      const named = [...text.matchAll(/const (serviceClient|svc) = ([^;]+);/g)].map((m) => m[2]!.trim());
      assert.ok(named.length >= 10, `${file}: expected many service-client bindings, found ${named.length}`);
      // The only fallback ever offered is requireUser's `client`, which A shows is the service client too.
      const odd = named.filter((v) => !/^sc\((auth\.client|client)?\)( \?\? (auth\.client|client))?$/.test(v));
      assert.deepEqual(odd, [], `${file}: a booking client is bound to something other than sc(): ${odd.join(" | ")}`);
    }
  });

  it("C. the app names none of the relations 3820 bounds", () => {
    assert.ok(statSync(APP).isDirectory(), "travel-buddy-standalone is not where this test expects it");
    const files = walk(APP, [".ts", ".tsx", ".js", ".jsx", ".mjs"]);
    assert.ok(files.length > 2000, `scanned only ${files.length} app files — the walker is broken`);

    // Vacuity: the same scan must find the direct reads the app is known to make.
    const direct = new Map<string, string[]>();
    const named: string[] = [];
    for (const file of files) {
      const text = code(file);
      for (const m of text.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g)) {
        direct.set(m[1]!, [...(direct.get(m[1]!) ?? []), rel(APP, file)]);
      }
      for (const name of BOUNDED) {
        if (new RegExp(`["'\`]${name}["'\`]`).test(text)) named.push(`${rel(APP, file)}: ${name}`);
      }
    }
    assert.ok(direct.has("profiles"), "the scan found no `.from('profiles')` in the app, which it is known to contain: the scan is not reading the code");
    assert.deepEqual(named, [], "the app names a relation 3820 removed client privileges from; that screen must go through the API");
    for (const name of BOUNDED) assert.ok(!direct.has(name), `the app reaches ${name} through supabase-js`);
  });
});
