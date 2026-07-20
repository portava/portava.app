/**
 * One-off live verification of the buddy surface against the live schema
 * (Task: availability_blocks column fix). Creates an ephemeral Supabase user,
 * exercises apply → me/profile → browse/search, then deletes the user.
 *
 * Run: node --env-file-if-exists=.env --import tsx/esm src/scripts/verify-buddy-live.ts <baseUrl>
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.argv[2] ?? "http://127.0.0.1:5000";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const email = `buddy-verify-${Date.now()}@example.com`;
  const password = `Vv1!${Math.random().toString(36).slice(2)}Xx`;
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (cErr) throw new Error("createUser: " + cErr.message);
  const userId = created.user!.id;
  console.log("ephemeral user:", userId);

  try {
    // Ensure a profiles row exists (FK target for rent_buddy_applications)
    const { error: pErr } = await admin.from("profiles").upsert(
      { id: userId, handle: `buddyverify${Date.now()}`, name: "Live Verify Buddy", display_name: "Live Verify Buddy" },
      { onConflict: "id" },
    );
    if (pErr) console.log("profiles upsert warning:", pErr.message);
    const anon = createClient(SUPABASE_URL, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? SERVICE_KEY, { auth: { persistSession: false } });
    const { data: signin, error: sErr } = await anon.auth.signInWithPassword({ email, password });
    if (sErr) throw new Error("signIn: " + sErr.message);
    const token = signin.session!.access_token;
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    // 1. Apply with all five wizard fields
    const payload = {
      city: "Manila", country: "PH", categories: ["city"], languages: ["English"],
      displayName: "Live Verify Buddy", bio: "Ephemeral verification profile for the availability_blocks live-column fix.",
      hourlyRateUsd: 21, availability: [{ day: "monday", from: "09:00", to: "17:00" }],
      zones: ["Makati"],
    };
    const applyRes = await fetch(`${BASE}/api/api/rent-a-buddy/apply`, { method: "POST", headers: H, body: JSON.stringify(payload) });
    const applyBody = await applyRes.json();
    console.log("apply:", applyRes.status, JSON.stringify(applyBody).slice(0, 300));
    if (applyRes.status !== 201) throw new Error("apply failed");

    // 2. Read back me/profile
    const profRes = await fetch(`${BASE}/api/api/rent-a-buddy/me/profile`, { headers: H });
    const prof = (await profRes.json()) as any;
    console.log("me/profile:", profRes.status);
    const p = prof.profile ?? {};
    const checks: Array<[string, boolean]> = [
      ["displayName", p.displayName === payload.displayName],
      ["bio", p.bio === payload.bio],
      ["hourlyRateUsd", p.hourlyRateUsd === 21],
      ["availabilityBlocks", Array.isArray(p.availabilityBlocks) && p.availabilityBlocks.length === 1
        && p.availabilityBlocks[0]?.day === "monday" && p.availabilityBlocks[0]?.from === "09:00" && p.availabilityBlocks[0]?.to === "17:00"],
      ["preferredMeetupZones", JSON.stringify(p.preferredMeetupZones) === JSON.stringify(payload.zones)],
    ];
    for (const [k, ok] of checks) console.log(`  round-trip ${k}: ${ok ? "OK" : "FAIL (" + JSON.stringify(p[k]) + ")"}`);
    if (checks.some(([, ok]) => !ok)) throw new Error("round-trip mismatch");

    // 3. Browse + search (BUDDY_PUBLIC_COLUMNS selects) — must not column-error
    for (const path of ["/api/api/buddies?city=Manila", "/api/api/rent-a-buddy/search"]) {
      const r = path.endsWith("/search")
        ? await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify({ city: "Manila" }) })
        : await fetch(`${BASE}${path}`, { headers: H });
      const b = await r.text();
      console.log(path, "→", r.status, b.slice(0, 200));
      if (r.status >= 500 || b.includes("availability_blocks") && b.includes("column")) throw new Error("read surface failed: " + path);
    }
    console.log("LIVE VERIFICATION PASSED");
  } finally {
    // Cleanup: profile/application rows then the user
    await admin.from("rent_buddy_profiles").delete().eq("user_id", userId);
    await admin.from("rent_buddy_applications").delete().eq("user_id", userId);
    await admin.from("profiles").delete().eq("id", userId);
    const { error: dErr } = await admin.auth.admin.deleteUser(userId);
    console.log("cleanup deleteUser:", dErr ? dErr.message : "ok");
  }
}

main().catch((e) => { console.error("VERIFY FAILED:", e.message); process.exit(1); });
