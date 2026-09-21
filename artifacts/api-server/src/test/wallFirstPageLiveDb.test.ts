/**
 * W146 — the Wall's For You FIRST PAGE, benchmarked against a REAL PostgreSQL,
 * through the REAL client path.
 *
 * WHAT THIS ADDS TO `wallPerformance.test.ts`
 * ===========================================
 * That file measures the same route against a table-routed FAKE client with no
 * I/O: it bounds OUR CPU work, the NUMBER of reads, and the SERIALIZED depth of
 * those reads. None of the three can fail because a query got slow, because no
 * query is ever planned or executed. This file closes that gap: the same router,
 * the same 150-post corpus shape, the same measurement helper — but every read
 * is a real HTTP request to a real PostgREST against a real Postgres with the
 * real production schema, real indexes and the real planner.
 *
 * WHAT THE NUMBER FROM THIS FILE PROVES, AND WHAT IT DOES NOT
 * ===========================================================
 * It proves the first page RUNS against the real schema — that every column the
 * router selects exists, every filter is one PostgREST will accept, and every
 * write it issues survives the real constraints — and it gives the cost of one
 * first page at ~0 ms of network latency over a 150-post table.
 *
 * It is NOT the production number, and nothing here should be quoted as one:
 *   • loopback — no network, no TLS, no pooler, no region boundary;
 *   • a 150-post table — no production data volume, so index selectivity and
 *     buffer-cache behaviour are nothing like production's;
 *   • GoTrue is STUBBED — `auth.getUser()` is answered by a local shim, so the
 *     auth round trip production pays on every request is absent here;
 *   • one warm process on an unloaded box — no cold start, no contention;
 *   • SIX TABLES THE PAGE READS ARE ABSENT. The local database carries the 23
 *     tables whose schema was extracted and fingerprint-verified against CI.
 *     `events`, `identity_verifications`, `user_mutes`, `post_hides`,
 *     `creator_activity_scores` and `viewer_creator_fatigue` are not among
 *     them, so six of the page's 346 reads return 42P01 fast instead of doing
 *     real work, and the gates they feed (mute, viewer-hide, creator activity,
 *     fatigue) are inert for this measurement. The page degrades gracefully and
 *     says so in its logs; the effect on the figure is to make it slightly
 *     OPTIMISTIC. Run with WALL_BENCH_DIAG=1 to see the per-table breakdown.
 * See docs/wall/measurement/W146-first-page-benchmark.md, which states the
 * measured figures and keeps an explicitly EMPTY table for the production ones.
 *
 * THE PRODUCTION-SAFETY GUARD, AND WHY THIS FILE DECIDES RATHER THAN SKIPS
 * =======================================================================
 * `../lib/ciSupabaseGuard.mjs` refuses whenever CI_SUPABASE_PROJECT_REF and
 * KNOWN_PROD_PROJECT_REF are unset, which is every ordinary run. That refusal is
 * this repository's production denylist and is not weakened here. What this file
 * adds is an honest reading of its own target:
 *
 *   LOCAL          an operator named the ONE disposable local database in
 *                     W146_LOCAL_DB_URL. A loopback host cannot be a Supabase
 *                     project at all: there is no project ref to resolve, so
 *                     the allowlist has nothing to bind to and no packet leaves
 *                     the machine. The guard is skipped, and ONLY after
 *                     `assertDisposableLocalBenchmarkTarget()` has refused a
 *                     missing, blank, remote, production, hostile-spelling or
 *                     mismatched target — the same call that opens the write
 *                     latch in helpers/liveWallCorpus.ts, which seedCorpus and
 *                     teardownCorpus both check before they write.
 *                     SELECTION IS EXPLICIT: a bare loopback SUPABASE_URL that
 *                     nobody configured is NOT local mode.
 *   REMOTE         anything else that is named -> the full guard runs, exactly
 *                     as wallSessionIntentLiveDb.test.ts runs it. Unparseable
 *                     and non-http targets take this branch: the predicate
 *                     fails CLOSED.
 *   NO TARGET      nothing configured -> nothing to connect to. The benchmark
 *                     skips, no client is built, the latch stays shut, and the
 *                     module asserts that inertness rather than assuming it.
 *
 * "REFUSED IS STILL REFUSED" below pins that by SPAWNING this very file with a
 * public https target and the env vars unset, and asserting exit code 2.
 *
 * WHY THE GUARD IS A DYNAMIC IMPORT AND supabase-js IS LOADED LAZILY
 * =================================================================
 * The guard's contract (see its header) is that `@supabase/supabase-js` "is
 * therefore not even loaded when a target is refused". A static `import` of the
 * router would load it during module linking, before any decision could be
 * made. So the decision is a top-level `await import(...)` and EVERY value that
 * reaches Supabase — the client factory, `lib/http.js`, the wall router — is
 * imported inside `before()`. On a refused target the process exits during
 * module evaluation with nothing downstream loaded, which is the invariant the
 * guard asks for.
 *
 * WHY THIS FILE IS ALLOWLISTED RATHER THAN REGISTERED
 * ===================================================
 * Same reason as wallSessionIntentLiveDb.test.ts: the curated `test` script
 * pins `SUPABASE_URL=http://127.0.0.1:9` and `SUPABASE_SERVICE_ROLE_KEY=dummy`,
 * so registering this file would run a benchmark with no database on every
 * ordinary suite run. It is listed in scripts/UNREGISTERED_TESTS_ALLOWLIST.json
 * and run by `npm run test:wall-first-page-live-db` instead. The one test that
 * needs NO database — the refusal test — is deliberately outside the skippable
 * describe, so this file can never be a file that asserts nothing.
 *
 * IT FAILS RATHER THAN PASSES VACUOUSLY
 * =====================================
 * When a target is configured, `before()` THROWS on an unreachable database, on
 * a viewer the auth stub will not name, on any seed the schema refuses, and the
 * first test asserts a FULL 20-item page before any timing is taken. A skip
 * carries its reason into the TAP output via `describe({ skip })`, which is what
 * `.github/scripts/run-live-suite.sh` scores as red (`pass > 0 && skipped == 0`).
 *
 * WHY check:guard-coverage LISTS THIS FILE RATHER THAN SEEING THE GUARD
 * =====================================================================
 * That checker recognises coverage by matching a STATIC side-effect import on a
 * line of its own. The decision above cannot take that form — the guard must
 * NOT run for the disposable loopback target, and deciding that means reading
 * the environment, which a static import cannot wait for. So the front door is
 * reached by `await import(...)`, which a regex over import STATEMENTS cannot
 * see. This file and helpers/liveWallCorpus.ts are therefore listed in
 * RUNTIME_TARGET_GATES in scripts/check-guard-coverage.mjs: an exception to
 * STATIC DETECTION, not to the production guard, and not an EXEMPT entry —
 * exemption would mean unguarded. The checker re-verifies the gate's shape in
 * this file's code on every run, and requires the refusals below to exist.
 *
 * RUN IT (against the local real-Postgres environment described in the doc):
 *   SUPABASE_URL=http://127.0.0.1:4000 \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role jwt> \
 *   npm run test:wall-first-page-live-db
 *
 * The npm script pins W146_LOCAL_DB_URL to http://127.0.0.1:4000 — an
 * independent, committed statement of WHICH database is disposable. SUPABASE_URL
 * must agree with it or the run refuses with `target_mismatch`; that is the
 * point. Pointing SUPABASE_URL at anything remote refuses before connecting.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
// Type-only: erased at runtime, so importing this module loads no Supabase code.
import type { SupabaseClient } from "@supabase/supabase-js";

import { benchmark, formatBenchmark } from "./helpers/benchmark.js";
import {
  AUTHORS,
  FLAGS,
  PLACES,
  POSTS,
  VIEWER_ID,
  buildLiveCorpus,
  clearFeatureFlags,
  DisposableTargetError,
  approvedDisposableTarget,
  assertDisposableLocalBenchmarkTarget,
  isLoopbackTarget,
  resetDisposableTargetApproval,
  missingLiveDbReason,
  readExistingFlags,
  seedCorpus,
  teardownCorpus,
  type LiveCorpus,
  type SeedCounts,
} from "./helpers/liveWallCorpus.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// ── THE TARGET DECISION — the first thing this module does ───────────────────
//
// W146. Three mutually exclusive modes, decided here, before `before()` runs
// and before any Supabase code is loaded:
//
//   LOCAL      W146_LOCAL_DB_URL names the ONE disposable local database. The
//              host is loopback, so it cannot be a Supabase project at all:
//              there is no project ref for the CI allowlist to bind to and no
//              packet leaves the machine. `assertDisposableLocalBenchmarkTarget`
//              refuses missing / remote / production / ambiguous targets here,
//              and it is the ONLY thing that opens the corpus helper's write
//              latch. Selection is explicit: a bare loopback SUPABASE_URL that
//              nobody configured is NOT local mode.
//   REMOTE     W146_LOCAL_DB_URL is unset and SUPABASE_URL names something. The
//              full production guard runs, unchanged, exactly as
//              wallSessionIntentLiveDb.test.ts runs it — including for a
//              malformed or non-http URL, where the loopback predicate fails
//              CLOSED. It exits 2 right here.
//   NO TARGET  SUPABASE_URL names nothing, so there is nothing to connect to —
//              whether or not W146_LOCAL_DB_URL is set, because a disposable
//              database nobody pointed the process at is not a target. The
//              benchmark below skips, no client is ever constructed, and the
//              write latch stays shut, so seedCorpus/teardownCorpus throw. The
//              module-level assertion under NO_TARGET_IS_INERT pins that, and
//              the always-run write-gate suite runs in exactly this mode.
const CONFIGURED_LOCAL_DB = process.env.W146_LOCAL_DB_URL ?? "";
const A_TARGET_IS_NAMED = SUPABASE_URL.trim() !== "";
const LOCAL_MODE_SELECTED = A_TARGET_IS_NAMED && CONFIGURED_LOCAL_DB.trim() !== "";
const REMOTE_TARGET_NAMED = A_TARGET_IS_NAMED && !LOCAL_MODE_SELECTED;

let TARGET_IS_LOOPBACK = false;
if (LOCAL_MODE_SELECTED) {
  assertDisposableLocalBenchmarkTarget(SUPABASE_URL, CONFIGURED_LOCAL_DB);
  TARGET_IS_LOOPBACK = true;
} else if (REMOTE_TARGET_NAMED) {
  await import("../lib/ciSupabaseGuard.mjs");
}

const SKIP_REASON = missingLiveDbReason(SUPABASE_URL, SERVICE_ROLE_KEY);
const LIVE = SKIP_REASON === null;

// NO_TARGET_IS_INERT. The one branch above that runs no guard is the branch
// with no target. That is only safe while it also reaches no database, so the
// claim is asserted rather than asserted-about: with nothing configured, the
// benchmark MUST be skipped and the write latch MUST be shut. If either ever
// stops being true, this module refuses to evaluate.
if (!A_TARGET_IS_NAMED) {
  if (LIVE || approvedDisposableTarget() !== null) {
    throw new Error(
      "W146: no target is configured, yet this file believes it can reach a database " +
        `(live=${LIVE}, approvedTarget=${String(approvedDisposableTarget())}). ` +
        "The unguarded no-target branch is only sound while it is inert.",
    );
  }
}

/** Any bearer token: the local shim names the viewer from a header, not a JWT. */
const TOKEN = "w146-fixture-token";

