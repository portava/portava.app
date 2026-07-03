/**
 * Live smoke test — §10 of the production migration runbook
 *
 * Verifies that migrations 0077–0080, 0088 have been applied and that the
 * previously-blocked routes respond with 200/201 instead of
 * "relation does not exist" (500).
 *
 * Requires:
 *   SUPABASE_URL              (Supabase project URL)
 *   SUPABASE_SERVICE_ROLE_KEY (service-role key — never logged or surfaced)
 *
 * Run:
 *   node --import tsx/esm artifacts/api-server/src/test/smoke-live.ts
 */

import { createClient } from "@supabase/supabase-js";

// ── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SERVICE_KEY  = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
const API_BASE     = "http://localhost:8080/api";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Result = { route: string; status: number; ok: boolean; note?: string };
const results: Result[] = [];

function pass(route: string, status: number, note?: string) {
  results.push({ route, status, ok: true, note });
}
function fail(route: string, status: number, note?: string) {
  results.push({ route, status, ok: false, note });
}

async function hit(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("=== Travel Buddy live smoke test (migration §10) ===\n");

  // 1. Create a temporary test user
  const email = `smoke-test-${Date.now()}@example.invalid`;
  const password = `Smoke-${Date.now()}-Test!`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    console.error("Could not create test user:", createErr?.message);
    process.exit(1);
  }
  const userId = created.user.id;
  console.log("Created test user:", userId, "\n");

  // 2. Sign in to get an access token
  const { data: session, error: signInErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (signInErr || !session) {
    console.error("Could not generate link:", signInErr?.message);
    await admin.auth.admin.deleteUser(userId);
    process.exit(1);
  }

  // Use service-role-signed token for this user
  const { data: tokenData, error: tokenErr } = await admin.auth.admin.getUserById(userId);
  if (tokenErr || !tokenData?.user) {
    console.error("Could not get user:", tokenErr?.message);
    await admin.auth.admin.deleteUser(userId);
    process.exit(1);
  }

  // Generate a session via signInWithPassword
  const anonClient = createClient(SUPABASE_URL, process.env["EXPO_PUBLIC_SUPABASE_ANON_KEY"] ?? SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signedIn, error: signedInErr } = await anonClient.auth.signInWithPassword({ email, password });
  if (signedInErr || !signedIn?.session) {
    console.error("Sign-in failed:", signedInErr?.message);
    await admin.auth.admin.deleteUser(userId);
    process.exit(1);
  }
  const token = signedIn.session.access_token;
  console.log("Signed in as test user\n");

  // 3. Create a profile row (required for trips.owner_id FK + membership lookups)
  // Note: profiles table does NOT have an email column.
  const { error: profileErr } = await admin.from("profiles").upsert({
    id: userId,
    handle: `smoke${Date.now()}`,
    name: "Smoke Test",
  });
  if (profileErr) {
    console.warn("Profile upsert warning:", profileErr.message);
    // Without a profile row the trip FK will fail — abort
    await admin.auth.admin.deleteUser(userId);
    process.exit(1);
  }
  console.log("Profile row created\n");

  // 4. Create a test trip via API (POST /trips)
  let tripId: string | null = null;
  {
    const r = await hit("POST", "/trips", token, {
      title: "Smoke Test Trip",
      destinationCity: "London",
    });
    if (r.status === 201 || r.status === 200) {
      tripId = r.json?.id ?? r.json?.trip?.id ?? null;
      pass("POST /trips (setup)", r.status);
    } else {
      fail("POST /trips (setup)", r.status, JSON.stringify(r.json));
    }
  }

  // 5. Wishlist GET
  {
    const r = await hit("GET", "/wishlist", token);
    if (r.status === 200) pass("GET  /wishlist", 200);
    else fail("GET  /wishlist", r.status, r.json?.message ?? r.json?.error);
  }

  // 6. Wishlist POST (add)
  {
    const r = await hit("POST", "/wishlist", token, {
      placeId: "node/99999999",
      placeData: { id: "node/99999999", name: "Smoke Test Café", category: "food" },
      listId: "global",
    });
    if (r.status === 201) pass("POST /wishlist (add)", 201);
    else fail("POST /wishlist (add)", r.status, r.json?.message ?? r.json?.error);
  }

  // 7. Wishlist DELETE (remove)
  {
    const r = await hit("DELETE", "/wishlist/node%2F99999999", token);
    if (r.status === 200) pass("DELETE /wishlist/:placeId", 200);
    else fail("DELETE /wishlist/:placeId", r.status, r.json?.message ?? r.json?.error);
  }

  if (tripId) {
    // 8. Trip destinations GET
    {
      const r = await hit("GET", `/trips/${tripId}/destinations`, token);
      if (r.status === 200) pass("GET  /trips/:id/destinations", 200);
      else fail("GET  /trips/:id/destinations", r.status, r.json?.message ?? r.json?.error);
    }

    // 9. Trip destinations POST
    {
      const r = await hit("POST", `/trips/${tripId}/destinations`, token, {
        city: "London",
        country: "GB",
        lat: 51.4706,
        lng: -0.4619,
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-10",
      });
      if (r.status === 201) pass("POST /trips/:id/destinations", 201);
      else fail("POST /trips/:id/destinations", r.status, r.json?.message ?? r.json?.error);
    }

    // 10. Trip notes GET
    {
      const r = await hit("GET", `/trips/${tripId}/notes`, token);
      if (r.status === 200) pass("GET  /trips/:id/notes", 200);
      else fail("GET  /trips/:id/notes", r.status, r.json?.message ?? r.json?.error);
    }

    // 11. Trip notes POST
    {
      const r = await hit("POST", `/trips/${tripId}/notes`, token, {
        content: "Smoke test note",
      });
      if (r.status === 201) pass("POST /trips/:id/notes", 201);
      else fail("POST /trips/:id/notes", r.status, r.json?.message ?? r.json?.error);
    }

    // 12. Trip checklists GET
    {
      const r = await hit("GET", `/trips/${tripId}/checklists`, token);
      if (r.status === 200) pass("GET  /trips/:id/checklists", 200);
      else fail("GET  /trips/:id/checklists", r.status, r.json?.message ?? r.json?.error);
    }

    // 13. Trip checklists POST (create list)
    let checklistId: string | null = null;
    {
      const r = await hit("POST", `/trips/${tripId}/checklists`, token, {
        title: "Smoke Test Checklist",
      });
      if (r.status === 201) {
        checklistId = r.json?.id ?? null;
        pass("POST /trips/:id/checklists", 201);
      } else {
        fail("POST /trips/:id/checklists", r.status, r.json?.message ?? r.json?.error);
      }
    }

    // 14. Trip checklist item POST (add item)
    if (checklistId) {
      const r = await hit("POST", `/trips/${tripId}/checklists/${checklistId}/items`, token, {
        label: "Pack passport",
      });
      if (r.status === 201) pass("POST /trips/:id/checklists/:id/items", 201);
      else fail("POST /trips/:id/checklists/:id/items", r.status, r.json?.message ?? r.json?.error);
    }
  } else {
    console.warn("No tripId — skipping trip sub-resource tests\n");
  }

  // ── Event sub-resource tests (migration 0080: event_cohosts, event_media) ──

  // Create a second test user so we can POST a co-host (cannot add yourself)
  const coHostEmail = `smoke-cohost-${Date.now()}@example.invalid`;
  const coHostPassword = `CoHost-${Date.now()}-Test!`;
  let coHostUserId: string | null = null;
  {
    const { data: coHostCreated } = await admin.auth.admin.createUser({
      email: coHostEmail,
      password: coHostPassword,
      email_confirm: true,
    });
    coHostUserId = coHostCreated?.user?.id ?? null;
    if (coHostUserId) {
      // co-host must have a profile row for FK safety
      await admin.from("profiles").upsert({
        id: coHostUserId,
        handle: `cohost${Date.now()}`,
        name: "Co-Host Test",
      }).then(undefined, () => {});
    }
  }

  // Insert a test event directly (bypass events_enabled feature flag)
  let eventId: string | null = null;
  {
    const { data: ev } = await admin.from("events").insert({
      host_id:       userId,
      title:         "Smoke Test Event",
      visibility:    "public",
      state:         "open",
      starts_at:     "2099-01-01T12:00:00Z",
      ends_at:       "2099-01-01T14:00:00Z",
      location_name: "Test Venue",
    }).select("id").single();
    eventId = (ev as any)?.id ?? null;

    // Also insert into event_roles so getEventRole() sees the host
    if (eventId) {
      await admin.from("event_roles").insert({
        event_id: eventId,
        user_id:  userId,
        role:     "host",
      }).then(undefined, () => {});
    }
  }

  if (eventId) {
    // 15. Event co-hosts POST (add co-host)
    if (coHostUserId) {
      const r = await hit("POST", `/events/${eventId}/cohosts`, token, {
        userId: coHostUserId,
        permissions: { manage_rsvps: true, manage_chat: true, post_updates: true },
      });
      if (r.status === 201) pass("POST /events/:id/cohosts", 201);
      else fail("POST /events/:id/cohosts", r.status, r.json?.message ?? r.json?.error);
    }

    // 16. Event co-hosts GET (host is staff — can list co-hosts)
    {
      const r = await hit("GET", `/events/${eventId}/cohosts`, token);
      if (r.status === 200) pass("GET  /events/:id/cohosts", 200);
      else fail("GET  /events/:id/cohosts", r.status, r.json?.message ?? r.json?.error);
    }

    // 17. Event media GET (host is staff — no RSVP required)
    {
      const r = await hit("GET", `/events/${eventId}/media`, token);
      if (r.status === 200) pass("GET  /events/:id/media", 200);
      else fail("GET  /events/:id/media", r.status, r.json?.message ?? r.json?.error);
    }

    // 17. Event media POST (host is staff — can upload)
    {
      const r = await hit("POST", `/events/${eventId}/media`, token, {
        mediaUrl:  "https://example.com/smoke-test-image.jpg",
        mediaType: "image",
        caption:   "Smoke test image",
      });
      if (r.status === 201) pass("POST /events/:id/media", 201);
      else fail("POST /events/:id/media", r.status, r.json?.message ?? r.json?.error);
    }
  } else {
    console.warn("No eventId — skipping event sub-resource tests\n");
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log("=== Results ===");
  const pad = (s: string, n: number) => s.padEnd(n);
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    console.log(`${icon} ${pad(r.route, 42)} HTTP ${r.status}${r.note ? "  → " + r.note : ""}`);
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);

  // ── Cleanup ────────────────────────────────────────────────────────────────

  if (tripId) {
    await admin.from("trips").delete().eq("id", tripId).then(undefined, () => {});
  }
  if (eventId) {
    await admin.from("events").delete().eq("id", eventId).then(undefined, () => {});
  }
  await admin.auth.admin.deleteUser(userId).then(undefined, () => {});
  if (coHostUserId) {
    await admin.auth.admin.deleteUser(coHostUserId).then(undefined, () => {});
  }
  console.log("Cleaned up test users, trip, and event.\n");

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Smoke test error:", err);
  process.exit(1);
});
