/**
 * mediaTrailReviewCapability — lead ruling D-66 (review before visible) on the
 * media side, on a database WITHOUT migration 3977.
 *
 * THE DEFECT (verifier V-M5 F1, CI node:test red on 9c0e9ff23b)
 * =============================================================
 * services/media/MediaActionResolver.ts names `trails.review_state` at two
 * doors — the plan compiler (`compileExperiencePlan`, reached under
 * COMPASS_ENABLED) and the rail's "Do this trail" action. 3977 is applied on
 * portava-ci and on no production database, so on production both selects
 * were rejected whole (42703): the rail action vanished silently and the
 * compiler answered db_error. check:flag-schema-prerequisites caught it as
 * NEW INSTANCES under COMPASS_ENABLED and (through the gem action's flag read
 * in the same function) hidden_gems_enabled, both ON in production.
 *
 * THE GUARD THIS PINS
 * ===================
 *   A  the capability: lib/media/trailReviewSchemaCapability.ts declares the
 *      one 3977 object the doors name, and its probe maps lib/capability's
 *      three verdicts to ready / absent / unreadable — only `ready` permits;
 *   B  the compiler: absent ⇒ source_unavailable, unreadable ⇒
 *      source_unreadable, and in both NO select names review_state except the
 *      probe's own sentinel read; content_trails is never read;
 *   C  the rail ("the hidden-gem path" the ratchet charged): absent or
 *      unreadable ⇒ no Trail action and no review_state select, while the rest
 *      of the rail still answers; ready ⇒ approved offered, pending not;
 *   D  the routes: the plan route answers 404 feature_disabled (absent) /
 *      500 db_error (unreadable), the rail route 200 without the action;
 *   E  structure: every trails select naming review_state in the resolver
 *      sits after a probeTrailReviewState call in its own function, and the
 *      real scan charges the column to COMPASS_ENABLED (registered ⇒ guarded,
 *      KNOWN-listed) and never to hidden_gems_enabled.
 *
 * Mutation log (each applied alone, suites run, source restored) — see the
 * lane M report, update 6.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/mediaTrailReviewCapability.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  TRAIL_REVIEW_STATE,
  TRAIL_REVIEW_STATE_COLUMNS,
  probeTrailReviewState,
} from "../lib/media/trailReviewSchemaCapability.js";
import { SCHEMA_PROBE_SENTINEL_ID } from "../lib/capability/schemaRequirement.js";
import { CAPABILITIES } from "../lib/capability/registry.js";
import { evaluateFlags, loadProductionSnapshot, scanFlagReads } from "../lib/capability/prerequisitesCore.js";
import { PRODUCTION_SNAPSHOT_FILENAME } from "../lib/capability/snapshots/current.js";
import { KNOWN } from "../scripts/checkFlagSchemaPrerequisites.js";
import { buildCanonicalSchema, hasColumn } from "../scripts/lib/canonicalSchema.js";
import { compileExperiencePlan, resolveMediaActions, withTrailDoThisAction } from "../services/media/MediaActionResolver.js";
import { resolveViewer } from "../services/media/MediaProjectionService.js";
import { toolCompilePlanFromExperience } from "../compass/CompassTools.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PKG_ROOT, "src");
const RESOLVER = join(SRC, "services", "media", "MediaActionResolver.ts");

// ── A schema-aware fake ──────────────────────────────────────────────────────
//
// `present`     3977 applied: every select answers.
// `absent`      production today: any trails select NAMING review_state is
//               rejected 42703, exactly as PostgreSQL / PostgREST reject it.
// `unreadable`  the column exists but every trails read naming it fails for
//               another reason (a timeout) — the probe's `unknown`.
// `no_table`    a database without 2910: trails itself is PGRST205.
// Every select is recorded (table, list, filters) so a test can prove which
// reads were ISSUED, not only what came back.

type Mode = "present" | "absent" | "unreadable" | "no_table";
type Dataset = Record<string, any[]>;
interface Seen { table: string; list: string; filters: Array<[string, unknown]> }

function makeSc(data: Dataset, mode: Mode) {
  const selects: Seen[] = [];
  const reads: string[] = [];
  const resolveRows = (table: string, filters: Array<(r: any) => boolean>) =>
    (data[table] ?? []).map((r) => ({ ...r })).filter((r) => filters.every((f) => f(r)));
  const builder = (table: string): any => {
    const filters: Array<(r: any) => boolean> = [];
    const seen: Seen = { table, list: "*", filters: [] };
    const error = () => {
      if (table !== "trails") return null;
      if (mode === "no_table") return { code: "PGRST205", message: "Could not find the table 'public.trails' in the schema cache" };
      if (!/\breview_state\b/.test(seen.list)) return null;
      if (mode === "absent") return { code: "42703", message: "column trails.review_state does not exist" };
      if (mode === "unreadable") return { code: "57014", message: "canceling statement due to statement timeout" };
      return null;
    };
    const answer = (single: boolean) => {
      const e = error();
      if (e) return { data: null, error: e };
      const rows = resolveRows(table, filters);
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const b: any = {
      select(list?: string) { seen.list = typeof list === "string" ? list : "*"; selects.push(seen); return b; },
      eq(col: string, val: any) { seen.filters.push([col, val]); filters.push((r) => String(r[col]) === String(val)); return b; },
      neq(col: string, val: any) { filters.push((r) => String(r[col]) !== String(val)); return b; },
      in(col: string, val: any[]) { const v = val.map(String); filters.push((r) => v.includes(String(r[col]))); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] > val); return b; },
      gte() { return b; },
      lte() { return b; },
      is(col: string, val: any) { filters.push((r) => (r[col] ?? null) === val); return b; },
      ilike() { return b; },
      like(col: string, val: any) { const pre = String(val).replace(/%$/, ""); filters.push((r) => String(r[col] ?? "").startsWith(pre)); return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve(answer(true)); },
      single() { return Promise.resolve(answer(true)); },
      then(onF: any, onR: any) { return Promise.resolve(answer(false)).then(onF, onR); },
    };
    return b;
  };
  return {
    selects,
    reads,
    from(table: string) { reads.push(table); return builder(table); },
    rpc() { return Promise.resolve({ data: null, error: { message: "no rpc in this fake" } }); },
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
  } as any;
}

/** Every trails select that names review_state OTHER than lib/capability's sentinel probe. */
function reviewStateReads(sc: { selects: Seen[] }): Seen[] {
  return sc.selects.filter(
    (s) => s.table === "trails" && /\breview_state\b/.test(s.list) &&
      !s.filters.some(([c, v]) => c === "id" && v === SCHEMA_PROBE_SENTINEL_ID),
  );
}
/** lib/capability's own probe of the column: the sentinel id, the declared list. */
function probeReads(sc: { selects: Seen[] }): Seen[] {
  return sc.selects.filter(
    (s) => s.table === "trails" && s.filters.some(([c, v]) => c === "id" && v === SCHEMA_PROBE_SENTINEL_ID),
  );
}

