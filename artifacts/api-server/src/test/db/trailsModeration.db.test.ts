/**
 * trailsModeration.db.test.ts — census-discovery §86 (lane W10-T), on the REAL
 * schema: 3485's flags, 3486's audited admin functions, 3487's serve count and
 * 3488's pending suggestions, driven through the service code over the real
 * supabase-js client (trailPostgrestBridge.ts, every statement as service_role).
 *
 *   W1  3485–3488 applied; both flags seeded FALSE
 *   W2  DC-04 / DV-74: §15 moderation moves and "Trail archive", each audited in its transaction; replay; conflict; refusal
 *   W3  DV-74 / E-5: "Trail merge" — what moves, what is dropped, what is resolved, and the audit row
 *   W4  the audit and review tables are append-only and closed to clients
 *   W5  DV-24: a pending declaration is not navigable; an audited acceptance is
 *   W6  DV-74: a suppressing trend review reaches GET …/trending
 *   W7  DV-22: the serve count counts once per member per page, and no client may call it
 *   W8  DC-04 / DV-21 / DV-22: the flag-on modules path moves a member through 3381 and stamps it (3486)
 *   W9  DC-20: a stranger's suggestion is pending, never a membership, and one per label; the owner accepts it
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, rows, seedUser } from "./localDb.js";
import { makeTrailBridge } from "./trailPostgrestBridge.js";
import { _setTestClient, _clearTestClient } from "../../lib/http.js";
import trailsRouter from "../../routes/trails.js";
import { getTrailModules, settleTrailModulesServe, trailTrending, relatedTrails, declareTrailRelation } from "../../services/trails/TrailService.js";
import { moveTrailLifecycleAsAdmin, mergeTrailsAsAdmin, reviewTrailEdgeAsAdmin, recordTrendIntegrityReview, curateTrailContentAsAdmin } from "../../services/trails/trailAdmin.js";
import { TRAIL_EXPLORATION_FLAG } from "../../services/trails/trailExploration.js";

const TAG = `mod${randomUUID().slice(0, 8)}`;
const users: string[] = [];
const bridge = HAVE_DB ? makeTrailBridge() : null;
const sc = () => bridge!.client;
const q = (s: string) => s.replace(/'/g, "''");

function user(label: string): string { const id = seedUser(`${TAG}${label}`); users.push(id); return id; }
function trail(state = "active", over: { parent?: string; createdBy?: string } = {}): string {
  const id = randomUUID();
  exec(`INSERT INTO public.trails (id, slug, title, lifecycle_status, parent_trail_id, created_by) VALUES ('${id}', '${TAG}-${id.slice(0, 8)}', '${TAG} ${id.slice(0, 8)}', '${state}', ${over.parent ? `'${over.parent}'` : "NULL"}, ${over.createdBy ? `'${over.createdBy}'` : "NULL"});`);
  return id;
}
function member(trailId: string, sourceType: string, sourceId: string, contributor: string | null, over: { relationship?: string; createdMsAgo?: number } = {}): string {
  const id = randomUUID();
  exec(`INSERT INTO public.content_trails (id, trail_id, source_type, source_id, relationship, contributor_id, created_at) VALUES ('${id}', '${trailId}', '${sourceType}', '${sourceId}', '${over.relationship ?? "supporting"}', ${contributor ? `'${contributor}'` : "NULL"}, now() - interval '${over.createdMsAgo ?? 60_000} milliseconds');`);
  return id;
}
function post(author: string): string {
  const id = randomUUID();
  exec(`INSERT INTO public.posts (id, author_id, content, visibility) VALUES ('${id}', '${author}', '${TAG} post', 'public');`);
  return id;
}
function canonicalPlace(): string {
  const id = randomUUID();
  exec(`INSERT INTO public.places (id, name, normalized_name) VALUES ('${id}', '${TAG} place', '${TAG} place');`);
  return id;
}
const audits = (subject: string) => rows<{ action: string; actor_user_id: string; reason: string; detail: any }>(
  `SELECT action, actor_user_id, reason, detail FROM public.discovery_admin_audit_events WHERE subject_id = '${subject}' ORDER BY created_at`);
const key = () => `${TAG}-${randomUUID()}`;

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";
async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  if (!HAVE_DB) return;
  for (const [what, sql] of [
    ["3485", "SELECT count(*) = 2 FROM public.feature_flags WHERE flag IN ('discovery_trail_exploration_enabled','discovery_trail_health_order_enabled')"],
    ["3486", "SELECT to_regprocedure('public.trail_admin_merge(uuid,uuid,uuid,text,text)') IS NOT NULL"],
    ["3487", "SELECT to_regclass('public.trail_member_exposures') IS NOT NULL"],
    ["3488", "SELECT to_regclass('public.trail_content_suggestions') IS NOT NULL"],
  ] as const) assert.equal(scalar(`${sql};`), "t", `${what} must be applied`);
  _setTestClient(bridge!.client, true);
  await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); server.listen(0, "127.0.0.1"); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  if (!HAVE_DB) return;
  server.close();
  _clearTestClient();
  exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${TRAIL_EXPLORATION_FLAG}';`);
  exec(`DELETE FROM public.trails WHERE slug LIKE '${TAG}-%';`);
  exec(`DELETE FROM public.posts WHERE content = '${TAG} post';`);
  exec(`DELETE FROM public.places WHERE name = '${TAG} place';`);
  // One statement for every user this suite made (one psql, one transaction), after the trails that referenced them.
  const ids = users.map((id) => `'${id}'`).join(", ");
  if (ids) exec(`DELETE FROM public.profiles WHERE id IN (${ids});\nDELETE FROM auth.users WHERE id IN (${ids});`, { single: true });
});

describe("W1 — 3485: both Trail ranking flags ship OFF", { skip: !HAVE_DB }, () => {
  test("seeded FALSE", () => {
    assert.equal(scalar("SELECT count(*) FROM public.feature_flags WHERE flag IN ('discovery_trail_exploration_enabled','discovery_trail_health_order_enabled') AND enabled;"), "0");
  });
});

describe("W2 — DC-04 / DV-74: §15's moves and `11` §8's archive, audited in the same transaction", { skip: !HAVE_DB }, () => {
  test("active → stale → active → needs_update → archived, one audit row each; replay; conflict; the terminal state refuses", async () => {
    const admin = user("w2a");
    const t = trail("active");
    for (const to of ["stale", "active", "needs_update", "archived"]) {
      const r = await moveTrailLifecycleAsAdmin(sc(), t, to, { userId: admin, reason: `${TAG} ${to}`, idempotencyKey: `${t}-${to}` });
      assert.ok(r.ok && !r.replayed, `${to}: ${JSON.stringify(r)}`);
    }
    assert.equal(scalar(`SELECT lifecycle_status FROM public.trails WHERE id = '${t}';`), "archived");
    const a = audits(t);
    assert.deepEqual(a.map((x) => [x.detail.from, x.detail.to]), [["active", "stale"], ["stale", "active"], ["active", "needs_update"], ["needs_update", "archived"]]);
    assert.ok(a.every((x) => x.actor_user_id === admin && x.action === "trail_lifecycle" && x.reason.startsWith(TAG)));
    const replay = await moveTrailLifecycleAsAdmin(sc(), t, "archived", { userId: admin, reason: `${TAG} archived`, idempotencyKey: `${t}-archived` });
    assert.ok(replay.ok && replay.replayed, "the same request under the same key is a replay");
    const conflict = await moveTrailLifecycleAsAdmin(sc(), t, "stale", { userId: admin, reason: "x", idempotencyKey: `${t}-archived` });
    assert.deepEqual(conflict.ok ? null : conflict.reason, "idempotency_key_reused");
    const revive = await moveTrailLifecycleAsAdmin(sc(), t, "active", { userId: admin, reason: `${TAG} revive`, idempotencyKey: key() });
    assert.deepEqual(revive.ok ? null : revive.reason, "transition_not_allowed");
    assert.equal(audits(t).length, 4, "a refused move writes no audit row");
    const noop = await moveTrailLifecycleAsAdmin(sc(), trail("stale"), "stale", { userId: admin, reason: "x", idempotencyKey: key() });
    assert.deepEqual(noop.ok ? null : noop.reason, "no_op");
    const noReason = await moveTrailLifecycleAsAdmin(sc(), trail("active"), "stale", { userId: admin, reason: " ", idempotencyKey: key() });
    assert.deepEqual(noReason.ok ? null : noReason.reason, "reason_required");
  });
});

describe("W3 — DV-74 / E-5: Trail merge", { skip: !HAVE_DB }, () => {
  test("members, followers, relationships, children and open reports move to the target; duplicates are dropped with their reports re-homed; the source is archived and points at the target", async () => {
    const [admin, author, f1, f2, reporter] = [user("w3a"), user("w3u"), user("w3f1"), user("w3f2"), user("w3r")];
    const [S, I, X, Y] = [trail(), trail(), trail(), trail()];
    const C = trail("active", { parent: S });
    const p1 = post(author);
    const [pl1, pl2] = [canonicalPlace(), canonicalPlace()];
    const m1 = member(S, "post", p1, author, { relationship: "primary" });
    const m2 = member(S, "place", pl1, author);
    const m3 = member(S, "place", pl2, author);
    const iPl2 = member(I, "place", pl2, author);
    exec(`INSERT INTO public.trail_follows (trail_id, user_id) VALUES ('${S}', '${f1}'), ('${S}', '${f2}'), ('${I}', '${f2}');`);
    exec(`INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type) VALUES ('${S}', '${X}', 'related'), ('${Y}', '${S}', 'related'), ('${S}', '${I}', 'related');`);
    exec(`INSERT INTO public.trail_reports (trail_id, content_trail_id, reported_by, reason) VALUES
      ('${S}', '${m3}', '${reporter}', 'wrong_place_link'), ('${S}', '${m2}', '${reporter}', 'unrelated_content'), ('${S}', NULL, '${reporter}', 'duplicate_trail');`);
    exec(`INSERT INTO public.trail_health_snapshots (trail_id, metrics, model_version, member_count) VALUES ('${S}', '{}'::jsonb, 'trail-health-v1', 3);`);

    const k = key();
    const r = await mergeTrailsAsAdmin(sc(), S, I, { userId: admin, reason: `${TAG} same theme`, idempotencyKey: k });
    assert.ok(r.ok, JSON.stringify(r));
    const d = (r as any).value.detail;
    assert.deepEqual([d.members_moved, d.members_dropped_as_duplicates, d.follows_moved, d.edges_rehomed, d.children_reparented, d.open_reports_moved, d.trail_reports_resolved_merged], [2, 1, 1, 2, 1, 2, 1]);

    assert.deepEqual(rows<{ id: string }>(`SELECT id FROM public.content_trails WHERE trail_id = '${I}' ORDER BY id`).map((x) => x.id).sort(), [m1, m2, iPl2].sort());
    assert.equal(scalar(`SELECT count(*) FROM public.content_trails WHERE id = '${m3}';`), "0", "the duplicate is dropped");
    assert.equal(scalar(`SELECT count(*) FROM public.content_trails WHERE source_type = 'post' AND source_id = '${p1}' AND relationship = 'primary';`), "1", "§4: still one primary");
    assert.equal(scalar(`SELECT content_trail_id::text || '|' || trail_id::text FROM public.trail_reports WHERE reason = 'wrong_place_link' AND reported_by = '${reporter}';`), `${iPl2}|${I}`, "the dropped member's open report follows it onto the target's row");
    assert.equal(scalar(`SELECT trail_id FROM public.trail_reports WHERE content_trail_id = '${m2}';`), I);
    assert.equal(scalar(`SELECT resolution FROM public.trail_reports WHERE trail_id = '${S}' AND reason = 'duplicate_trail';`), "merged");
    assert.deepEqual(rows<{ user_id: string }>(`SELECT user_id FROM public.trail_follows WHERE trail_id = '${I}'`).map((x) => x.user_id).sort(), [f1, f2].sort());
    assert.equal(scalar(`SELECT count(*) FROM public.trail_follows WHERE trail_id = '${S}';`), "0");
    assert.deepEqual(rows<{ e: string }>(`SELECT from_trail_id || '>' || to_trail_id || ':' || edge_type AS e FROM public.trail_edges WHERE '${I}' IN (from_trail_id, to_trail_id) ORDER BY 1`).map((x) => x.e).sort(),
      [`${I}>${X}:related`, `${Y}>${I}:related`].sort(), "re-homed, and the S→I edge did not become a self-edge");
    assert.equal(scalar(`SELECT count(*) FROM public.trail_edges WHERE '${S}' IN (from_trail_id, to_trail_id);`), "0");
    assert.equal(scalar(`SELECT parent_trail_id FROM public.trails WHERE id = '${C}';`), I);
    assert.equal(scalar(`SELECT lifecycle_status || '|' || merged_into_trail_id FROM public.trails WHERE id = '${S}';`), `archived|${I}`);
    assert.equal(scalar(`SELECT count(*) FROM public.trail_health_snapshots WHERE trail_id = '${S}';`), "1", "the source's history stays with it");
    const a = audits(S);
    assert.equal(a.length, 1);
    assert.equal(a[0]!.action, "trail_merge");
    assert.equal(a[0]!.actor_user_id, admin);

    const replay = await mergeTrailsAsAdmin(sc(), S, I, { userId: admin, reason: `${TAG} same theme`, idempotencyKey: k });
    assert.ok(replay.ok && replay.replayed);
    assert.equal(audits(S).length, 1);
  });
  test("refused, with nothing changed: the same Trail, an archived side, a target that descends from the source, an unknown Trail", async () => {
    const admin = user("w3b");
    const P = trail(); const Ch = trail("active", { parent: P }); const Gone = trail("archived");
    const m = member(P, "place", canonicalPlace(), null);
    for (const [from, into, reason] of [[P, P, "same_trail"], [P, Gone, "target_archived"], [Gone, P, "source_archived"], [P, Ch, "target_descends_from_source"], [P, randomUUID(), "unknown_target"]] as const) {
      const r = await mergeTrailsAsAdmin(sc(), from, into, { userId: admin, reason: `${TAG} x`, idempotencyKey: key() });
      assert.deepEqual(r.ok ? null : r.reason, reason);
    }
    assert.equal(scalar(`SELECT trail_id FROM public.content_trails WHERE id = '${m}';`), P);
    assert.equal(scalar(`SELECT lifecycle_status FROM public.trails WHERE id = '${P}';`), "active");
    assert.equal(audits(P).length, 0);
  });
});

describe("W4 — the audit and the reviews are append-only and closed to clients", { skip: !HAVE_DB }, () => {
  test("UPDATE and DELETE are refused even to service_role; anon and authenticated can neither read nor write", async () => {
    const admin = user("w4a");
    const t = trail();
    await moveTrailLifecycleAsAdmin(sc(), t, "stale", { userId: admin, reason: `${TAG} w4`, idempotencyKey: key() });
    for (const sql of [`UPDATE public.discovery_admin_audit_events SET reason = 'x' WHERE subject_id = '${t}'`, `DELETE FROM public.discovery_admin_audit_events WHERE subject_id = '${t}'`]) {
      // As the table's owner (no grant stands in the way), the append-only trigger refuses;
      const owner = exec(`DO $$ BEGIN ${sql}; RAISE EXCEPTION 'admitted'; EXCEPTION WHEN check_violation THEN NULL; END $$; SELECT 'refused';`);
      assert.equal(owner[0], "refused", `owner: ${sql}`);
      // as service_role, the grant already refuses (SELECT, INSERT only).
      const svc = exec(`SET LOCAL ROLE service_role; DO $$ BEGIN ${sql}; RAISE EXCEPTION 'admitted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$; SELECT 'refused';`, { single: true });
      assert.equal(svc[0], "refused", `service_role: ${sql}`);
    }
    assert.equal(audits(t).length, 1);
    for (const role of ["anon", "authenticated"]) {
      for (const tbl of ["discovery_admin_audit_events", "trend_integrity_reviews", "trail_member_exposures", "trail_content_suggestions"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.${tbl}', 'SELECT') OR has_table_privilege('${role}', 'public.${tbl}', 'INSERT');`), "f", `${role} on ${tbl}`);
      }
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.trail_record_member_exposures(uuid, jsonb, timestamptz)', 'EXECUTE');`), "f");
    }
  });
});

describe("W5 — DV-24: a pending declaration is not navigable; an audited acceptance is", { skip: !HAVE_DB }, () => {
  test("owner of one side proposes (pending, hidden); moderation accepts (navigable both ways) or rejects (hidden)", async () => {
    const [owner, other, admin] = [user("w5o"), user("w5x"), user("w5a")];
    const A = trail("active", { createdBy: owner }), B = trail("active", { createdBy: other }), B2 = trail("active", { createdBy: owner });
    const both = await declareTrailRelation(sc(), A, B2, "related", owner);
    assert.equal(both.reviewState, "accepted");
    const one = await declareTrailRelation(sc(), A, B, "geographic_sub", owner);
    assert.equal(one.reviewState, "pending");
    assert.equal((await declareTrailRelation(sc(), A, B, "related", user("w5s"))).refusal, "not_trail_owner");
    const kinds = async (t: string) => (await relatedTrails(sc(), t)).edges.map((e) => `${e.trail.id}:${e.edgeType}:${e.direction}`).sort();
    assert.deepEqual(await kinds(A), [`${B2}:related:out`]);
    const acc = await reviewTrailEdgeAsAdmin(sc(), A, B, "geographic_sub", "accepted", { userId: admin, reason: `${TAG} within`, idempotencyKey: key() });
    assert.ok(acc.ok);
    assert.deepEqual(await kinds(A), [`${B2}:related:out`, `${B}:geographic_sub:out`].sort());
    assert.deepEqual(await kinds(B), [`${A}:geographic_sub:in`]);
    assert.equal(audits(A).filter((x) => x.action === "trail_edge_review").length, 1);
    await reviewTrailEdgeAsAdmin(sc(), A, B, "geographic_sub", "rejected", { userId: admin, reason: `${TAG} no`, idempotencyKey: key() });
    assert.deepEqual(await kinds(B), []);
  });
});

describe("W6 — DV-74: a suppressing trend review reaches GET …/trending", { skip: !HAVE_DB }, () => {
  test("recorded with its audit row; the Trail answers not trending with no items; a later `cleared` lifts it", async () => {
    const [admin, viewer, feed] = [user("w6a"), user("w6v"), user("w6f")];
    const t = trail();
    const pl = randomUUID();
    member(t, "place", pl, null);
    exec(`INSERT INTO public.rank_events (user_id, item_id, item_kind, position, features, outcome, served_at, outcome_at, surface, schema_version, privacy_class)
          SELECT '${feed}', 'db/${pl}', 'gem', 0, '{}'::jsonb, 'save', now() - make_interval(mins => 60) - make_interval(secs => g), now() - make_interval(mins => 59), 'discovery', 1, 'raw_behavioral_event' FROM generate_series(1, 8) g;`);
    assert.equal((await call("GET", `/v1/discovery/trails/${t}/trending`, viewer)).body.trending, true);
    const r = await recordTrendIntegrityReview(sc(), "trail", t, "suppressed", { note: "burst" }, { userId: admin, reason: `${TAG} coordinated`, idempotencyKey: key() });
    assert.ok(r.ok);
    const sup = await call("GET", `/v1/discovery/trails/${t}/trending`, viewer);
    assert.equal(sup.body.trending, false);
    assert.deepEqual(sup.body.items, []);
    assert.equal(audits(t).filter((x) => x.action === "trend_integrity_review").length, 1);
    await new Promise((res) => setTimeout(res, 20));
    await recordTrendIntegrityReview(sc(), "trail", t, "cleared", {}, { userId: admin, reason: `${TAG} reviewed, organic`, idempotencyKey: key() });
    assert.equal((await trailTrending(sc(), t, Date.now(), { viewerId: viewer })).trendSuppressed, undefined);
  });
});

describe("W7 — DV-22: the Trail's own serve count", { skip: !HAVE_DB }, () => {
  test("one call counts each distinct member once; a second call adds one; junk is ignored", () => {
    const t = trail();
    const a = randomUUID(), b = randomUUID();
    const items = JSON.stringify([{ source_type: "place", source_id: a }, { source_type: "place", source_id: a }, { source_type: "post", source_id: b }, { source_type: "bogus", source_id: b }, { source_type: "place", source_id: "not-a-uuid" }]);
    const asService = (sql: string) => exec(`SET LOCAL ROLE service_role; ${sql}`, { single: true })[0];
    assert.equal(asService(`SELECT public.trail_record_member_exposures('${t}', '${q(items)}'::jsonb, now());`), "2");
    asService(`SELECT public.trail_record_member_exposures('${t}', '${q(items)}'::jsonb, now());`);
    assert.deepEqual(rows<{ k: string }>(`SELECT source_type || ':' || impressions AS k FROM public.trail_member_exposures WHERE trail_id = '${t}' ORDER BY 1`).map((x) => x.k), ["place:2", "post:2"]);
  });
});

describe("W8 — DC-04 / DV-21 / DV-22: the flag-on modules path, on the real schema", { skip: !HAVE_DB }, () => {
  test("a just_arrived member past its horizon is served as growing, moved through 3381 with 3486's stamp, and the page's serves are counted", async () => {
    const viewer = user("w8v");
    const t = trail();
    const [old, fresh] = [randomUUID(), randomUUID()];
    const mOld = member(t, "place", old, null, { createdMsAgo: 10 * 86_400_000 });
    const mFresh = member(t, "place", fresh, null, { createdMsAgo: 60_000 });
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = '${TRAIL_EXPLORATION_FLAG}';`);
    try {
      const r = await getTrailModules(sc(), t, { viewerId: viewer, pageSize: 8 });
      const where = (id: string) => r.modules.filter((m) => m.items.some((i) => i.id === id)).map((m) => m.key);
      assert.deepEqual(where(mOld), ["hidden_gems"]);
      assert.deepEqual(where(mFresh), ["just_arrived"]);
      await settleTrailModulesServe(sc(), t, r);
    } finally {
      exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${TRAIL_EXPLORATION_FLAG}';`);
    }
    assert.equal(scalar(`SELECT content_state || '|' || (content_state_changed_at IS NOT NULL) FROM public.content_trails WHERE id = '${mOld}';`), "growing|true");
    assert.equal(scalar(`SELECT content_state || '|' || (content_state_changed_at IS NULL) FROM public.content_trails WHERE id = '${mFresh}';`), "just_arrived|true");
    assert.equal(scalar(`SELECT sum(impressions) FROM public.trail_member_exposures WHERE trail_id = '${t}';`), "2");
    // OFF again: the same Trail is served as before §86 — the stored state, the four modules, nothing counted.
    const off = await getTrailModules(sc(), t, { viewerId: viewer, pageSize: 8 });
    assert.deepEqual(off.modules.map((m) => m.key), ["just_arrived", "trending_now", "evergreen", "local_picks"]);
    assert.equal(off.serveEffects, undefined);
  });
});

describe("W9 — DC-20: a stranger's suggestion waits for the owner and spends no §4 budget", { skip: !HAVE_DB }, () => {
  test("pending (one per label, a retry is a replay); the author still attaches their own primary; the author accepts", async () => {
    const [author, stranger] = [user("w9a"), user("w9s")];
    const [T1, T2] = [trail(), trail()];
    const p = post(author);
    const s1 = await call("POST", `/v1/discovery/trails/${T1}/suggestions`, stranger, { labels: [{ sourceType: "post", sourceId: p, relationship: "primary" }] });
    assert.equal(s1.status, 202);
    const s2 = await call("POST", `/v1/discovery/trails/${T1}/suggestions`, stranger, { labels: [{ sourceType: "post", sourceId: p, relationship: "primary" }] });
    assert.equal(s2.status, 202, "a retry answers the same");
    assert.equal(scalar(`SELECT count(*) FROM public.trail_content_suggestions WHERE source_id = '${p}' AND state = 'pending';`), "1");
    assert.equal(scalar(`SELECT count(*) FROM public.content_trails WHERE source_id = '${p}';`), "0");
    const own = await call("POST", `/v1/discovery/trails/${T2}/content`, author, { labels: [{ sourceType: "post", sourceId: p, relationship: "primary" }] });
    assert.equal(own.status, 201, "the stranger did not take the post's one primary slot");
    const id = scalar(`SELECT id FROM public.trail_content_suggestions WHERE source_id = '${p}';`)!;
    const acc = await call("POST", `/v1/discovery/trail-suggestions/${id}/accept`, author);
    assert.equal(acc.status, 409, "accepting a second primary is refused by §4 — the suggestion stays pending");
    assert.equal(scalar(`SELECT state FROM public.trail_content_suggestions WHERE id = '${id}';`), "pending");
    const dec = await call("POST", `/v1/discovery/trail-suggestions/${id}/decline`, author);
    assert.equal(dec.status, 200);
    assert.equal(scalar(`SELECT state || '|' || (decided_at IS NOT NULL) FROM public.trail_content_suggestions WHERE id = '${id}';`), "declined|true");
  });
});

describe("W10 — DV-21: Local Picks has its writer — an audited curate", { skip: !HAVE_DB }, () => {
  test("a curated member is served in local_picks; an existing label is marked curated; §4's cap still refuses; each writes one audit row", async () => {
    const [admin, author, viewer] = [user("w10a"), user("w10u"), user("w10v")];
    const t = trail("proposed");
    const p = post(author);
    const r = await curateTrailContentAsAdmin(sc(), t, { sourceType: "post", sourceId: p, relationship: "supporting" }, { userId: admin, reason: `${TAG} pick`, idempotencyKey: key() });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(scalar(`SELECT source || '|' || confidence FROM public.content_trails WHERE trail_id = '${t}' AND source_id = '${p}';`), "curated|0.9");
    assert.equal(scalar(`SELECT lifecycle_status FROM public.trails WHERE id = '${t}';`), "active", "curation is a Trail's first content, as attach is");
    const mods = await getTrailModules(sc(), t, { viewerId: viewer, pageSize: 8 });
    assert.deepEqual(mods.modules.find((m) => m.key === "local_picks")!.items.map((i) => i.sourceId), [p]);
    const own = member(t, "place", canonicalPlace(), null);
    const pl = scalar(`SELECT source_id FROM public.content_trails WHERE id = '${own}';`)!;
    const again = await curateTrailContentAsAdmin(sc(), t, { sourceType: "place", sourceId: pl, relationship: "supporting" }, { userId: admin, reason: `${TAG} mark`, idempotencyKey: key() });
    assert.equal(again.ok ? (again as any).value.mode : null, "marked");
    const other = trail();
    member(other, "post", p, author, { relationship: "primary" });
    const cap = await curateTrailContentAsAdmin(sc(), t, { sourceType: "post", sourceId: p, relationship: "primary" }, { userId: admin, reason: `${TAG} cap`, idempotencyKey: key() });
    assert.deepEqual(cap.ok ? null : cap.reason, "label_refused", "one primary Trail per content, whoever curates");
    assert.equal(audits(t).filter((x) => x.action === "trail_curate").length, 2);
  });
});
