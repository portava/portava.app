/**
 * checkUncheckedSupabaseReads — the guard's own proof.
 *
 * The claim: a security-critical supabase READ that ignores its `.error`
 * turns a database failure into an empty result, and on an authorization
 * path the empty result is the permissive answer. These tests pin
 *
 *   1. the analysis — every consumer shape it judges, every shape it
 *      deliberately leaves alone, and the scope tiers;
 *   2. the five real sites this session found, against the REAL files: the
 *      fixed form is silent, and reverting the fix by text substitution (the
 *      real file is never edited) is caught — so the "not flagged" half is
 *      not vacuous;
 *   3. the allowlist contract — no rationale, stale key, duplicate key,
 *      unknown section each fail;
 *   4. the CLI by EXIT CODE, pointed at scratch trees: an empty tree fails,
 *      a tree with reads but no judged site fails, the reconstructed
 *      events.ts trust-gate defect fails with its key in the output, and the
 *      fixed form passes with a non-zero judged count.
 *
 * Run: cd artifacts/api-server && SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/uncheckedSupabaseReads.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanSource,
  scanTree,
  applyAllowlist,
  parseAllowlist,
  loadAllowlist,
  tierOf,
  isGateFunctionName,
  MIN_RATIONALE_CHARS,
  DIRECTION_LABELS,
  EXCLUSION_TABLES,
  SCOPE_DIRS,
  type UncheckedRead,
} from "../scripts/checkUncheckedSupabaseReads.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");
const SCRIPT = resolve(SRC, "scripts/checkUncheckedSupabaseReads.ts");

/** Wrap a body in a gate-named async function so the read lands in scope. */
const inGate = (body: string, fn = "canDoThing"): string => `async function ${fn}(sc: any, id: string) {\n${body}\n}`;
const reads = (src: string, file = "routes/fixture.ts"): UncheckedRead[] => scanSource(src, file).reads;
const keysOf = (src: string, file = "routes/fixture.ts"): string[] => reads(src, file).map((r) => r.key);

// ── 1. Consumer shapes ──────────────────────────────────────────────────────

describe("scanSource — Promise.allSettled and the .map normaliser", () => {
  // A Promise.allSettled element is wrapped in {status, value|reason}, so the
  // checker cannot judge it and says so. Twelve reads in
  // services/interactionPermissions.ts sat in that blind spot -- one of them on
  // user_restrictions, an EXCLUSION_TABLE -- indistinguishable from reads the
  // instrument genuinely cannot judge. The repair is narrow: a `.map` callback
  // that reads the settled wrapper AND rebuilds {data, error} has normalised
  // the elements back to the shape a plain Promise.all produces, so judging
  // resumes. Anything else keeps the unresolved verdict, because "I cannot see
  // this" is the safe answer and only a proven normaliser may override it.
  const settled = (mapBody: string) => `
    const [aRes, bRes] = (await Promise.allSettled([
      sc.from("blocks").select("id").eq("id", x).maybeSingle(),
      sc.from("user_restrictions").select("id").eq("id", y).maybeSingle(),
    ])).map(${mapBody}) as any;
    use(aRes.data, bRes.data);
  `;

  const NORMALISER = '(r) => (r.status === "fulfilled" ? r.value : { data: null, error: r.reason })';

  it("a genuine normaliser makes both elements judgeable again", () => {
    const scan = scanSource(settled(NORMALISER), "routes/fixture.ts");
    assert.equal(scan.settledNormalised, 1);
    assert.equal(scan.settledUnresolved, 0);
    assert.equal(scan.sitesJudged, 2);
    assert.deepEqual(scan.reads.map((r) => r.table).sort(), ["blocks", "user_restrictions"]);
    // Both are member-only: .data is read, .error never is.
    assert.deepEqual([...new Set(scan.reads.map((r) => r.shape))], ["member-only"]);
  });

  it("without the normaliser the same reads are UNRESOLVED, and counted separately", () => {
    const src = `
      const [aRes, bRes] = (await Promise.allSettled([
        sc.from("blocks").select("id").eq("id", x).maybeSingle(),
        sc.from("user_restrictions").select("id").eq("id", y).maybeSingle(),
      ])) as any;
      use(aRes, bRes);
    `;
    const scan = scanSource(src, "routes/fixture.ts");
    assert.equal(scan.settledUnresolved, 2);
    assert.equal(scan.settledNormalised, 0);
    assert.equal(scan.reads.length, 0, "an unresolved read is NOT reported as clean, it is reported as unseen");
  });

  it("a .map that is not a normaliser does NOT unlock judging", () => {
    // Reads the wrapper but rebuilds neither data nor error: not a normaliser.
    const scan = scanSource(settled('(r) => r.status'), "routes/fixture.ts");
    assert.equal(scan.settledNormalised, 0);
    assert.equal(scan.settledUnresolved, 2);
    assert.equal(scan.reads.length, 0);
  });

  it("a .map that builds {data,error} without reading the wrapper does NOT unlock judging", () => {
    const scan = scanSource(settled('(r) => ({ data: null, error: null })'), "routes/fixture.ts");
    assert.equal(scan.settledNormalised, 0);
    assert.equal(scan.settledUnresolved, 2);
  });

  it("a normalised allSettled whose elements DO read .error reports nothing", () => {
    const src = `
      const [aRes, bRes] = (await Promise.allSettled([
        sc.from("blocks").select("id").eq("id", x).maybeSingle(),
        sc.from("user_restrictions").select("id").eq("id", y).maybeSingle(),
      ])).map(${NORMALISER}) as any;
      if (aRes.error || bRes.error) throw new Error("degraded");
      use(aRes.data, bRes.data);
    `;
    const scan = scanSource(src, "routes/fixture.ts");
    assert.equal(scan.settledNormalised, 1);
    assert.equal(scan.sitesJudged, 2);
    assert.equal(scan.reads.length, 0, "observing .error is the whole point; these are not defects");
  });

  it("plain Promise.all is unaffected by the normaliser path", () => {
    const src = `
      const [aRes, bRes] = await Promise.all([
        sc.from("blocks").select("id").eq("id", x).maybeSingle(),
        sc.from("user_restrictions").select("id").eq("id", y).maybeSingle(),
      ]);
      use(aRes.data, bRes.data);
    `;
    const scan = scanSource(src, "routes/fixture.ts");
    assert.equal(scan.settledNormalised, 0);
    assert.equal(scan.settledUnresolved, 0);
    assert.equal(scan.sitesJudged, 2);
    assert.equal(scan.reads.length, 2);
  });
});