const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR_A = "22222222-2222-2222-2222-222222222222";
const PLACE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TRIP_1 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const MEDIA_1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const TRAIL_1 = "99999999-9999-9999-9999-999999999999";
const PENDING_TRAIL = "77777777-7777-7777-7777-777777777777";

function makePost(): any {
  return {
    id: MEDIA_1, author_id: AUTHOR_A, trip_id: null, content: "", visibility: "public", status: "active",
    post_status: "published", moderation_status: null, publish_at: null, expires_at: null, deleted_at: null,
    updated_at: new Date().toISOString(), created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    category: "nightlife", media_urls: [], location_name: "An Thuong Bar", location_city: "Da Nang",
    location_country: "Vietnam", location_privacy_mode: "none", canonical_place_id: PLACE_1,
    post_media: [{ id: `${MEDIA_1}-m1`, media_type: "image", public_url: `https://cdn.example/${MEDIA_1}.jpg`, thumbnail_url: null, duration_seconds: null, width: 1080, height: 1080, sort_order: 0, processing_status: "ready", moderation_status: null }],
    profiles: { id: AUTHOR_A, username: "maya", full_name: "Maya", name: "Maya", display_name: "Maya", avatar_url: null, verified: true, is_official: false, account_status: "active", is_private: false },
    location_lat: 16.0544, location_lng: 108.2497,
  };
}