// ── What the measured run recorded, for the one-line summary at the end ──────

interface Recorded {
  counts: SeedCounts;
  p50: number;
  p95: number;
  reads: number;
}
const recorded: Partial<Recorded> = {};

// ── Live harness state ───────────────────────────────────────────────────────

let pub: SupabaseClient;
// The `auth`-schema client carries a different PostgREST profile in its type
// parameters than the default `public` one, so it is held at the widened shape.
let authSchema: SupabaseClient<any, any, any, any, any>;
let corpus: LiveCorpus;
let server: http.Server;
let baseUrl = "";
let priorFlags: ReadonlyMap<string, boolean> = new Map();
let clearTestClient: (() => void) | null = null;

/**
 * PostgREST requests issued since the last reset, counted at the client's own
 * `fetch` — so this is the number of REAL HTTP round trips the page made to the
 * database edge, not a count of calls into a fake.
 */
let restCalls = 0;
/** Which tables those requests hit. Populated only under WALL_BENCH_DIAG=1. */
const restTables: string[] = [];

function get(pathname: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── The live suite ───────────────────────────────────────────────────────────

describe(
  "W146 — the Wall's For You first page against real Postgres",
  { skip: LIVE ? false : `no live database: ${SKIP_REASON}` },
  () => {
    before(async () => {
      // Lazy, for the guard's "not even loaded when refused" invariant.
      const { createClient } = await import("@supabase/supabase-js");

      const countingFetch: typeof fetch = (input, init) => {
        restCalls += 1;
        // WALL_BENCH_DIAG=1 attributes the count to a table, so a surprise can
        // be traced without re-instrumenting anything (same switch as
        // wallPerformance.test.ts).
        if (process.env.WALL_BENCH_DIAG) {
          const href = typeof input === "string" ? input : String((input as Request).url ?? input);
          const table = /\/rest\/v1\/([^?/]+)/.exec(href)?.[1] ?? /\/(auth)\/v1\//.exec(href)?.[1] ?? "?";
          restTables.push(table);
        }
        return fetch(input as any, init as any);
      };
      const common = {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: countingFetch,
          // The shim has no GoTrue. It answers /auth/v1/* with whichever viewer
          // this header names, so the harness picks its own fixture viewer
          // instead of depending on how the shim process was started.
          headers: { "X-Fixture-Viewer": VIEWER_ID },
        },
      };
      pub = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, common);
      // PostgREST exposes `public` first (the default profile, so nothing about
      // the MEASURED path changes) and `auth` second. This second client is the
      // only way to write `auth.users` here: `profiles.id` REFERENCES it, and
      // there is no GoTrue locally to create users through the admin API.
      authSchema = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        ...common,
        db: { schema: "auth" },
      });

      // LOUD, NEVER VACUOUS: an unreachable database is a failure, not a skip.
      const probe = await pub.from("feature_flags").select("flag").limit(1);
      if (probe.error) {
        throw new Error(
          `W146: cannot reach the database at ${SUPABASE_URL} — ` +
            `${probe.error.code ?? "?"} ${probe.error.message}. This suite is configured to ` +
            `measure a real database and will not report a number it did not take.`,
        );
      }
      const authProbe = await authSchema.from("users").select("id").limit(1);
      if (authProbe.error) {
        throw new Error(
          `W146: the \`auth\` schema is not reachable through PostgREST ` +
            `(${authProbe.error.code ?? "?"} ${authProbe.error.message}). ` +
            `profiles.id REFERENCES auth.users(id) and there is no GoTrue here, so the fixture ` +
            `users cannot be created. Start PostgREST with db-schemas = "public, auth" and ` +
            `GRANT USAGE ON SCHEMA auth / SELECT,INSERT,DELETE ON auth.users TO service_role.`,
        );
      }

      // The measured route authenticates before it reads anything, so the auth
      // stub must actually name our fixture viewer or every page is a 401.
      const who = await pub.auth.getUser(TOKEN);
      if (who.data?.user?.id !== VIEWER_ID) {
        throw new Error(
          `W146: the auth endpoint named "${who.data?.user?.id ?? "nobody"}" rather than the ` +
            `fixture viewer ${VIEWER_ID}. GoTrue is stubbed locally; the stub must honour the ` +
            `X-Fixture-Viewer header.`,
        );
      }

      priorFlags = await readExistingFlags(pub);
      corpus = buildLiveCorpus();
      recorded.counts = await seedCorpus(pub, authSchema, corpus);

      const { _setTestClient, _clearTestClient } = await import("../lib/http.js");
      const { default: wallRouter } = await import("../routes/wall.js");
      // The REAL supabase-js client, pointed at the REAL PostgREST. This is the
      // only difference from wallPerformance.test.ts's fake, and it is the whole
      // point of the file.
      //
      // ── AND THE CLAIM IS NOW BOUND TO THE OBJECT ─────────────────────────
      // Added 2026-09-21 after the same defect was found in M256(a): that
      // harness printed `arm=live-supabase` from two environment variables
      // while `startRouterApp` built the in-process double regardless, so the
      // LABEL outran the thing it labelled by about an order of magnitude.
      //
      // This file never had that bug — it is checked, not assumed: with the
      // database unreachable the suite CANCELS its five live cases and exits 1
      // rather than falling back to anything, and the numbers below were
      // re-measured against a real PostgreSQL after the check. But it did have
      // the same structural weakness: nothing here ASSERTED that the object
      // handed to the router was a real client. A comment saying "the REAL
      // supabase-js client" is worth exactly as much as the next edit's care.
      //
      // So the binding is asserted at install time, before a single request is
      // measured. A fake in this repo is a plain object literal or a Proxy; a
      // real supabase-js client carries `.rest.url` pointing at the configured
      // target, and `.auth`/`.from` from the package's own prototype.
      const restUrl = String((pub as unknown as { rest?: { url?: unknown } })?.rest?.url ?? "");
      if (!restUrl.startsWith(SUPABASE_URL)) {
        throw new Error(
          `W146: the client about to be measured does not point at the configured target. ` +
            `rest.url=${restUrl || "(absent)"} SUPABASE_URL=${SUPABASE_URL}. A benchmark whose ` +
            "client is not the real one is a number about nothing, and that is exactly the " +
            "defect M256(a) carried.",
        );
      }
      recorded.clientRestUrl = restUrl;
      _setTestClient(pub, true);
      clearTestClient = _clearTestClient;

      const app = express();
      app.use(express.json());
      app.use("/api", wallRouter);
      await new Promise<void>((resolve) => {
        server = http.createServer(app);
        server.listen(0, "127.0.0.1", () => {
          baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          server.unref();
          resolve();
        });
      });
    });

    after(async () => {
      if (clearTestClient) clearTestClient();
      if (server) {
        await new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        });
      }
      if (!pub) return;
      // Every row, by marker, in FK-safe order — including the rank_events the
      // page wrote fire-and-forget on every one of the ~40 measured requests.
      const problems = await teardownCorpus(pub, authSchema);
      await clearFeatureFlags(pub, priorFlags);
      if (problems.length > 0) {
        // Loud, not silent: leftover fixture rows would be measured by the next
        // run. Reported rather than thrown so it cannot mask a real failure.
        console.error(`[W146] teardown reported problems:\n  ${problems.join("\n  ")}`);
      }
      const leftover = await pub.from("posts").select("id").eq("source", "w146fp-first-page-benchmark");
      if ((leftover.data ?? []).length > 0) {
        console.error(`[W146] ${(leftover.data ?? []).length} fixture posts survived teardown`);
      }
    });

    it("the corpus really is in Postgres, and the real schema accepted it", async () => {
      const counts = recorded.counts!;
      assert.equal(counts.posts, POSTS, "the seeded post count is the corpus size");
      assert.equal(counts.profiles, AUTHORS + 1, "authors plus the viewer");
      assert.equal(counts.places, PLACES);
      // Read the rows back with a SEPARATE query so the seeder cannot be the
      // thing that agrees with itself.
      const { data, error } = await pub
        .from("posts")
        .select("id")
        .eq("source", "w146fp-first-page-benchmark");
      assert.equal(error, null);
      assert.equal((data ?? []).length, POSTS, "the posts are really in the database");
    });

    it("the benchmark measures a REAL first page, not an error path", async () => {
      const res = await get("/api/wall?mode=for_you");
      assert.equal(res.status, 200, "the fixture corpus must produce a servable page");
      assert.equal(res.json.mode, "for_you");
      assert.ok(Array.isArray(res.json.items), "items must be an array");
      // A benchmark over an empty feed would measure nothing. Pin a full page.
      assert.equal(res.json.items.length, 20, "the first page is a full DEFAULT_LIMIT page");
      assert.ok(typeof res.json.nextCursor === "string", "a full page carries a cursor");
      assert.ok(Array.isArray(res.json.liveForYou));
    });

    it("MEASURED — For You first page p50/p95 against real Postgres", async () => {
      const result = await benchmark(
        `GET /wall?mode=for_you (first page, ${POSTS}-post corpus, REAL Postgres)`,
        async () => {
          const res = await get("/api/wall?mode=for_you");
          if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
        },
        { warmup: 5, iterations: 20 },
      );
      console.log(formatBenchmark(result));
      recorded.p50 = result.p50;
      recorded.p95 = result.p95;
      // Vacuity guard, not a performance ceiling. A real database cannot answer
      // a ~90-round-trip page in under a millisecond; a number that small means
      // the page short-circuited and the benchmark measured an error path.
      assert.ok(
        result.p50 > 1,
        `p50 of ${result.p50.toFixed(2)}ms is too fast to be a real database page — ` +
          `the benchmark is measuring something other than the first page`,
      );
      // No ceiling is asserted here ON PURPOSE. wallPerformance.test.ts already
      // owns the ratchets; this file's job is to REPORT what a real database
      // costs at zero network latency, and a ceiling invented from one local run
      // would be a production claim this environment cannot support.
    });

    it("the measured client IS the real one — the label is bound to the object", () => {
      // The companion to the install-time throw in before(), so the property is
      // visible as a PASS rather than only as an absence of failure. M256(a)'s
      // defect was a live label over a fake's numbers; the cheapest way for it
      // to reappear here is an edit that swaps `pub` for a double and leaves
      // every sentence in this file intact.
      const restUrl = recorded.clientRestUrl ?? "";
      assert.ok(
        restUrl.startsWith(SUPABASE_URL),
        `the benchmarked client must point at ${SUPABASE_URL}; got ${restUrl || "(absent)"}`,
      );
      // State the discriminator rather than leave a reader to infer it from a
      // url prefix: a real supabase-js client exposes its PostgREST base at
      // /rest/v1, and the plain-object doubles in this repo expose no `rest` at
      // all — which is why the check in before() throws rather than mismatches.
      assert.ok(
        restUrl.includes("/rest/v1"),
        `a real supabase-js client exposes /rest/v1; got ${restUrl}`,
      );
    });

    it("MEASURED — one first page's real PostgREST round trips", async () => {
      await get("/api/wall?mode=for_you"); // warm any per-process cache first
      restCalls = 0;
      restTables.length = 0;
      const res = await get("/api/wall?mode=for_you");
      assert.equal(res.status, 200);
      const used = restCalls;
      if (process.env.WALL_BENCH_DIAG) {
        const counts = new Map<string, number>();
        for (const t of restTables) counts.set(t, (counts.get(t) ?? 0) + 1);
        console.log(
          "[diag]",
          [...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(" "),
        );
      }
      recorded.reads = used;
      console.log(`[bench] GET /wall?mode=for_you: ${used} real HTTP calls to the database edge`);
      assert.ok(
        used > 5,
        `only ${used} calls observed — the counter is not wired to the real client`,
      );
      // Reported, not ratcheted: wallPerformance.test.ts owns the read ratchet
      // (375) and counts calls into the fake. This counts HTTP requests that
      // really left the process, which is the same quantity measured one layer
      // further out, and is quoted in the measurement report.
      console.log(
        `[W146] measured: p50=${(recorded.p50 ?? NaN).toFixed(1)}ms ` +
          `p95=${(recorded.p95 ?? NaN).toFixed(1)}ms reads=${used} ` +
          `corpus=${JSON.stringify(recorded.counts)}`,
      );
    });

    it("CLOSED FINDING — the first page's ranking analytics now LAND in the real schema", async () => {
      // WHAT THIS FOUND, AND WHAT CLOSED IT (W146).
      //
      // As first written this test asserted ZERO rank_events rows, because that
      // was the measured truth: the first page wrote one row per SCORED
      // CANDIDATE, fire-and-forget, stamped `surface = 'explore'`, and the real
      // schema refused every one of them with 23514 —
      //
      //   new row for relation "rank_events" violates check constraint
      //   "rank_events_surface_check"   (surface = 'explore')
      //
      // — which the ranker's handler logged at warn and dropped, so ~151
      // rejected inserts per request were invisible to every test that used the
      // in-memory fake (its `insert` returns `{ error: null }` unconditionally).
      // Migration 2893 had retired the `explore` label on the stated grounds
      // that it had "no writer anywhere in the tree"; the Wall's For You page
      // was its writer, on every request.
      //
      // THE FIX, and it is not this test. WallRankingService now threads TWO
      // vocabularies separately, because they had silently become one:
      //   • FOR_YOU_WEIGHT_PROFILE = "explore" — the ranker's WEIGHT PROFILE.
      //     §14's objective is exploration and diversity, and there is no "wall"
      //     key in SURFACE_WEIGHT_PROFILES, so renaming this would fall through
      //     to the default profile and re-rank every user's feed.
      //   • FOR_YOU_ANALYTICS_SURFACE = "wall" — the value PERSISTED. Typed
      //     PersistedRankSurface, so a label the database would reject is a
      //     compile error rather than a runtime warning nobody reads.
      //
      // This test now asserts the closure the way the original asked for: the
      // rows LAND, and they land under the admitted label. It still pins the
      // constraint from both sides below, so "rows landed" can never be read as
      // "the constraint was widened to admit anything".
      await get("/api/wall?mode=for_you");
      await new Promise((r) => setTimeout(r, 750)); // the response does not await them

      const landed = await pub
        .from("rank_events")
        .select("id, surface")
        .eq("user_id", VIEWER_ID)
        .limit(200);
      assert.equal(landed.error, null, "rank_events is not readable");
      const rows = landed.data ?? [];
      assert.ok(
        rows.length > 0,
        "the first page's ranking analytics no longer land. Either the Wall stopped writing them, or the " +
          "persisted label was changed back to one the schema refuses — check FOR_YOU_ANALYTICS_SURFACE " +
          "against rank_events_surface_check before assuming this test is stale.",
      );
      const surfaces = [...new Set(rows.map((r: { surface: string }) => r.surface))];
      assert.deepEqual(
        surfaces,
        ["wall"],
        `every row the first page writes must carry the admitted label; got ${JSON.stringify(surfaces)}`,
      );

      // The constraint is still NARROW. Without this, "the rows land" would also
      // be satisfied by a migration that widened the check to admit everything,
      // which is the opposite of what closed this finding.
      const refused = await pub.from("rank_events").insert([
        { user_id: VIEWER_ID, item_id: "w146-probe", surface: "explore", outcome: "analytics" },
      ]);
      assert.equal(
        refused.error?.code,
        "23514",
        `surface='explore' must STILL be refused by rank_events_surface_check — the fix was to stop writing ` +
          `that label, not to re-admit it; got ${JSON.stringify(refused.error)}`,
      );
      const accepted = await pub.from("rank_events").insert([
        { user_id: VIEWER_ID, item_id: "w146-probe", surface: "wall", outcome: "analytics" },
      ]);
      assert.equal(
        accepted.error,
        null,
        `surface='wall' must be accepted — if this fails the table, the viewer or the FK is ` +
          `the problem, not the label: ${JSON.stringify(accepted.error)}`,
      );
      // Swept by teardown (rank_events is deleted by user_id).
    });

  },
);