describe("scanSource — shapes that ignore .error", () => {
  it("data-only: `const { data } = await …maybeSingle()`", () => {
    const r = reads(inGate(`const { data } = await sc.from("trip_members").select("role").eq("id", id).maybeSingle();\n  return !!data;`));
    assert.equal(r.length, 1);
    assert.equal(r[0].shape, "data-only");
    assert.equal(r[0].terminal, "maybeSingle");
    assert.equal(r[0].key, "routes/fixture.ts::canDoThing::trip_members.maybeSingle");
  });

  it("data-only: `.single()`", () => {
    const r = reads(inGate(`const { data } = await sc.from("t").select("*").eq("id", id).single();\n  return data;`));
    assert.equal(r.length, 1);
    assert.equal(r[0].terminal, "single");
  });

  it("data-only: `.select()` awaited directly, and a filter-terminated chain", () => {
    const r = reads(inGate(`const { data: a } = await sc.from("t").select("id");\n  const { data: b } = await sc.from("u").select("id").eq("x", 1).limit(1);\n  return [a, b];`));
    assert.deepEqual(r.map((x) => x.terminal), ["select", "filter"]);
  });

  it("count-only (`{ count }` with head:true) is data-only — count null reads as 0", () => {
    const r = reads(inGate(`const { count } = await sc.from("blocks").select("id", { count: "exact", head: true }).eq("a", id);\n  return (count ?? 0) > 0;`));
    assert.equal(r.length, 1);
    assert.equal(r[0].shape, "data-only");
  });

  it("error-unread: `{ data, error }` bound and `error` never referenced is the same defect", () => {
    const r = reads(inGate(`const { data, error } = await sc.from("t").select("id").eq("id", id).maybeSingle();\n  return !!data;`));
    assert.equal(r.length, 1);
    assert.equal(r[0].shape, "error-unread");
  });

  it("error-unread: renamed binding `error: _e` that is never read", () => {
    const r = reads(inGate(`const { data, error: _e } = await sc.from("t").select("id").maybeSingle();\n  return data;`));
    assert.equal(r.length, 1);
    assert.equal(r[0].shape, "error-unread");
  });

  it("member-only: `const r = await …; r.data` without ever touching r.error", () => {
    const r = reads(inGate(`const res = await sc.from("t").select("id").eq("id", id).maybeSingle();\n  return Boolean(res.data);`));
    assert.equal(r.length, 1);
    assert.equal(r[0].shape, "member-only");
  });

  it("discarded: `await sc.from(…).select(…);` as a statement", () => {
    const r = reads(inGate(`await sc.from("t").select("id").eq("id", id);\n  return true;`));
    assert.equal(r.length, 1);
    assert.equal(r[0].shape, "discarded");
  });

  it("(await …).data — inline member access", () => {
    const r = reads(inGate(`return Boolean((await sc.from("t").select("id").eq("id", id).maybeSingle()).data);`));
    assert.equal(r.length, 1);
    assert.equal(r[0].shape, "member-only");
  });

  it("Promise.all: each element is matched to its array-binding position", () => {
    const src = inGate(`const [{ data: a }, b, { data: c, error: cErr }] = await Promise.all([
      sc.from("t1").select("id").eq("id", id).maybeSingle(),
      sc.from("t2").select("id").eq("id", id).maybeSingle(),
      sc.from("t3").select("id").eq("id", id).maybeSingle(),
    ]);
    if (cErr) throw cErr;
    return Boolean(a) || Boolean(b.data) || Boolean(c);`);
    const r = reads(src);
    assert.deepEqual(r.map((x) => [x.table, x.shape]), [["t1", "data-only"], ["t2", "member-only"]]);
  });

  it("Promise.all: an omitted binding slot is a discarded read", () => {
    const r = reads(inGate(`const [, y] = await Promise.all([sc.from("t1").select("id"), sc.from("t2").select("id")]);\n  if (y.error) throw y.error;\n  return y.data;`));
    assert.deepEqual(r.map((x) => [x.table, x.shape]), [["t1", "discarded"]]);
  });

  it(".then(({ data }) => …) callback is judged like a destructure", () => {
    const r = reads(inGate(`return sc.from("t").select("id").eq("id", id).maybeSingle().then(({ data }) => Boolean(data));`));
    assert.equal(r.length, 1);
    assert.equal(r[0].shape, "data-only");
  });

  it("a chain bound to a variable and awaited later is followed to its table", () => {
    const src = inGate(`let q = sc.from("layover_recommendations").select("*").eq("session_id", id);
    q = q.order("sort_order");
    const { data } = await q;
    return data ?? [];`);
    const r = reads(src);
    assert.equal(r.length, 1);
    assert.equal(r[0].table, "layover_recommendations");
    assert.equal(r[0].shape, "data-only");
  });

  it(".rpc(…) used as a read (`{ data }` consumed) is flagged", () => {
    const r = reads(inGate(`const { data } = await sc.rpc("is_member", { uid: id });\n  return Boolean(data);`));
    assert.equal(r.length, 1);
    assert.equal(r[0].terminal, "rpc");
    assert.equal(r[0].table, "is_member");
  });

  it("try/catch around the read does NOT count as observing the error", () => {
    const src = inGate(`try {
      const { data } = await sc.from("t").select("id").eq("id", id).maybeSingle();
      return Boolean(data);
    } catch (err) {
      logger.warn({ err }, "never fires for a resolved error");
      return false;
    }`);
    assert.equal(reads(src).length, 1);
  });

  it("shadowing: an `error` read only in a nested block that redeclares it does not count", () => {
    const src = inGate(`const { data, error } = await sc.from("t").select("id").eq("id", id).maybeSingle();
    {
      const { data: d2, error } = await sc.from("u").select("id").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!d2) return false;
    }
    return Boolean(data);`);
    const r = reads(src);
    assert.deepEqual(r.map((x) => [x.table, x.shape]), [["t", "error-unread"]]);
  });
});

