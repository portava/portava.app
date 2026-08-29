/**
 * End-to-end verification of the moderation FK fix (commit d88523a).
 *
 * WHY THIS EXISTS
 * ---------------
 * d88523a fixed `/admin/reports/:id/resolve`: it used to pass
 * `reports.target_id` (a CONTENT id) straight into
 * `moderation_actions.target_user_id`, which is `NOT NULL REFERENCES
 * profiles(id)`. For every non-user report that violated the FK, the
 * fail-closed audit aborted, and the endpoint 500'd before the report could be
 * resolved.
 *
 * That fix had only ever been exercised against the injected test client —
 * every moderation table was empty, so the FK itself had never rejected or
 * accepted a real row. This script drives the REAL route over HTTP, against
 * the REAL Supabase database, with a REAL admin JWT, and asserts what the
 * audit row actually contains.
 *
 * WHAT IS REAL AND WHAT IS NOT
 * ----------------------------
 * Real: the Express app from app.ts (all middleware, requireAdmin, the service
 * client), the HTTP request, the Supabase database, the FK constraint, and the
 * rows written. Nothing is stubbed or injected.
 *
 * The only concession is that the fixtures — content owner, reporter, admin,
 * post and report — are created by this script and deleted again at the end,
 * rather than being pre-existing production data. A temporary admin is minted
 * rather than borrowing the real one so that no existing account is touched or
 * signed into.
 *
 * SAFETY
 * ------
 * Every row this script creates is recorded and deleted in the `finally`
 * block, including on failure. It creates no persistent admin: the temporary
 * admin's auth user and profile are removed with everything else. Run with
 * --keep to leave the fixtures in place for manual inspection.
 *
 * Usage (from artifacts/api-server, with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set):
 *   node --import tsx/esm src/scripts/verifyModerationFkE2E.ts
 *
 * Exit 0 → every assertion passed. Exit 1 → an assertion failed.
 */

import { createClient } from "@supabase/supabase-js";
import type { Server } from "node:http";
import app from "../app.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const KEEP = process.argv.includes("--keep");

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error(
    "ERROR: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and an anon key must be set.",
  );
  process.exit(2);
}
if (SUPABASE_URL.includes("127.0.0.1")) {
  console.error("ERROR: SUPABASE_URL points at the test black-hole address.");
  process.exit(2);
}

const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Assertions ────────────────────────────────────────────────────────────────

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.log(`  ✘ ${label}`);
    if (detail !== undefined) {
      console.log(`      got: ${JSON.stringify(detail)}`);
    }
  }
}

// ── Fixture bookkeeping ───────────────────────────────────────────────────────

const stamp = process.pid.toString(36);
const createdUserIds: string[] = [];
let postId: string | null = null;
let reportId: string | null = null;
let server: Server | null = null;

async function makeUser(
  tag: string,
  role: "admin" | "user",
): Promise<{ id: string; email: string; password: string }> {
  const email = `modfk-e2e-${tag}-${stamp}@example.invalid`;
  const password = `E2e-${stamp}-${Math.abs(tag.length * 7919)}-Aa1!`;
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data?.user) {
    throw new Error(`createUser(${tag}) failed: ${error?.message}`);
  }
  const id = data.user.id;
  createdUserIds.push(id);

  // No trigger populates profiles from auth.users in this project, so the
  // profile row (which the FK actually points at) is inserted explicitly.
  const { error: pErr } = await svc.from("profiles").insert({
    id,
    handle: `modfk_${tag}_${stamp}`,
    name: `ModFK ${tag} ${stamp}`,
    role,
  });
  if (pErr) throw new Error(`profile insert(${tag}) failed: ${pErr.message}`);
  return { id, email, password };
}

