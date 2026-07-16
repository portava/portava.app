// Smoke check for the settings-save flows fixed by migrations
// 0130 (user_account_states.updated_at), 0131 (location_mode CHECK),
// 0132 (passport_visibility_preferences columns), and 0108 (circle schema).
//
// Creates an ephemeral Supabase user via the Admin API, exercises the five
// save endpoints against the local API server, asserts 200s, and deletes the
// user. Run with the api-server workflow running:
//
//   node artifacts/api-server/scripts/smoke-settings-saves.mjs
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// Last run 2026-07-16: all five flows returned 200 (see docs/migrations.md).

const SB = process.env.SUPABASE_URL?.replace(/\/$/, "");
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !SRK) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const API = process.env.SMOKE_API_BASE ?? "http://localhost:80";
const email = `smoke-settings-${Date.now()}@example.com`;
const password = `Pw!${Math.random().toString(36).slice(2)}A1`;

const adminHeaders = {
  "Content-Type": "application/json",
  apikey: SRK,
  Authorization: `Bearer ${SRK}`,
};

const createRes = await fetch(`${SB}/auth/v1/admin/users`, {
  method: "POST",
  headers: adminHeaders,
  body: JSON.stringify({ email, password, email_confirm: true }),
});
const user = await createRes.json();
if (!user.id) {
  console.error("ephemeral user creation failed:", user);
  process.exit(1);
}

let failures = 0;
try {
  // API routes 404 users without a profiles row.
  const profileRes = await fetch(`${SB}/rest/v1/profiles`, {
    method: "POST",
    headers: { ...adminHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id: user.id,
      handle: `smoke_settings_${Date.now()}`,
      name: "Settings Smoke",
    }),
  });
  if (profileRes.status >= 300) {
    throw new Error(`profile upsert failed: ${profileRes.status} ${await profileRes.text()}`);
  }

  const tokenRes = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SRK },
    body: JSON.stringify({ email, password }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) throw new Error(`sign-in failed: ${JSON.stringify(token)}`);

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token.access_token}`,
  };

  const check = async (label, method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: authHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = (await res.text()).slice(0, 300);
    const ok = res.status === 200;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${res.status} ${text}`);
  };

  // Migration 0130 — deactivate/reactivate upsert updated_at.
  await check("deactivate", "POST", "/api/me/deactivate", {});
  await check("reactivate", "POST", "/api/me/reactivate", {});
  // Migration 0131 — location_mode CHECK must accept the API vocabulary.
  await check("location-mode", "PATCH", "/api/me/location-preferences", {
    locationMode: "nearby",
  });
  // Migration 0132 — visibility prefs columns must exist.
  await check("visibility-prefs", "PATCH", "/api/me/passport/visibility-preferences", {
    defaultStampVisibility: "circle_only",
    showCityMap: false,
  });
  // Migration 0108 — circle_visibility_settings table must exist for consent.
  await check("circle-consent", "PATCH", "/api/circle/settings", {
    globalEnabled: true,
    visibilityMode: "status_only",
    consentVersion: "v1",
  });
} finally {
  const del = await fetch(`${SB}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  console.log(`cleanup: ${del.status}`);
}

if (failures > 0) {
  console.error(`${failures} flow(s) failed`);
  process.exit(1);
}
console.log("all settings-save flows returned 200");