describe("scanSource — shapes that observe .error (never flagged)", () => {
  const cases: Array<[string, string]> = [
    ["branch", `const { data, error } = await sc.from("t").select("id").maybeSingle();\n  if (error) return false;\n  return !!data;`],
    ["throw", `const { data, error } = await sc.from("t").select("id").maybeSingle();\n  if (error) throw error;\n  return data;`],
    ["log argument (shorthand property)", `const { data, error } = await sc.from("t").select("id").maybeSingle();\n  logger.warn({ error });\n  return data;`],
    ["passthrough return", `const { data, error } = await sc.from("t").select("id").maybeSingle();\n  return { data, error };`],
    ["combined condition", `const { data, error } = await sc.from("t").select("id").maybeSingle();\n  if (error || !data) return null;\n  return data;`],
    ["r.error on a whole-result binding", `const res = await sc.from("t").select("id").maybeSingle();\n  if (res.error) throw res.error;\n  return res.data;`],
    ["res?.error optional access", `const res = await sc.from("t").select("id").maybeSingle();\n  if (res?.error) throw res.error;\n  return res?.data;`],
    ["result passed whole to a function", `const res = await sc.from("t").select("id").maybeSingle();\n  return unwrapResult(res);`],
    ["result returned whole", `return await sc.from("t").select("id").maybeSingle();`],
    ["chain returned unawaited (delegated to the caller)", `return sc.from("t").select("id").maybeSingle();`],
    ["chain passed as a thunk", `return withRetry(() => sc.from("t").select("id").maybeSingle());`],
    [".throwOnError() makes the promise reject", `const { data } = await sc.from("t").select("id").throwOnError();\n  return data;`],
    ["rest element that reads .error", `const { data, ...rest } = await sc.from("t").select("id").maybeSingle();\n  if (rest.error) throw rest.error;\n  return data;`],
    ["Promise.all elements that each read error", `const [a, b] = await Promise.all([sc.from("t1").select("id"), sc.from("t2").select("id")]);\n  if (a.error || b.error) throw new Error("x");\n  return [a.data, b.data];`],
    [".then callback that reads error", `return sc.from("t").select("id").then(({ data, error }) => { if (error) throw error; return data; });`],
    [".rpc used as a write (`{ error }` only)", `const { error } = await sc.rpc("bump", { id });\n  if (error) throw error;\n  return true;`],
    [".rpc discarded is a write-style call, not this guard's class", `await sc.rpc("bump", { id });\n  return true;`],
  ];
  for (const [name, body] of cases) {
    it(name, () => {
      assert.deepEqual(reads(inGate(body)), [], `expected no unchecked read for: ${name}`);
    });
  }
});

