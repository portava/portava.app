/**
 * One-off live verification (final launch queue):
 *  A. Wizard fields → buddy profile at approval: apply with all 5 wizard
 *     fields, complete training via service role, approve as admin, then
 *     assert the 4 non-availability_blocks fields (display_name, bio,
 *     hourly_rate_usd, preferred_meetup_zones) are still on the ACTIVE
 *     profile after approval (availability_blocks asserted as a bonus).
 *  B. POST /admin/stamps/reconcile triggered once — assert a new
 *     reconciliation_run summary row lands in stamp_reconciliation_log.
 *
 * Ephemeral state: creates one admin and one buddy Supabase user; every
 * created user (even after a partial setup failure) and all buddy-side rows
 * (application, profile, training checklist, admin actions, trust events)
 * are deleted in the finally block.
 *
 * Persistent side effects (expected, deliberately kept):
 *  - the stamp_reconciliation_log run-summary row — the deliverable proof;
 *  - the stamp catalog admin audit entry written by the reconcile route;
 *  - catalog_id links the reconciler writes onto user_stamps/passport_stamps
 *    rows. Reconciliation is idempotent; these mutations are its purpose.
 *
 * Safety: refuses to run against non-local hosts unless ALLOW_REMOTE_VERIFY=1.
 *
 * Run: node --env-file-if-exists=.env --import tsx/esm src/scripts/verify-approval-and-reconcile.ts [baseUrl]
 */
import { createClient } from "@supabase/supabase-js";
import { TRAINING_CHECKLIST_ITEMS } from "../routes/rentABuddy.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.argv[2] ?? "http://localhost:80";

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE) && process.env.ALLOW_REMOTE_VERIFY !== "1") {
  console.error(`Refusing to run mutating verification against non-local host "${BASE}". Set ALLOW_REMOTE_VERIFY=1 to override.`);
  process.exit(1);
}

const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : " → " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

interface EphemeralUser { id: string; token: string; tag: string }
const createdUsers: EphemeralUser[] = [];

