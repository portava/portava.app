/**
 * Verify the seeded demo profile by generating a magic-link session for
 * anroletrading@gmail.com and calling each profile tab endpoint.
 *
 * Usage from artifacts/api-server:
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/verify-demo-profile.ts
 */

import { createClient } from "@supabase/supabase-js";

const email = process.env.SEED_EMAIL ?? "anroletrading@gmail.com";
const base = process.env.API_BASE ?? "http://localhost:80/api";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const sc = createClient(url, key, { auth: { persistSession: false } });
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
const publicClient = anonKey ? createClient(url, anonKey, { auth: { persistSession: false } }) : null;

async function main() {
  const { data: linkData, error: linkErr } = await sc.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !linkData?.properties?.action_link) {
    console.error("generateLink failed:", linkErr?.message);
    process.exit(1);
  }
  const link = linkData.properties.action_link;
  const token = new URL(link).searchParams.get("token");
  if (!token) {
    console.error("No token in magic link");
    process.exit(1);
  }

  const verifyClient = publicClient ?? sc;
  const { data: signInData, error: signInErr } = await verifyClient.auth.verifyOtp({
    email,
    token,
    type: "magiclink",
  });
  if (signInErr || !signInData?.session) {
    console.error("verifyOtp failed:", signInErr?.message);
    process.exit(1);
  }

  const accessToken = signInData.session.access_token;
  const user = signInData.user;
  console.log(`Signed in as ${user?.email ?? email} (${user?.id ?? "unknown"})`);

  const headers = { Authorization: `Bearer ${accessToken}` };
  const endpoints = [
    { path: "/users/anrole/posts?limit=5", key: "items" },
    { path: "/users/anrole/passport/postcards?limit=5", key: "postcards" },
    { path: "/users/anrole/trips?limit=5", key: "items" },
    { path: "/users/anrole/memories?limit=5", key: "items" },
    { path: "/users/anrole/highlights?limit=5", key: "items" },
    { path: "/stamps/profile/anrole?limit=5", key: "stamps" },
  ];

  for (const { path, key } of endpoints) {
    const res = await fetch(`${base}${path}`, { headers });
    const rawBody = await res.json().catch(() => ({}));
    const body = rawBody as Record<string, any>;
    const list = body[key];
    const count = Array.isArray(list) ? list.length : "?";
    const firstId = list?.[0]?.id ?? "none";
    console.log(`${path} → ${res.status} count=${count} firstId=${firstId}`);
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