describe("scanSource — chains that are not PostgREST reads", () => {
  const cases: Array<[string, string]> = [
    ["write chain with trailing .select().single()", `const { data } = await sc.from("t").insert({ id }).select("id").single();\n  return data;`],
    ["update chain", `const { data } = await sc.from("t").update({ x: 1 }).eq("id", id).select();\n  return data;`],
    ["storage bucket", `const { data } = await sc.storage.from("post-media").list(id);\n  return data;`],
    ["auth.getUser (the discovery viewer-resolution shape — deliberately not judged)", `const { data } = await sc.auth.getUser(id);\n  return data?.user?.id ?? null;`],
    ["Array.from", `const { data } = await Promise.resolve({ data: Array.from([1]) });\n  return data;`],
    ["realtime channel", `const { data } = await sc.channel("x").subscribe();\n  return data;`],
  ];
  for (const [name, body] of cases) {
    it(name, () => {
      assert.deepEqual(reads(inGate(body)), [], `expected no read for: ${name}`);
    });
  }
});

// ── Scope tiers ─────────────────────────────────────────────────────────────

describe("scope tiers", () => {
  // `terminal` is required by tierOf. "select" is the inert choice: the only
  // rule that reads it is the write-precondition tier, which fires solely for
  // "maybeSingle"/"single" AND only when a `writtenInFn` set is passed — and no
  // call below passes one. So this default cannot move any verdict here; it
  // makes the fixture match the shape tierOf actually takes.
  const read = (
    over: Partial<UncheckedRead> = {},
  ): Pick<UncheckedRead, "table" | "fn" | "file" | "terminal"> => ({
    table: "posts",
    fn: "handler",
    file: "routes/x.ts",
    terminal: "select",
    ...over,
  });

  it("exclusion tables are in scope wherever they are read", () => {
    for (const t of EXCLUSION_TABLES) assert.equal(tierOf(read({ table: t, fn: "get /anything" })), "exclusion-table", t);
  });

  it("gate-named helpers are in scope; route handlers and plain helpers are not", () => {
    for (const fn of ["requireAdmin", "canMessage", "isBlocked", "hasActiveTrustCap", "checkEligibility", "verifyThreadMember", "ensureDefaultCollection", "getMemberRole", "resolveViewer", "loadVisibilityPrefs", "authorizePost", "enforceBookingCreationGates"]) {
      assert.equal(isGateFunctionName(fn), true, fn);
    }
    for (const fn of ["get /trips/:id/members", "post /events", "use *", "loadStops", "resolveDisplayNames", "listRecommendations", "<module>"]) {
      assert.equal(isGateFunctionName(fn), false, fn);
    }
    assert.equal(tierOf(read({ fn: "get /trips/:id/members", table: "trip_members" })), null);
  });

  it("a guard-named FILE puts every read in scope regardless of helper name", () => {
    assert.equal(tierOf(read({ file: "services/hiddenGems/HiddenGemPrivacyGuard.ts", fn: "resolveGemCoords" })), "guard-file");
    assert.equal(tierOf(read({ file: "lib/mediaAccess.ts", fn: "decide" })), "guard-file");
    assert.equal(tierOf(read({ file: "routes/hiddenGems.ts", fn: "loadGem" })), null);
  });

  it("feature_flags reads are in scope even inside a route handler", () => {
    assert.equal(tierOf(read({ table: "feature_flags", fn: "post /airport/sessions" })), "flag-table");
  });

  it("scanSource stamps the tier on every read", () => {
    const src = `async function handler(sc: any, id: string) {
      const { data: b } = await sc.from("blocks").select("id").eq("blocker_id", id);
      const { data: p } = await sc.from("posts").select("id").eq("id", id).maybeSingle();
      return [b, p];
    }`;
    const r = reads(src);
    assert.deepEqual(r.map((x) => [x.table, x.tier]), [["blocks", "exclusion-table"], ["posts", null]]);
  });
});

