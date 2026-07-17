/**
 * Verify seeded demo events appear in discovery endpoints.
 * Creates a temporary auth user if needed, signs in, and calls /api/events/*.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const sc = createClient(url, key, { auth: { persistSession: false } });
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
const publicClient = anonKey ? createClient(url, anonKey, { auth: { persistSession: false } }) : null;
const base = process.env.API_BASE ?? "http://localhost:80/api";

const testEmail = `demo.tester.${Date.now()}@example.com`;
const testPassword = `DemoPass_${Date.now()}!`;

async function main() {
  // Create a temporary confirmed user.
  const { data: created, error: createErr } = await sc.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    console.error("createUser failed:", createErr?.message);
    process.exit(1);
  }
  const userId = created.user.id;
  console.log("Created temp user:", userId, testEmail);

  // Create a profile with DOB so age gates pass; mark verified so verified-only events pass.
  const dob = "1990-01-01T00:00:00Z";
  const { error: profileErr } = await sc.from("profiles").insert({
    id: userId,
    handle: `demo_${Date.now()}`,
    name: "Demo Tester",
    verified: true,
    date_of_birth: dob,
    is_private: false,
  });
  if (profileErr) { console.error("profile insert failed:", profileErr.message); }

  // Sign in with email/password to get an access token.
  const client = publicClient ?? sc;
  const { data: signInData, error: signInErr } = await client.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });
  if (signInErr || !signInData?.session) {
    console.error("signIn failed:", signInErr?.message);
    process.exit(1);
  }
  const token = signInData.session.access_token;
  console.log("Signed in, token:", token.slice(0, 10) + "...");

  const headers = { Authorization: `Bearer ${token}` };
  const endpoints = [
    `/events?limit=5`,
    `/events/city/Seoul?limit=5`,
    `/events/city/Bangkok?limit=5`,
    `/events/city/Cebu?limit=5`,
    `/events/search?q=Sunset&limit=5`,
    `/events/me?limit=5`,
    `/events/hosting?limit=5`,
    `/events/joined?limit=5`,
  ];
  let firstEventId: string | null = null;
  for (const ep of endpoints) {
    const res = await fetch(`${base}${ep}`, { headers });
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    const events = body.events ?? body.items ?? body.hosted ?? body.attending ?? [];
    const count = Array.isArray(events) ? events.length : 0;
    if (count > 0 && !firstEventId && Array.isArray(events)) {
      firstEventId = events[0].id ?? events[0].eventId ?? null;
    }
    console.log(`${ep} → ${res.status} count=${count}`);
  }

  if (firstEventId) {
    const res = await fetch(`${base}/events/${firstEventId}`, { headers });
    const body = await res.json().catch(() => ({})) as Record<string, any>;
    console.log(`/events/${firstEventId} → ${res.status} title=${body.title ?? body.event?.title ?? body.id ?? "none"}`);
  }

  // Clean up the temporary user and its profile.
  await sc.from("profiles").delete().eq("id", userId);
  await sc.auth.admin.deleteUser(userId);
  console.log("Deleted temp user");
}

main().catch((err) => { console.error(err); process.exit(1); });