/** A post in one Trail, a plan-editable trip for the viewer, and the Trail in the given review state. */
function railData(review: "approved" | "pending", trailId = TRAIL_1): Dataset {
  return {
    profiles: [
      { id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" },
      { id: AUTHOR_A, account_status: "active", passport_visibility: "public", is_private: false },
    ],
    blocks: [], user_mutes: [], user_follows: [], hidden_gems: [], feature_flags: [],
    intel_state_snapshots: [], intel_live_promoted_scopes: [],
    posts: [makePost()],
    trips: [{ id: TRIP_1, owner_id: AUTHOR_A, plan_edit_permission: "all_members", visibility: "public", title: "Da Nang week", start_date: null, end_date: null }],
    trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" }],
    content_trails: [
      { trail_id: trailId, source_type: "post", source_id: MEDIA_1 },
      { trail_id: trailId, source_type: "place", source_id: PLACE_1, content_state: "published", created_at: "2026-01-01T00:00:00Z" },
      { trail_id: trailId, source_type: "place", source_id: "place-2", content_state: "published", created_at: "2026-01-02T00:00:00Z" },
    ],
    trails: [{ id: trailId, review_state: review, lifecycle_status: "active", title: "Night walk" }],
  };
}

async function railFor(data: Dataset, mode: Mode) {
  invalidateFlagsCache();
  _clearPromotedScopeCache();
  const sc = makeSc(data, mode);
  const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
  const set = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
  return { sc, set };
}

const viewerStub = { viewerId: VIEWER, isAdmin: false, blockedIds: new Set<string>(), followingIds: new Set<string>() } as any;

// ── A ────────────────────────────────────────────────────────────────────────

describe("A — the capability declares 3977's object, and only `ready` permits", () => {
  it("requires exactly trails.review_state, names 3977, and every object is declared by a migration", () => {
    assert.deepEqual(Object.keys(TRAIL_REVIEW_STATE.requires.tables), ["trails"]);
    assert.deepEqual([...TRAIL_REVIEW_STATE.requires.tables.trails!.columns], ["review_state"]);
    assert.deepEqual([...TRAIL_REVIEW_STATE_COLUMNS], ["review_state"]);
    assert.deepEqual([...TRAIL_REVIEW_STATE.providedBy], ["3977_trail_review_before_visible.sql"]);
    assert.ok(existsSync(join(SRC, "migrations", "3977_trail_review_before_visible.sql")), "the named migration is on disk");
    const canon = buildCanonicalSchema(join(PKG_ROOT, "baseline", "20260819_baseline_structure.sql"), [join(PKG_ROOT, "migrations"), join(SRC, "migrations")]);
    assert.ok(hasColumn(canon, "trails", "review_state"), "a migration in the tree declares trails.review_state");
    // Its id is 3977's own seeded flag, and no other definition (registered or not) shares it — the probe memo is keyed by it.
    const sql = readFileSync(join(SRC, "migrations", "3977_trail_review_before_visible.sql"), "utf8");
    assert.match(sql, /INSERT INTO public\.feature_flags[\s\S]*'trail_creation_enabled'/);
    assert.equal(CAPABILITIES[TRAIL_REVIEW_STATE.flag], undefined, "not registered (see the module header)");
    for (const def of Object.values(CAPABILITIES)) assert.notEqual(def.flag, TRAIL_REVIEW_STATE.flag);
    assert.deepEqual(TRAIL_REVIEW_STATE.consumers, ["services/media/MediaActionResolver.ts"]);
  });

  it("maps lib/capability's verdicts: present → ready; 42703 / PGRST205 → absent; any other failure or a throw → unreadable", async () => {
    const data: Dataset = { trails: [] };
    assert.equal(await probeTrailReviewState(makeSc(data, "present")), "ready");
    assert.equal(await probeTrailReviewState(makeSc(data, "absent")), "absent");
    assert.equal(await probeTrailReviewState(makeSc(data, "no_table")), "absent");
    assert.equal(await probeTrailReviewState(makeSc(data, "unreadable")), "unreadable");
    const throws = { from() { throw new Error("network down"); } };
    assert.equal(await probeTrailReviewState(throws), "unreadable", "a probe that throws is not a yes");
    const silent = { from() { return { select() { return this; }, eq() { return this; }, maybeSingle: async () => undefined }; } };
    assert.equal(await probeTrailReviewState(silent), "unreadable", "an answer with no error field is not a yes");
  });

  it("the probe is ONE sentinel read naming exactly the declared column — never a user row", async () => {
    const sc = makeSc({ trails: [{ id: TRAIL_1, review_state: "approved" }] }, "present");
    await probeTrailReviewState(sc);
    await probeTrailReviewState(sc); // memoised: no second round trip
    assert.equal(sc.selects.length, 1);
    assert.deepEqual(sc.selects[0], { table: "trails", list: "review_state", filters: [["id", SCHEMA_PROBE_SENTINEL_ID]] });
  });

  it("the wrapper delegates to lib/capability and is consulted only through the schema half", () => {
    const mod = readFileSync(join(SRC, "lib", "media", "trailReviewSchemaCapability.ts"), "utf8");
    assert.ok(mod.includes('from "../capability/schemaCapability.js"'));
    assert.ok(!/\.from\(\s*["']trails["']/.test(mod), "a second probe implementation would drift from the first");
    for (const src of [mod, readFileSync(RESOLVER, "utf8")]) {
      assert.ok(!/(resolveCapability|requireCapability)\(\s*[^,]+,\s*TRAIL_REVIEW_STATE/.test(src), "no flag read is added to a Trail's visibility");
    }
  });
});

// ── B ────────────────────────────────────────────────────────────────────────

describe("B — the plan compiler refuses before naming the column", () => {
  const data = railData("approved");
  const run = (sc: any) => compileExperiencePlan(sc, viewerStub, { kind: "trail", id: TRAIL_1 }, { day: "2026-10-03", nowMs: 0 });

  it("3977 absent: source_unavailable, one probe read, no review_state select, content_trails never named", async () => {
    const sc = makeSc(data, "absent");
    assert.deepEqual(await run(sc), { ok: false, reason: "source_unavailable" });
    assert.equal(reviewStateReads(sc).length, 0, JSON.stringify(sc.selects));
    assert.equal(probeReads(sc).length, 1);
    assert.deepEqual(sc.reads, ["trails"], "nothing but the probe");
  });

  it("probe unreadable: source_unreadable, and still no review_state select (fail closed, not 'approved')", async () => {
    const sc = makeSc(data, "unreadable");
    assert.deepEqual(await run(sc), { ok: false, reason: "source_unreadable" });
    assert.equal(reviewStateReads(sc).length, 0);
    assert.deepEqual(sc.reads, ["trails"]);
  });

  it("3977 present: an approved Trail compiles (the read is issued), a pending one is not_eligible", async () => {
    const sc = makeSc(data, "present");
    const ok = await run(sc);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(reviewStateReads(sc).length, 1, "the gate read is issued once the probe says ready");
    assert.deepEqual(await run(makeSc(railData("pending"), "present")), { ok: false, reason: "not_eligible" });
  });

  it("the Compass tool (the COMPASS_ENABLED door) carries the refusal, with no plan and no review_state select", async () => {
    const sc = makeSc(data, "absent");
    const r: any = await toolCompilePlanFromExperience(sc, VIEWER, { sourceKind: "trail", sourceId: TRAIL_1, day: "2026-10-03" });
    assert.equal(r.plan, null);
    assert.equal(r.reason, "source_unavailable");
    assert.equal(reviewStateReads(sc).length, 0);
  });
});

// ── C ────────────────────────────────────────────────────────────────────────

describe("C — the media rail omits the Trail action before naming the column", () => {
  for (const mode of ["absent", "unreadable"] as const) {
    it(`${mode}: no "Do this trail", no review_state select, and the rest of the rail still answers`, async () => {
      const { sc, set } = await railFor(railData("approved"), mode);
      assert.ok(set, "the rail answers");
      const ids = set!.actions.map((a) => a.id);
      assert.equal(ids.includes("do_this_experience"), false, `${mode}: an unreadable review state is not approved`);
      assert.ok(ids.includes("directions"), "control: the rail is otherwise intact");
      assert.equal(reviewStateReads(sc).length, 0, JSON.stringify(reviewStateReads(sc)));
      assert.equal(probeReads(sc).length, 1, "lib/capability was asked, once");
    });
  }

  it("present: an approved Trail is offered; a pending Trail is not (D-66 both directions)", async () => {
    const approved = await railFor(railData("approved"), "present");
    const a = approved.set!.actions.find((x) => x.id === "do_this_experience");
    assert.ok(a, "approved Trail offered");
    assert.equal(a!.label, "Do this trail");
    assert.equal(a!.target.params?.experienceId, TRAIL_1);
    assert.deepEqual(a!.target.params?.editableTripIds, [TRIP_1]);
    assert.equal(reviewStateReads(approved.sc).length, 1);
    const pending = await railFor(railData("pending", PENDING_TRAIL), "present");
    assert.equal(pending.set!.actions.some((x) => x.id === "do_this_experience"), false);
  });

  it("withTrailDoThisAction: no editable trip ⇒ no probe and no read; an existing Do-this keeps the rail at one", async () => {
    const sc = makeSc(railData("approved"), "present");
    assert.deepEqual(await withTrailDoThisAction(sc, MEDIA_1, [], []), []);
    assert.equal(sc.selects.length, 0);
    const existing = [{ id: "do_this_experience", label: "Do this", outcome: "plan", target: { method: "GET", endpoint: "/x" } }] as any;
    const out = await withTrailDoThisAction(sc, MEDIA_1, existing, [TRIP_1]);
    assert.equal(out.filter((x) => x.id === "do_this_experience").length, 1);
    assert.notEqual(out, existing, "the input array is not mutated");
  });
});

// ── D ────────────────────────────────────────────────────────────────────────

describe("D — the routes", () => {
  let server: ReturnType<typeof createServer> | null = null;
  after(() => { server?.close(); _clearTestClient(); });

  it("absent: the plan route answers 404 feature_disabled, the rail route 200 without the action — no review_state select on either", async () => {
    const express = (await import("express")).default;
    const { default: router } = await import("../routes/mediaActions.js");
    const sc = makeSc(railData("approved"), "absent");
    _setTestClient(sc, true);
    const app = express();
    app.use((req: any, _res: any, next: any) => { req.log = { info() {}, error() {}, warn() {}, debug() {} }; next(); });
    app.use("/api", router);
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const auth = { headers: { Authorization: "Bearer t" } };

    const plan = await fetch(`http://127.0.0.1:${port}/api/media/experiences/${TRAIL_1}/plan?compile=1&source=trail&day=2026-10-03`, auth);
    assert.equal(plan.status, 404);
    const body: any = await plan.json();
    assert.equal(body.code ?? body.error?.code ?? body.error, "feature_disabled", JSON.stringify(body));

    invalidateFlagsCache();
    const rail = await fetch(`http://127.0.0.1:${port}/api/media/${MEDIA_1}/actions`, auth);
    assert.equal(rail.status, 200);
    const railBody: any = await rail.json();
    assert.equal(railBody.actions.some((a: any) => a.id === "do_this_experience"), false);
    assert.equal(reviewStateReads(sc).length, 0, JSON.stringify(reviewStateReads(sc)));
  });
});

// ── E ────────────────────────────────────────────────────────────────────────

/** `.from("<t>")` at the root of a call chain. */
function chainTable(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      if (cur.expression.name.text === "from") {
        const a = cur.arguments[0];
        return a && ts.isStringLiteralLike(a) ? a.text : null;
      }
      cur = cur.expression.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isAwaitExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return null;
  }
}

describe("E — structure: the probe precedes every read, and the ratchet sees it guarded", () => {
  it("every trails select naming review_state in the resolver sits after probeTrailReviewState( in its own function", () => {
    const text = readFileSync(RESOLVER, "utf8");
    const sf = ts.createSourceFile(RESOLVER, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const sites: Array<{ fn: string; line: number }> = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "select") {
        const a0 = n.arguments[0];
        if (a0 && ts.isStringLiteralLike(a0) && /\breview_state\b/.test(a0.text) && chainTable(n.expression.expression) === "trails") {
          let fn: ts.Node | undefined = n.parent;
          while (fn && !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn))) fn = fn.parent;
          assert.ok(fn, "a review_state read outside any function");
          const body = text.slice(fn!.getStart(sf), n.getStart(sf));
          const name = ts.isFunctionDeclaration(fn!) && fn!.name ? fn!.name.text : "<anonymous>";
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          assert.ok(/probeTrailReviewState\(sc\)/.test(body), `${name} (MediaActionResolver.ts:${line}) names trails.review_state without asking lib/capability first`);
          sites.push({ fn: name, line });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.deepEqual(sites.map((s) => s.fn).sort(), ["compileExperiencePlan", "withTrailDoThisAction"], `both doors, and only them: ${JSON.stringify(sites)}`);
  });

  it("the real scan charges trails.review_state to COMPASS_ENABLED (registered ⇒ guarded, KNOWN-listed) and never to hidden_gems_enabled", () => {
    const snap = loadProductionSnapshot(join(SRC, "lib", "capability", "snapshots", PRODUCTION_SNAPSHOT_FILENAME));
    const scan = scanFlagReads(SRC);
    const charged = (flag: string) =>
      scan.reads.filter((r) => r.flag === flag && r.refs.some((x) => x.key === "trails.review_state" && x.file === "services/media/MediaActionResolver.ts"));
    assert.equal(charged("hidden_gems_enabled").length, 0, "the Trail action is not behind the gem action's flag");
    // Both doors reach COMPASS_ENABLED: the rail through resolveMediaActions' Compass read, the compiler through the tool.
    const lines = new Set(charged("COMPASS_ENABLED").flatMap((r) => r.refs.filter((x) => x.key === "trails.review_state" && x.file === "services/media/MediaActionResolver.ts").map((x) => x.line)));
    assert.equal(lines.size, 2, `both review_state reads are in COMPASS_ENABLED closures: ${[...lines]}`);

    const productionHasIt = snap.tables.get("trails")?.has("review_state") === true;
    const finding = evaluateFlags(scan, snap, CAPABILITIES).find((f) => f.flag === "COMPASS_ENABLED")!;
    if (productionHasIt) {
      assert.equal(KNOWN.COMPASS_ENABLED, undefined, "3977 reached production: the KNOWN entry must be struck");
      return;
    }
    assert.equal(finding.classification, "guarded");
    assert.ok(finding.missing.some((m) => m.key === "trails.review_state"));
    for (const f of evaluateFlags(scan, snap, CAPABILITIES)) {
      if (f.production === "on" && f.missing.some((m) => m.key === "trails.review_state")) {
        assert.equal(f.registered, true, `${f.flag} is ON in production over trails.review_state and is not guarded`);
      }
    }
    assert.equal(KNOWN.COMPASS_ENABLED?.classification, "guarded");
    assert.deepEqual(KNOWN.COMPASS_ENABLED?.objects, ["trails.review_state"]);
    assert.match(KNOWN.COMPASS_ENABLED!.note, /trailReviewSchemaCapability/);
  });
});