async function makeUser(tag: string, role?: string): Promise<EphemeralUser> {
  const email = `${tag}-${Date.now()}@example.com`;
  const password = `Vv1!${Math.random().toString(36).slice(2)}Xx`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${tag}): ${error.message}`);
  const id = created.user!.id;
  // Track immediately so a later setup failure still cleans this user up.
  const user: EphemeralUser = { id, token: "", tag };
  createdUsers.push(user);
  const { error: pErr } = await svc.from("profiles").upsert(
    { id, handle: `${tag}${Date.now()}`, name: `Verify ${tag}`, ...(role ? { role } : {}) },
    { onConflict: "id" },
  );
  if (pErr) throw new Error(`profiles upsert(${tag}): ${pErr.message}`);
  const anon = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: signin, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error(`signIn(${tag}): ${sErr.message}`);
  user.token = signin.session!.access_token;
  return user;
}

async function main() {
  let appId: string | null = null;
  let buddyId: string | null = null;

  try {
    const adminU = await makeUser("verifyadmin", "admin");
    const buddyU = await makeUser("verifybuddy");
    buddyId = buddyU.id;
    const AH = { "Content-Type": "application/json", Authorization: `Bearer ${adminU.token}` };
    const BH = { "Content-Type": "application/json", Authorization: `Bearer ${buddyU.token}` };

    // ── A. Wizard → approval field survival ────────────────────────────────
    console.log("A. wizard fields at approval");
    const payload = {
      city: "Manila", country: "PH", categories: ["city"], languages: ["English"],
      displayName: "Approval Verify Buddy", bio: "Ephemeral approval-time field-survival check.",
      hourlyRateUsd: 34, availability: [{ day: "tuesday", from: "10:00", to: "16:00" }],
      zones: ["Makati", "BGC"],
    };
    const applyRes = await fetch(`${BASE}/api/api/rent-a-buddy/apply`, { method: "POST", headers: BH, body: JSON.stringify(payload) });
    const applyBody = (await applyRes.json()) as any;
    check("apply returns 201", applyRes.status === 201, { status: applyRes.status, body: JSON.stringify(applyBody).slice(0, 200) });
    appId = applyBody?.application?.id ?? null;
    if (!appId) {
      const { data } = await svc.from("rent_buddy_applications").select("id").eq("user_id", buddyU.id).maybeSingle();
      appId = (data as any)?.id ?? null;
    }
    check("application id resolved", !!appId, applyBody);
    if (!appId) throw new Error("no application id — cannot continue");

    // Complete all training items via service role (keyed by application_id)
    const rows = TRAINING_CHECKLIST_ITEMS.map((it: { key: string }) => ({
      application_id: appId, user_id: buddyU.id, item_key: it.key,
      completed: true, completed_at: new Date().toISOString(),
    }));
    const { error: tErr } = await svc.from("rent_buddy_training_checklist").insert(rows);
    check("training checklist completed (service role)", !tErr, tErr?.message);

    // Approve as admin
    const apprRes = await fetch(`${BASE}/api/api/rent-a-buddy/admin/applications/${appId}`, {
      method: "PATCH", headers: AH, body: JSON.stringify({ status: "approved" }),
    });
    const apprBody = (await apprRes.json().catch(() => ({}))) as any;
    check("admin approval returns ok", apprRes.status === 200 && apprBody?.ok === true, { status: apprRes.status, body: apprBody });

    // Profile after approval — the 4 non-availability_blocks fields + active status
    const profRes = await fetch(`${BASE}/api/api/rent-a-buddy/me/profile`, { headers: BH });
    const prof = ((await profRes.json()) as any)?.profile ?? {};
    console.log("  profile after approval:", JSON.stringify(prof).slice(0, 400));
    check("display_name survives approval", prof.displayName === payload.displayName, prof.displayName);
    check("bio survives approval", prof.bio === payload.bio, prof.bio);
    check("hourly_rate_usd survives approval", prof.hourlyRateUsd === payload.hourlyRateUsd, prof.hourlyRateUsd);
    check("preferred_meetup_zones survive approval", JSON.stringify(prof.preferredMeetupZones) === JSON.stringify(payload.zones), prof.preferredMeetupZones);
    check("availability_blocks survive approval (bonus)", Array.isArray(prof.availabilityBlocks) && prof.availabilityBlocks.length === 1 && prof.availabilityBlocks[0]?.day === "tuesday", prof.availabilityBlocks);
    check("profile is active after approval", (prof.status ?? prof.adminStatus) === "active", { status: prof.status, adminStatus: prof.adminStatus });

    // Cross-check the live row directly — camelCase mapping aside
    const { data: liveRow } = await svc.from("rent_buddy_profiles")
      .select("display_name, bio, hourly_rate_usd, preferred_meetup_zones, availability_blocks, status")
      .eq("user_id", buddyU.id).maybeSingle();
    const lr = (liveRow ?? {}) as any;
    check("live row: all 4 fields present post-approval",
      lr.display_name === payload.displayName && lr.bio === payload.bio &&
      Number(lr.hourly_rate_usd) === payload.hourlyRateUsd &&
      JSON.stringify(lr.preferred_meetup_zones) === JSON.stringify(payload.zones) &&
      lr.status === "active",
      lr);

    // ── B. Stamp reconcile trigger ──────────────────────────────────────────
    console.log("B. stamps reconcile");
    const { count: before } = await svc.from("stamp_reconciliation_log")
      .select("id", { count: "exact", head: true }).eq("source_table", "reconciliation_run");
    const recRes = await fetch(`${BASE}/api/admin/stamps/reconcile`, { method: "POST", headers: AH });
    const recBody = (await recRes.json().catch(() => ({}))) as any;
    check("reconcile returns ok", recRes.status === 200 && recBody?.ok === true, { status: recRes.status, body: recBody });
    console.log("  stats:", JSON.stringify(recBody?.stats ?? {}));
    const { count: after } = await svc.from("stamp_reconciliation_log")
      .select("id", { count: "exact", head: true }).eq("source_table", "reconciliation_run");
    check(`run-summary row written (${before ?? 0} → ${after ?? 0})`, (after ?? 0) === (before ?? 0) + 1, { before, after });

    const runsRes = await fetch(`${BASE}/api/admin/stamps/reconcile/runs?limit=3`, { headers: AH });
    const runsBody = (await runsRes.json().catch(() => ({}))) as any;
    const first = runsBody?.runs?.[0];
    check("runs endpoint shows the fresh run", runsRes.status === 200 && !!first && first.ok === true, { status: runsRes.status, first });
    console.log("  latest run:", JSON.stringify(first ?? null));

    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    // Cleanup — every step best-effort; reconcile run row intentionally kept.
    if (appId) {
      await svc.from("rent_buddy_training_checklist").delete().eq("application_id", appId);
      await svc.from("rent_buddy_admin_actions").delete().eq("target_id", appId);
    }
    if (buddyId) {
      await svc.from("trust_events").delete().eq("user_id", buddyId);
      await svc.from("rent_buddy_profiles").delete().eq("user_id", buddyId);
      await svc.from("rent_buddy_applications").delete().eq("user_id", buddyId);
    }
    for (const u of createdUsers) {
      await svc.from("profiles").delete().eq("id", u.id);
      const { error } = await svc.auth.admin.deleteUser(u.id);
      console.log(`cleanup ${u.tag} ${u.id.slice(0, 8)}…:`, error ? error.message : "ok");
    }
  }
}

main().catch((e) => { console.error("VERIFY FAILED:", e?.message ?? e); process.exit(1); });