// ── 2. The five real sites ──────────────────────────────────────────────────

describe("the five sites this session fixed — against the real files", () => {
  const real = (rel: string): string => readFileSync(resolve(SRC, rel), "utf8");

  it("routes/events.ts trust gate: fixed form is silent; reverting the fix by text is caught IN SCOPE", () => {
    const rel = "routes/events.ts";
    const src = real(rel);
    const key = `${rel}::checkEventEligibility::trust_profiles.maybeSingle`;
    assert.ok(!keysOf(src, rel).includes(key), "the fixed trust_profiles read must not be reported");

    // RE-ANCHORED 2026-09-08. The fixed form used to be an inline
    // `{ data: tp, error: tpErr }` binding in this route. census-trust A17 moved
    // the read behind the canonical seam — `getTrustProfileResult`, which owns
    // the three states — so the binding this test reverted no longer exists.
    //
    // The test's own message said "re-anchor the test", and that is what this
    // is. What it proves is unchanged and still worth proving: revert the gate
    // to an unbound-error read and checkUncheckedSupabaseReads must catch it IN
    // SCOPE, at gate-function tier. The revert now reconstructs the pre-seam
    // shape rather than editing a binding that is gone.
    const fixedAnchor = /const tpRead = await getTrustProfileResult\(sc, userId\);/;
    assert.match(
      src, fixedAnchor,
      "events.ts no longer routes its trust gate through getTrustProfileResult — re-anchor the test",
    );
    const reverted = src.replace(
      fixedAnchor,
      'const { data: tp } = await sc.from("trust_profiles").select("overall_score").eq("user_id", userId).maybeSingle();',
    );
    const hit = reads(reverted, rel).find((r) => r.key === key);
    assert.ok(hit, "reverting the fix must be reported");
    assert.equal(hit.shape, "data-only");
    assert.equal(hit.tier, "gate-function");
  });

  it("services/airport/LayoverRecommendationService.ts getRecommendations: fixed form silent; reverted form detected (out of the enforced tiers, by design)", () => {
    const rel = "services/airport/LayoverRecommendationService.ts";
    const src = real(rel);
    const key = `${rel}::getRecommendations::layover_recommendations.filter`;
    assert.ok(!keysOf(src, rel).includes(key));

    const fnStart = src.indexOf("export async function getRecommendations(");
    assert.ok(fnStart > 0, "getRecommendations moved — re-anchor");
    const fnEnd = src.indexOf("\n}", fnStart);
    const body = src.slice(fnStart, fnEnd);
    assert.match(body, /const \{ data, error \} = await db/, "getRecommendations no longer binds { data, error } — re-anchor");
    const reverted = src.slice(0, fnStart) + body.replace("const { data, error } = await db", "const { data } = await db") + src.slice(fnEnd);
    const hit = reads(reverted, rel).find((r) => r.key === key);
    assert.ok(hit, "reverting the fix must be detected");
    assert.equal(hit.shape, "data-only");
    // `getRecommendations` promises nothing by name and its file is not a guard
    // file: a failed read here serves NOTHING (fail-closed), so it sits outside
    // the enforced tiers. The detector sees it; the gate does not fire on it.
    assert.equal(hit.tier, null);
  });

  it("routes/airport.ts plan-add: fixed form silent; reverted form detected (out of the enforced tiers, by design)", () => {
    const rel = "routes/airport.ts";
    const src = real(rel);
    const fixedAnchor = /\{\s*data:\s*rec\s*,\s*error:\s*recError\s*\}/;
    assert.match(src, fixedAnchor, "airport.ts no longer carries `{ data: rec, error: recError }` — re-anchor");
    const before = reads(src, rel).filter((r) => r.table === "layover_recommendations" && r.terminal === "maybeSingle");
    const after = reads(src.replace(fixedAnchor, "{ data: rec }"), rel).filter((r) => r.table === "layover_recommendations" && r.terminal === "maybeSingle");
    assert.equal(after.length, before.length + 1, "reverting the plan-add fix must add exactly one detected read");
    const hit = after.find((r) => !before.some((b) => b.key === r.key))!;
    assert.equal(hit.shape, "data-only");
    assert.match(hit.fn, /^post \//, "the plan-add read lives in a route handler");
    assert.equal(hit.tier, null, "a moderation-boundary read in a handler is fail-closed (nothing served) and outside the enforced tiers");
  });

  it("routes/tripCrewLocation.ts getMemberRole: STILL drops .error on both reads (fixed by direction, not by observation) — reported, in scope, ledgered FAIL-CLOSED", () => {
    const rel = "routes/tripCrewLocation.ts";
    const hits = reads(real(rel), rel).filter((r) => r.fn === "getMemberRole");
    assert.deepEqual(hits.map((r) => [r.table, r.shape, r.tier]), [
      ["trips", "data-only", "gate-function"],
      ["trip_members", "data-only", "gate-function"],
    ]);
    const ledger = loadAllowlist().known_defects;
    for (const h of hits) assert.match(String(ledger[h.key] ?? ""), /^FAIL-CLOSED:/, `${h.key} must be ledgered as FAIL-CLOSED`);
  });

  it("routes/discovery.ts viewer resolution is an auth.getUser call — outside this guard's class, and said so", () => {
    const rel = "routes/discovery.ts";
    const src = real(rel);
    assert.match(src, /auth\.getUser\(/, "discovery.ts viewer resolution no longer calls auth.getUser — revisit the non-coverage note");
    const authReads = reads(src, rel).filter((r) => r.excerpt.includes("auth.getUser"));
    assert.deepEqual(authReads, [], "auth chains are never judged (see header: deliberately out of scope)");
  });
});

// ── 3. Allowlist contract ───────────────────────────────────────────────────

describe("allowlist contract", () => {
  const site = (key: string): UncheckedRead => ({ file: "f", line: 1, key, shape: "data-only", terminal: "maybeSingle", table: "t", fn: "canX", excerpt: "", tier: "gate-function" });
  const ok = "x".repeat(MIN_RATIONALE_CHARS);

  it("a benign entry needs a rationale of at least MIN_RATIONALE_CHARS; a short one FAILS and the site stays a violation", () => {
    const v = applyAllowlist([site("a"), site("b")], { benign: { a: ok, b: "ok" }, known_defects: {} });
    assert.deepEqual(v.benign.map((r) => r.key), ["a"]);
    assert.deepEqual(v.violations.map((r) => r.key), ["b"]);
    assert.deepEqual(v.unjustified, ["b"]);
  });

  it("a known_defects note must start with a direction label", () => {
    const v = applyAllowlist([site("a"), site("b"), site("c")], { benign: {}, known_defects: { a: `FAIL-OPEN: ${ok}`, b: `${ok} (no label)`, c: `FAIL-CLOSED: ${ok}` } });
    assert.deepEqual(v.ledgered.map((r) => r.key), ["a", "c"]);
    assert.deepEqual(v.violations.map((r) => r.key), ["b"]);
    assert.deepEqual(v.unjustified, ["b"]);
    assert.deepEqual([...DIRECTION_LABELS], ["FAIL-OPEN:", "FAIL-CLOSED:", "UNCLASSIFIED:"]);
  });

  it("an entry whose site no longer exists is STALE (the file cannot rot)", () => {
    const v = applyAllowlist([site("a")], { benign: { gone: ok }, known_defects: { a: `FAIL-OPEN: ${ok}`, alsoGone: `FAIL-CLOSED: ${ok}` } });
    assert.deepEqual(v.stale.sort(), ["alsoGone", "gone"]);
  });

  it("a key in both sections is reported and the site stays a violation", () => {
    const v = applyAllowlist([site("a")], { benign: { a: ok }, known_defects: { a: `FAIL-OPEN: ${ok}` } });
    assert.deepEqual(v.duplicated, ["a"]);
    assert.deepEqual(v.violations.map((r) => r.key), ["a"]);
  });

  it("parseAllowlist: `//` keys are prose, unknown sections throw, non-object sections throw", () => {
    const a = parseAllowlist(JSON.stringify({ "//": "hdr", benign: { "//note": "x", k: ok }, known_defects: {} }));
    assert.deepEqual(Object.keys(a.benign), ["k"]);
    assert.throws(() => parseAllowlist(JSON.stringify({ allow: {} })), /unknown top-level section/);
    assert.throws(() => parseAllowlist(JSON.stringify({ benign: [] })), /must be an object/);
    assert.throws(() => parseAllowlist("[]"), /JSON object/);
  });

  it("the committed allowlist is internally valid against the real tree (no stale, no unjustified, no duplicates)", () => {
    const scan = scanTree();
    const v = applyAllowlist(scan.reads, loadAllowlist());
    assert.deepEqual(v.stale, []);
    assert.deepEqual(v.unjustified, []);
    assert.deepEqual(v.duplicated, []);
    assert.ok(scan.filesScanned > 100 && scan.sitesJudged > 1000, `a real tree: ${scan.filesScanned} files / ${scan.sitesJudged} sites`);
    assert.ok(scan.reads.length > 0, "the enforced scope must not be empty on this tree");
  });
});

// ── 4a. The CLI against the REAL tree — the thing that makes this guard bite ──

describe("CLI against the REAL tree and the REAL allowlist", () => {
  it("exits 0, and would exit 1 if a new unchecked read appeared", () => {
    // WITHOUT THIS CASE, THIS GUARD PROTECTED NOTHING.
    //
    // Every other spawn in this file points the checker at a scratch tree through
    // UNCHECKED_READS_SRC_ROOT / UNCHECKED_READS_ALLOWLIST. Those cases prove the
    // checker's LOGIC — and no CI path anywhere ran it against the real tree, so a
    // new unchecked `.error` added tomorrow failed no check, and the 306 -> 0
    // burn-down this guard records was held up by nothing at all.
    //
    // check:guard-reachability now enforces that every guard has a control like
    // this one; this file was the finding that made that check exist, and it is
    // the reason checkUncheckedSupabaseReads could only move out of the MANUAL
    // (not enforced by CI) column once the write-precondition tier's 91 open
    // findings were classified and fixed rather than ledgered.
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT], {
      cwd: resolve(SRC, ".."),
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.status, 0, out);
    // NON-VACUITY. Exit 0 on a tree it failed to scan is the trap this repo has
    // hit repeatedly, so the run must also prove it looked at the real thing.
    assert.match(out, /scanned [1-9]\d{2,} file\(s\)/, "the real tree is hundreds of files");
    assert.match(out, /judged [1-9]\d{3,} read site\(s\)/, "the real tree is thousands of read sites");
    // …and that the ENFORCED scope is non-empty: a guard whose in-scope set fell
    // to zero would also exit 0, while checking nobody.
    const inScope = out.match(/(\d+) in scope/);
    assert.ok(inScope && Number(inScope[1]) > 0, `the enforced scope must not be empty: ${out}`);
  });
});

// ── 4b. The CLI, by exit code, against crafted trees ─────────────────────────

describe("CLI exit codes against scratch trees", () => {
  let root: string;
  let emptyAllowlist: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "unchecked-reads-"));
    emptyAllowlist = join(root, "empty-allowlist.json");
    writeFileSync(emptyAllowlist, JSON.stringify({ benign: {}, known_defects: {} }));
  });

  const run = (srcRoot: string, allowlist: string) =>
    spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT], {
      cwd: resolve(SRC, ".."),
      encoding: "utf8",
      env: { ...process.env, UNCHECKED_READS_SRC_ROOT: srcRoot, UNCHECKED_READS_ALLOWLIST: allowlist },
    });

  /** The routes/events.ts trust gate as it was before commit 10a91737. */
  const DEFECT = `
export async function checkEventEligibility(sc: any, ev: any, userId: string) {
  if (ev.trust_score_min != null) {
    const { data: tp } = await sc.from("trust_profiles").select("overall_score").eq("user_id", userId).maybeSingle();
    const score = (tp as any)?.overall_score ?? 50;
    if (score < ev.trust_score_min) return { ok: false, errorCode: "forbidden" };
  }
  return { ok: true };
}
`;
  const FIXED = DEFECT.replace("const { data: tp } = await", "const { data: tp, error: tpErr } = await").replace(
    "const score =",
    'if (tpErr) return { ok: false, errorCode: "forbidden", message: "Trust check is temporarily unavailable" };\n    const score =',
  );
  const KEY = "routes/fixture.ts::checkEventEligibility::trust_profiles.maybeSingle";

  const tree = (name: string, file: string, content: string): string => {
    const dir = join(root, name);
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), content);
    return dir;
  };

  it("an EMPTY tree exits 1 (vacuity)", () => {
    const dir = join(root, "empty");
    mkdirSync(dir, { recursive: true });
    const r = run(dir, emptyAllowlist);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /scanned ZERO files/);
  });

  it("a tree with files but no judged read site exits 1 (vacuity)", () => {
    const dir = tree("noreads", "routes/plain.ts", "export const x = 1;\n");
    const r = run(dir, emptyAllowlist);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /judged ZERO read sites/);
  });

  it("the reconstructed events.ts trust-gate defect exits 1 and names the site", () => {
    const dir = tree("defect", "routes/fixture.ts", DEFECT);
    const r = run(dir, emptyAllowlist);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(KEY), `expected ${KEY} in:\n${r.stdout}`);
    assert.match(r.stdout, /\[data-only \/ gate-function\]/);
    assert.match(r.stderr, /1 in-scope read\(s\) ignore \.error/);
  });

  it("the fixed form exits 0 with a NON-ZERO judged count (not vacuous)", () => {
    const dir = tree("fixed", "routes/fixture.ts", FIXED);
    const r = run(dir, emptyAllowlist);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /judged [1-9]\d* read site\(s\)/);
    assert.match(r.stdout, /0 in scope/);
  });

  it("a benign entry with no rationale exits 1 even though it names the site", () => {
    const dir = tree("nojustify", "routes/fixture.ts", DEFECT);
    const al = join(root, "nojustify.json");
    writeFileSync(al, JSON.stringify({ benign: { [KEY]: "fine" }, known_defects: {} }));
    const r = run(dir, al);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no rationale/);
  });

  it("a known_defects entry with a direction label exits 0; a stale entry exits 1", () => {
    const dir = tree("ledgered", "routes/fixture.ts", DEFECT);
    const good = join(root, "ledgered.json");
    writeFileSync(good, JSON.stringify({ benign: {}, known_defects: { [KEY]: "FAIL-OPEN: a failed trust_profiles read substitutes the default score and admits the caller" } }));
    const ok = run(dir, good);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /1 FAIL-OPEN/);

    const stale = join(root, "stale.json");
    writeFileSync(stale, JSON.stringify({ benign: {}, known_defects: { [KEY]: "FAIL-OPEN: " + "x".repeat(40), "routes/gone.ts::canX::t.maybeSingle": "FAIL-CLOSED: " + "x".repeat(40) } }));
    const bad = run(dir, stale);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /stale allowlist entr/);
  });

  it("scanTree over a root missing every SCOPE_DIR scans nothing", () => {
    const dir = join(root, "nodirs");
    mkdirSync(dir, { recursive: true });
    const s = scanTree(dir, SCOPE_DIRS);
    assert.equal(s.filesScanned, 0);
    assert.equal(s.sitesJudged, 0);
    rmSync(root, { recursive: true, force: true });
  });
});