// ── The guard, pinned. Needs no database, so it is NOT inside the skip ───────

describe("W146 — the write gate: only the explicitly configured disposable database", () => {
  // These never connect to anything. The gate is a decision over strings, made
  // before any client exists, which is exactly why it can be tested here.
  const LOCAL = "http://127.0.0.1:4000";

  it("approves the configured disposable target, and ONLY that one", () => {
    resetDisposableTargetApproval();
    assert.equal(approvedDisposableTarget(), null, "the latch starts shut");
    assert.equal(assertDisposableLocalBenchmarkTarget(LOCAL, LOCAL), LOCAL);
    assert.equal(approvedDisposableTarget(), LOCAL, "and only then is it open");
  });

  it("REFUSES missing, remote, production and ambiguous targets — before any connection", () => {
    const cases: Array<{ runtime: string; configured: string | undefined; reason: string; why: string }> = [
      { runtime: LOCAL, configured: undefined, reason: "missing_configured_target", why: "nothing configured" },
      { runtime: LOCAL, configured: "", reason: "missing_configured_target", why: "blank configuration" },
      { runtime: LOCAL, configured: "   ", reason: "missing_configured_target", why: "whitespace configuration" },
      { runtime: "https://ajrurzioarfkagpuxfnb.supabase.co", configured: "https://ajrurzioarfkagpuxfnb.supabase.co",
        reason: "configured_target_not_loopback", why: "PRODUCTION named as the disposable database" },
      { runtime: LOCAL, configured: "https://hwokxgbmezheskbzskfr.supabase.co",
        reason: "configured_target_not_loopback", why: "a remote project named as the disposable database" },
      { runtime: "https://127.0.0.1.evil.example", configured: "https://127.0.0.1.evil.example",
        reason: "configured_target_not_loopback", why: "a hostile spelling of loopback" },
      { runtime: "https://ajrurzioarfkagpuxfnb.supabase.co", configured: LOCAL,
        reason: "runtime_target_not_loopback", why: "SUPABASE_URL points at production" },
      { runtime: "", configured: LOCAL, reason: "runtime_target_not_loopback", why: "SUPABASE_URL unset" },
      { runtime: "http://127.0.0.1:5555", configured: LOCAL, reason: "target_mismatch", why: "two different loopback targets is ambiguous" },
    ];
    for (const c of cases) {
      resetDisposableTargetApproval();
      assert.throws(
        () => assertDisposableLocalBenchmarkTarget(c.runtime, c.configured),
        (err: unknown) => err instanceof DisposableTargetError && err.reason === c.reason,
        `${c.why} must be refused as ${c.reason}`,
      );
      assert.equal(approvedDisposableTarget(), null, `${c.why}: the latch must stay shut`);
    }
  });

  it("the WRITE paths refuse while the latch is shut — the gate cannot be skipped", async () => {
    resetDisposableTargetApproval();
    // A client that would throw if it were ever reached. It is not reached.
    const never: any = { from() { throw new Error("W146: a write path opened a connection without an approved target"); } };
    await assert.rejects(
      () => seedCorpus(never, never, buildLiveCorpus()),
      (err: unknown) => err instanceof DisposableTargetError,
      "seedCorpus must refuse without an approved target",
    );
    await assert.rejects(
      () => teardownCorpus(never, never),
      (err: unknown) => err instanceof DisposableTargetError,
      "teardownCorpus must refuse without an approved target",
    );
  });

  it("a bare loopback URL that nobody configured is NOT local mode — it takes the guarded path", () => {
    // The file selects local mode ONLY from W146_LOCAL_DB_URL. This asserts the
    // selector, not the predicate: isLoopbackTarget says "could be local", and
    // that is deliberately not sufficient on its own.
    const src = readFileSync(new URL("./wallFirstPageLiveDb.test.ts", import.meta.url), "utf8");
    assert.match(src, /const LOCAL_MODE_SELECTED = A_TARGET_IS_NAMED && CONFIGURED_LOCAL_DB\.trim\(\) !== "";/);
    assert.match(src, /if \(LOCAL_MODE_SELECTED\) \{[\s\S]{0,200}assertDisposableLocalBenchmarkTarget\(/);
    assert.match(
      src,
      /\} else if \(REMOTE_TARGET_NAMED\) \{\s*await import\("\.\.\/lib\/ciSupabaseGuard\.mjs"\);/,
      "a named non-local target must still take the full production guard",
    );
    assert.match(
      src,
      /const REMOTE_TARGET_NAMED = A_TARGET_IS_NAMED && !LOCAL_MODE_SELECTED;/,
      "REMOTE is every named target that is not the configured disposable one",
    );
    // The only unguarded branch is the one with no target at all, and it is
    // required to be inert. Deleting that assertion is the way this could rot.
    assert.match(
      src,
      /if \(!A_TARGET_IS_NAMED\) \{\s*if \(LIVE \|\| approvedDisposableTarget\(\) !== null\) \{/,
      "the no-target branch must assert its own inertness",
    );
  });

  it("this run IS the no-target mode, so the refusals above were proved without a database", () => {
    // Belt and braces on the suite above: it is only meaningful if the process
    // running it genuinely has no database. `npm run test:wall-first-page-live-db`
    // sets W146_LOCAL_DB_URL and runs the benchmark too; every other invocation
    // lands here.
    if (process.env.W146_LOCAL_DB_URL || process.env.SUPABASE_URL) return;
    assert.equal(LIVE, false, "no target configured, so the benchmark must be skipped");
    assert.equal(TARGET_IS_LOOPBACK, false, "no target configured, so no loopback was approved");
  });
});

describe("W146 — the production-safety guard decides this file's target", () => {
  it("isLoopbackTarget() accepts only genuine loopback hosts", () => {
    for (const url of [
      "http://127.0.0.1:4000",
      "http://127.0.0.1:54321/rest/v1",
      "https://localhost:8443",
      "http://LOCALHOST",
      "http://[::1]:4000",
      "http://127.5.6.7",
    ]) {
      assert.equal(isLoopbackTarget(url), true, `${url} is loopback`);
    }
  });

  it("isLoopbackTarget() FAILS CLOSED on everything else", () => {
    for (const url of [
      "", // no target at all
      "not a url",
      "127.0.0.1:4000", // no scheme -> not parseable as http
      "postgres://postgres@127.0.0.1:5433/postgres", // not an http target
      "https://ajrurzioarfkagpuxfnb.supabase.co", // PRODUCTION — never
      "https://hwokxgbmezheskbzskfr.supabase.co", // the CI project
      "https://127.0.0.1.evil.example", // hostname is evil.example
      "http://user@127.0.0.1@evil.example", // hostname is evil.example
      "https://evil.example/?host=127.0.0.1",
      "https://evil.example#127.0.0.1",
      "http://127.0.0.999",
    ]) {
      assert.equal(isLoopbackTarget(url), false, `${url} must NOT read as loopback`);
    }
  });

  it("REFUSED IS STILL REFUSED — a public https target with the env vars unset exits 2", () => {
    // Guards the guard. This spawns THIS FILE with a public https SUPABASE_URL
    // and CI_SUPABASE_PROJECT_REF / KNOWN_PROD_PROJECT_REF removed, which is the
    // ordinary state of every developer machine. The child must refuse at module
    // evaluation with the guard's own exit code, proving that the loopback
    // branch above did not quietly become an unconditional bypass.
    //
    // No recursion: the child exits before any test registers, and the env
    // marker below stops it re-entering this test if it ever did not.
    if (process.env.W146_GUARD_CHILD === "1") return;

    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.resolve(here, "..", "..");
    const selfPath = path.join(here, "wallFirstPageLiveDb.test.ts");

    const env: NodeJS.ProcessEnv = { ...process.env, W146_GUARD_CHILD: "1" };
    // A target that is unmistakably remote, and is neither production nor CI.
    env.SUPABASE_URL = "https://w146benchmarkref.supabase.co";
    env.SUPABASE_SERVICE_ROLE_KEY = "not-a-real-key";
    delete env.CI_SUPABASE_PROJECT_REF;
    delete env.KNOWN_PROD_PROJECT_REF;
    // The npm script pins this, and the child must NOT inherit it: with a local
    // database configured the child would refuse at the write gate instead,
    // which is a different refusal and would leave the front door untested. The
    // next test covers that combination on purpose.
    delete env.W146_LOCAL_DB_URL;

    let status = 0;
    let output = "";
    try {
      output = execFileSync(
        process.execPath,
        ["--import", "tsx/esm", selfPath],
        { cwd: pkgRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? -1;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    assert.equal(
      status,
      2,
      `a public https target with the CI env vars unset must be REFUSED with exit 2 ` +
        `(ciSupabaseGuard's code), got ${status}. Output:\n${output}`,
    );
    assert.match(
      output,
      /ciSupabaseGuard\] REFUSED/,
      `the refusal must come from ../lib/ciSupabaseGuard.mjs itself, not from something ` +
        `this file reimplemented. Output:\n${output}`,
    );
  });

  it("a remote SUPABASE_URL is refused even WITH a disposable database configured", () => {
    // The combination the npm script makes reachable: W146_LOCAL_DB_URL names
    // the disposable database, and SUPABASE_URL points somewhere remote. Local
    // mode is selected, so the front door is not the thing that runs — the gate
    // is, and it must refuse before any connection. Spawned rather than called
    // so the refusal is observed where it actually happens: module evaluation.
    if (process.env.W146_GUARD_CHILD === "1") return;

    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.resolve(here, "..", "..");
    const selfPath = path.join(here, "wallFirstPageLiveDb.test.ts");

    const env: NodeJS.ProcessEnv = { ...process.env, W146_GUARD_CHILD: "1" };
    env.SUPABASE_URL = "https://ajrurzioarfkagpuxfnb.supabase.co"; // declared production
    env.SUPABASE_SERVICE_ROLE_KEY = "not-a-real-key";
    env.W146_LOCAL_DB_URL = "http://127.0.0.1:4000";

    let status = 0;
    let output = "";
    try {
      output = execFileSync(
        process.execPath,
        ["--import", "tsx/esm", selfPath],
        { cwd: pkgRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? -1;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    assert.notEqual(status, 0, `the child must not run. Output:\n${output}`);
    assert.match(
      output,
      /DisposableTargetError/,
      `the refusal must be the write gate's, raised before any client exists. Output:\n${output}`,
    );
    assert.match(
      output,
      /runtime_target_not_loopback/,
      `and it must name WHY: the runtime target is not the disposable database. Output:\n${output}`,
    );
    assert.doesNotMatch(
      output,
      /seedCorpus|inserted|fetch failed/i,
      `nothing may have been attempted against the target. Output:\n${output}`,
    );
  });

  it("this run's own target decision is recorded, so a reader knows which branch ran", () => {
    // Not a behavioural assertion — a statement in the TAP output. A benchmark
    // whose safety branch is invisible is a benchmark nobody can audit.
    console.log(
      `[W146] target=${SUPABASE_URL || "(unset)"} loopback=${TARGET_IS_LOOPBACK} ` +
        `guard=${TARGET_IS_LOOPBACK ? "not applicable (no project ref to allowlist)" : "ENFORCED"} ` +
        `live=${LIVE}${LIVE ? "" : ` skip=${SKIP_REASON}`}`,
    );
    assert.ok(
      TARGET_IS_LOOPBACK || !LIVE || SUPABASE_URL.startsWith("https://"),
      "a live non-loopback run must be an https target that the guard has already allowed",
    );
    // FLAGS is exported so the report can state exactly which flags were on.
    assert.equal(FLAGS.wall_enabled, true, "the benchmark measures the Wall switched ON");
  });
});