async function main() {
  console.log("── Fixtures ──────────────────────────────────────────────");

  const owner = await makeUser("owner", "user");
  console.log(`  content owner : ${owner.id}`);
  const reporter = await makeUser("reporter", "user");
  console.log(`  reporter      : ${reporter.id}`);
  const admin = await makeUser("admin", "admin");
  console.log(`  admin         : ${admin.id}`);

  // The reported content: a real post authored by the owner.
  const { data: post, error: postErr } = await svc
    .from("posts")
    .insert({ author_id: owner.id, content: `modfk e2e ${stamp}` })
    .select("id, author_id")
    .single();
  if (postErr || !post) throw new Error(`post insert failed: ${postErr?.message}`);
  postId = (post as any).id;
  console.log(`  post          : ${postId} (author ${(post as any).author_id})`);

  // The report: target_id is the POST id, NOT a user id. This is exactly the
  // shape that used to violate the FK.
  const { data: report, error: repErr } = await svc
    .from("reports")
    .insert({
      reporter_id: reporter.id,
      target_type: "post",
      target_id: postId,
      reason_code: "spam",
      reason_detail: `modfk e2e ${stamp}`,
      status: "open",
    })
    .select("id, target_type, target_id, status")
    .single();
  if (repErr || !report) throw new Error(`report insert failed: ${repErr?.message}`);
  reportId = (report as any).id;
  console.log(`  report        : ${reportId} (target_type=post target_id=${postId})`);

  check(
    "report.target_id is the POST id, not a profile id (the FK-violating shape)",
    (report as any).target_id === postId && postId !== owner.id,
  );

  // ── Real admin session ──────────────────────────────────────────────────────
  const anon = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: session, error: signInErr } =
    await anon.auth.signInWithPassword({
      email: admin.email,
      password: admin.password,
    });
  const accessToken = session?.session?.access_token;
  if (signInErr || !accessToken) {
    throw new Error(`admin sign-in failed: ${signInErr?.message}`);
  }

  // ── Boot the real app ───────────────────────────────────────────────────────
  //
  // app.ts only, not index.ts: index.ts additionally starts the stamp worker
  // and FX refresh loops, which must not run against production from here.
  const port: number = await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => {
      const a = server!.address();
      typeof a === "object" && a ? resolve(a.port) : reject(new Error("no port"));
    });
    server!.on("error", reject);
  });
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n── Real request ──────────────────────────────────────────`);
  console.log(`  POST ${base}/api/admin/reports/${reportId}/resolve`);

  const res = await fetch(`${base}/api/admin/reports/${reportId}/resolve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "content_removed",
      notes: `modfk e2e ${stamp}`,
    }),
  });
  const bodyText = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    /* non-JSON body reported verbatim below */
  }
  console.log(`  → HTTP ${res.status} ${bodyText}`);

  console.log(`\n── Assertions ────────────────────────────────────────────`);
  check("endpoint returns 200 (it used to 500 on the FK violation)", res.status === 200, {
    status: res.status,
    body: bodyText,
  });
  check('response reports audit: "recorded" (not skipped_no_owner)', body?.audit === "recorded", body?.audit);
  check("report is now resolved", body?.report?.status === "resolved", body?.report);

  // ── What actually landed in the database ────────────────────────────────────
  const { data: actions, error: actErr } = await svc
    .from("moderation_actions")
    .select("id, target_user_id, action_type, reason, performed_by, metadata")
    .eq("metadata->>report_id", reportId!);
  if (actErr) throw new Error(`moderation_actions read failed: ${actErr.message}`);

  console.log(`\n  moderation_actions rows for this report: ${actions?.length ?? 0}`);
  if (actions?.length) console.log(`  ${JSON.stringify(actions[0], null, 2).replace(/\n/g, "\n  ")}`);

  check("exactly one moderation_actions row was written", actions?.length === 1, actions?.length);

  const row: any = actions?.[0];
  check(
    "target_user_id is the CONTENT OWNER (the post's author)",
    row?.target_user_id === owner.id,
    { got: row?.target_user_id, expectedOwner: owner.id },
  );
  check(
    "target_user_id is NOT the report's target_id (the old broken value)",
    row?.target_user_id !== postId,
    row?.target_user_id,
  );
  check(
    "target_user_id is NOT the acting admin (the old hide-content fallback)",
    row?.target_user_id !== admin.id,
    row?.target_user_id,
  );
  check("performed_by is the acting admin", row?.performed_by === admin.id, row?.performed_by);
  check("metadata.report_id carries the report id", row?.metadata?.report_id === reportId, row?.metadata?.report_id);
  check('metadata.target_type is "post"', row?.metadata?.target_type === "post", row?.metadata?.target_type);
  check("metadata.target_id carries the CONTENT id", row?.metadata?.target_id === postId, row?.metadata?.target_id);
  check("metadata does not flag the owner as unresolved", !row?.metadata?.owner_unresolved, row?.metadata);

  // The report row itself.
  const { data: finalReport } = await svc
    .from("reports")
    .select("status, reviewed_by, reviewed_at, moderation_notes")
    .eq("id", reportId!)
    .maybeSingle();
  check("reports.status is resolved", (finalReport as any)?.status === "resolved", finalReport);
  check("reports.reviewed_by is the admin", (finalReport as any)?.reviewed_by === admin.id, finalReport);
}

// ── Teardown ──────────────────────────────────────────────────────────────────

async function cleanup() {
  if (KEEP) {
    console.log("\n── Cleanup SKIPPED (--keep) ──────────────────────────────");
    console.log(`  users=${JSON.stringify(createdUserIds)} post=${postId} report=${reportId}`);
    return;
  }
  console.log("\n── Cleanup ───────────────────────────────────────────────");
  try {
    if (reportId) {
      await svc.from("moderation_actions").delete().eq("metadata->>report_id", reportId);
      await svc.from("reports").delete().eq("id", reportId);
    }
    if (postId) await svc.from("posts").delete().eq("id", postId);
    for (const id of createdUserIds) {
      await svc.from("profiles").delete().eq("id", id);
      await svc.auth.admin.deleteUser(id);
    }
    console.log("  fixtures removed");
  } catch (err) {
    console.error(`  ✘ cleanup error: ${(err as Error).message}`);
    console.error(`    users=${JSON.stringify(createdUserIds)} post=${postId} report=${reportId}`);
  }

  // Verify the tables are back to empty-for-this-run.
  const { count } = await svc
    .from("moderation_actions")
    .select("id", { count: "exact", head: true });
  console.log(`  moderation_actions rows remaining: ${count ?? "?"}`);
}

main()
  .catch((err) => {
    failures++;
    console.error(`\n✘ FATAL: ${(err as Error).message}`);
    console.error((err as Error).stack);
  })
  .finally(async () => {
    await cleanup();
    if (server) await new Promise((r) => server!.close(() => r(null)));
    console.log(
      failures === 0
        ? "\n✔ moderation FK e2e: ALL ASSERTIONS PASSED"
        : `\n✘ moderation FK e2e: ${failures} ASSERTION(S) FAILED`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
