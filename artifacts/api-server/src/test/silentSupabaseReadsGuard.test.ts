/**
 * checkSilentSupabaseReads — unit tests for the silent-READ guard.
 *
 * The guard's claim: supabase-js resolves `{ data, error }` rather than
 * throwing, so a read whose failure is never bound, never caught for real, or
 * coalesced into `[] / 0 / false` turns a database outage into confident
 * product state. These fixtures pin every decision the scanner makes.
 *
 * Two kinds of test live here, deliberately:
 *
 *   1. SYNTHETIC fixtures for each shape and each exemption — fast, readable,
 *      and stable against unrelated edits to the tree.
 *   2. REAL-FILE assertions for the four fail-closed helpers the guard must not
 *      slander. A synthetic copy of `lib/blocks.ts` proves the scanner handles
 *      a shape; only the real file proves it handles THAT file. If someone
 *      later widens a rule and buries `fetchBlockedSet` in the report, this is
 *      where it fails.
 *
 * Run: node --import tsx/esm --test src/test/silentSupabaseReadsGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSilentSupabaseReads,
  referencesIdentifier,
  errorBindingNames,
  bindsError,
  baselineKey,
  scanTree,
  ESCAPE_HATCH,
  CONSEQUENTIAL_TABLES,
  TOTAL_KEY,
  BASELINE_PATH,
  type SilentRead,
} from "../scripts/checkSilentSupabaseReads.js";
import { compareToBaseline } from "../scripts/lib/supabaseCallScan.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");
const F = "fixture.ts";

const shapes = (src: string): string[] => findSilentSupabaseReads(src, F).map((v) => v.shape);

// ── S1: an error binding nobody ever reads ──────────────────────────────────

describe("S1 — orphaned error binding", () => {
  it("flags a shorthand `error` that is never used again", () => {
    const v = findSilentSupabaseReads(
      `async function f(sc: any) {
         const { data, error } = await sc.from("t").select("id");
         return data ?? [];
       }`,
      F,
    );
    assert.deepEqual(v.map((x) => x.shape), ["S1"]);
    assert.match(v[0].detail, /`error` bound and never read/);
  });

  it("flags an ALIASED error binding that is never used again", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data: rows, error: rowsErr } = await sc.from("t").select("id");
         return rows;
       }`),
      ["S1"],
    );
  });

  it("does NOT flag an error that is checked", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data, error } = await sc.from("t").select("id");
         if (error) return null;
         return data;
       }`),
      [],
    );
  });

  it("does NOT flag `if (error) throw error` — that is compliance", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data, error } = await sc.from("t").select("id").single();
         if (error) throw error;
         return data;
       }`),
      [],
    );
  });

  it("is NOT satisfied by an unrelated `logger.error` two lines down", () => {
    // The whole shape dies if a plain word search counts `req.log.error` as a
    // reference — `error` appears on every third line of this codebase.
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data, error } = await sc.from("t").select("id");
         req.log.error({ msg: "something else entirely" });
         return data;
       }`),
      ["S1"],
    );
  });

  it("is NOT satisfied by an `error:` object KEY in a response body", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data, error } = await sc.from("t").select("id");
         res.status(500).json({ error: "db_error" });
         return data;
       }`),
      ["S1"],
    );
  });

  it("declines to judge the `({ data, error } = await …)` reassignment idiom", () => {
    // routes/profile.ts and routes/passport.ts: a fallback select assigned to an
    // OUTER `let`, whose `if (error)` sits after the enclosing block. Block-scope
    // reasoning does not reach it, so the shape must not guess.
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         let { data, error } = await sc.from("profiles").select("a").maybeSingle();
         if (error && (error as any).code === "42703") {
           ({ data, error } = await sc.from("profiles").select("b").maybeSingle());
         }
         if (error) return null;
         return data;
       }`),
      [],
    );
  });

  it("ignores a WRITE — that is the sibling guard's territory", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { error } = await sc.from("t").update({ a: 1 }).eq("id", "x");
       }`),
      [],
    );
  });
});

// ── S2: a dead catch around a read that binds no error at all ───────────────

describe("S2 — dead catch around a consequential read", () => {
  it("flags an empty catch around an awaited select", () => {
    const v = findSilentSupabaseReads(
      `async function f(sc: any) {
         try {
           const { data } = await sc.from("t").select("id");
           use(data);
         } catch {}
       }`,
      F,
    );
    assert.deepEqual(v.map((x) => x.shape), ["S2"]);
  });

  it("flags a comment-only catch (a comment is not handling)", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         try {
           const { data } = await sc.from("t").select("id");
           use(data);
         } catch { /* non-fatal */ }
       }`),
      ["S2"],
    );
  });

  it("flags maybeSingle, single and rpc, not just select", () => {
    for (const call of ['.select("id").maybeSingle()', '.select("id").single()']) {
      assert.deepEqual(
        shapes(`async function f(sc: any) {
           try { const { data } = await sc.from("t")${call}; use(data); } catch {}
         }`),
        ["S2"],
        call,
      );
    }
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         try { const { data } = await sc.rpc("thing", { a: 1 }); use(data); } catch {}
       }`),
      ["S2"],
    );
  });

  it("does NOT flag a catch containing real handling", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         try {
           const { data } = await sc.from("t").select("id");
           use(data);
         } catch (err) { logger.warn({ err }, "read failed"); }
       }`),
      [],
    );
  });

  it("is NOT exempted by an `error:` key in a response literal", () => {
    // The tempting over-exemption: the try body contains the word `error`, so
    // the catch looks observed. It is not — the read still dropped its own.
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         try {
           const { data } = await sc.from("t").select("id");
           if (!data) res.status(500).json({ error: "db_error" });
         } catch {}
       }`),
      ["S2"],
    );
  });

  it("does NOT flag an empty catch when the try body BINDS an error", () => {
    // The load-bearing exemption. This is lib/mediaAccess.ts branches 3a–3f in
    // miniature: the read keeps its error and reports it; the catch covers only
    // the network-level throw, and its emptiness is not the silence.
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         try {
           const { data, error: rowErr } = await sc.from("t").select("id").maybeSingle();
           noteLookupFailure("3a", rowErr, {});
           use(data);
         } catch { /* fall through */ }
       }`),
      [],
    );
  });

  it("does NOT let a NESTED try's own catch implicate the outer one", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         try {
           try { const { data } = await sc.from("t").select("id"); use(data); } catch (e) { log(e); }
           other();
         } catch {}
       }`),
      [],
    );
  });

  it("ignores a WRITE-only try body — the sibling guard owns that", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         try { await sc.from("t").insert({ a: 1 }); } catch {}
       }`),
      [],
    );
  });
});

// ── S3: a read consumed by .then with no rejection path ─────────────────────

describe("S3 — dangling `.then`", () => {
  it("flags `.then(r => r.data)` with no rejection handler", () => {
    assert.deepEqual(
      shapes(`function f(sc: any) {
         return sc.from("t").select("a").limit(1).maybeSingle().then((r: any) => r.data);
       }`),
      ["S3"],
    );
  });

  it("does NOT flag a `.then` whose callback binds the error", () => {
    assert.deepEqual(
      shapes(`function f(sc: any) {
         return sc.from("t").select("a").then(({ data, error }: any) => { if (error) log(error); return data; });
       }`),
      [],
    );
  });

  it("does NOT flag `.then(undefined, …)` — the fulfilment arm is `undefined`", () => {
    // lib/mediaAccess.ts uses exactly this: `.then(undefined, () => ({ data: null }))`.
    // Only the FIRST argument is read, or the rejection arm's own `{ data: null }`
    // fallback would look like a consumption of the resolved value.
    assert.deepEqual(
      shapes(`function f(sc: any) {
         return sc.from("t").select("a").maybeSingle().then(undefined, () => ({ data: null }));
       }`),
      [],
    );
  });

  it("STILL flags a chain that ends in `.catch(…)` — a failed read never rejects", () => {
    // The tempting rule is "a rejection handler exempts the site". It does not:
    // PostgREST failures RESOLVE with `{ error }`, which this callback already
    // dropped, so `.catch` catches a path the defect never takes.
    // routes/trust-admin.ts is exactly this shape.
    assert.deepEqual(
      shapes(`function f(sc: any) {
         return sc.from("t").select("a").then((r: any) => r.data).catch(() => null);
       }`),
      ["S3"],
    );
  });

  it("does NOT flag a `.then` whose FULFILMENT arm consumes nothing", () => {
    assert.deepEqual(
      shapes(`function f(sc: any) {
         return sc.from("t").select("a").then((r: any) => r, () => ({ count: 0 }));
       }`),
      [],
    );
  });

  it("does NOT flag a `.then` on something that is not a supabase read", () => {
    assert.deepEqual(
      shapes(`function f() {
         return import("./mod.js").then(({ thing }) => thing());
       }`),
      [],
    );
  });
});

// ── S4: consequence-gated coalesce ──────────────────────────────────────────

describe("S4 — consequence-gated coalesce", () => {
  it("flags `data ?? []` on a gate-table read with no error binding", () => {
    const v = findSilentSupabaseReads(
      `async function f(sc: any) {
         const { data } = await sc.from("user_follows").select("following_id");
         const rows = data ?? [];
         return rows.length === 0 ? "all caught up" : rows;
       }`,
      F,
    );
    assert.deepEqual(v.map((x) => x.shape), ["S4"]);
    assert.match(v[0].detail, /user_follows/);
  });

  it("flags `?? 0` and `?? false` too", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data: score } = await sc.from("trust_profiles").select("score").maybeSingle();
         return score ?? 0;
       }`),
      ["S4"],
    );
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data: hazard } = await sc.from("rent_buddy_safety_events").select("id").maybeSingle();
         return hazard ?? false;
       }`),
      ["S4"],
    );
  });

  it("does NOT flag the same coalesce when the read binds its error", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data, error } = await sc.from("user_follows").select("following_id");
         if (error) return null;
         return data ?? [];
       }`),
      [],
    );
  });

  it("is TABLE-GATED: an ordinary table is not flagged", () => {
    // Ungated this shape matches many hundreds of fail-soft display reads and
    // becomes noise. The gate is the reason the report stays readable.
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         const { data } = await sc.from("posts").select("id");
         return data ?? [];
       }`),
      [],
    );
    assert.equal(CONSEQUENTIAL_TABLES.has("posts"), false);
    assert.equal(CONSEQUENTIAL_TABLES.has("blocks"), true);
  });

  it("keeps the seven gate tables from silentSchemaErrorCatches.test.ts", () => {
    for (const t of [
      "blocks",
      "user_mutes",
      "post_hides",
      "close_friends",
      "profile_privacy_settings",
      "user_account_states",
      "message_thread_members",
    ]) {
      assert.equal(CONSEQUENTIAL_TABLES.has(t), true, t);
    }
  });
});

// ── The escape hatch ────────────────────────────────────────────────────────

describe("escape hatch", () => {
  it("honours a waiver WITH a reason, in a catch body", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         try {
           const { data } = await sc.from("t").select("id");
           use(data);
         } catch {
           // ${ESCAPE_HATCH}: cache warm-up; a cold cache is the same outcome.
         }
       }`),
      [],
    );
  });

  it("does NOT honour a BARE token, and says so", () => {
    // The write guard accepts a bare token. That gap is closed here: a waiver
    // nobody can review is not a waiver.
    const v = findSilentSupabaseReads(
      `async function f(sc: any) {
         try {
           const { data } = await sc.from("t").select("id");
           use(data);
         } catch {
           // ${ESCAPE_HATCH}
         }
       }`,
      F,
    );
    assert.deepEqual(v.map((x) => x.shape), ["S2"]);
    assert.match(v[0].detail, /carries no reason/);
  });

  it("accepts a waiver on the line ABOVE a shape with no catch body (S1)", () => {
    assert.deepEqual(
      shapes(`async function f(sc: any) {
         // ${ESCAPE_HATCH}: probe only — the caller reruns this on the next tick.
         const { data, error } = await sc.from("t").select("id");
         return data;
       }`),
      [],
    );
  });

  it("uses the SAME token as the write guard, so one grep finds both", () => {
    assert.equal(ESCAPE_HATCH, "resolves-not-throws-ok");
  });
});

// ── Helper units ────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("referencesIdentifier separates a USE from a property and a key", () => {
    assert.equal(referencesIdentifier("if (error) return null;", "error"), true);
    assert.equal(referencesIdentifier("return error.message;", "error"), true);
    assert.equal(referencesIdentifier("res.json({ error });", "error"), true);
    assert.equal(referencesIdentifier("req.log.error({ a: 1 });", "error"), false);
    assert.equal(referencesIdentifier('res.json({ error: "db_error" });', "error"), false);
  });

  it("errorBindingNames reads shorthand and alias patterns", () => {
    assert.deepEqual(errorBindingNames("{ data, error }"), ["error"]);
    assert.deepEqual(errorBindingNames("{ data: rows, error: rowsErr }"), ["rowsErr"]);
    assert.deepEqual(errorBindingNames("{ data }"), []);
  });

  it("bindsError does not mistake `new Error(…)` for an observation", () => {
    assert.equal(bindsError("throw new Error('boom');"), false);
    assert.equal(bindsError("const { data, error } = x;"), true);
    assert.equal(bindsError("const rowErr = y;"), true);
    assert.equal(bindsError("if (res.error) return null;"), true);
    // A METHOD named error is a log call, not an observation of a resolved one.
    assert.equal(bindsError('req.log.error({ a: 1 }, "starting");'), false);
    // An error KEY in a response literal observes nothing. Counting it would
    // exempt the route handlers this guard exists for.
    assert.equal(bindsError('res.status(500).json({ error: "db_error" });'), false);
    assert.equal(bindsError("const [{ data, error }] = await Promise.all([q]);"), true);
  });
});

// ── The real fail-closed helpers this guard must not slander ────────────────

describe("must not flag — the fail-closed helpers, as they actually are", () => {
  const scanFile = (rel: string): SilentRead[] =>
    findSilentSupabaseReads(readFileSync(resolve(SRC, rel), "utf8"), rel);

  it("lib/blocks.ts — checks error, returns a DISTINCT null sentinel", () => {
    assert.deepEqual(scanFile("lib/blocks.ts"), []);
  });

  it("lib/featureFlags.ts — fails closed to false by design, one chokepoint", () => {
    assert.deepEqual(scanFile("lib/featureFlags.ts"), []);
  });

  it("lib/liveClaimRead.ts — documented fail-closed gates", () => {
    assert.deepEqual(scanFile("lib/liveClaimRead.ts"), []);
  });

  it("lib/mediaAccess.ts — the noteLookupFailure branches are all exempt", () => {
    // Branches 3a–3f each bind their read's error and hand it to
    // noteLookupFailure; every one of those comment-only catches is exempt.
    // Branch 3g (generated_visuals) is the one that does NOT, and the guard
    // reports it — a real finding, baselined rather than fixed in this PR.
    const v = scanFile("lib/mediaAccess.ts");
    assert.equal(v.length, 1, `expected only branch 3g, got ${JSON.stringify(v)}`);
    assert.equal(v[0].shape, "S2");
  });
});

// ── The ratchet itself ──────────────────────────────────────────────────────

describe("baseline ratchet", () => {
  const mk = (file: string, shape: SilentRead["shape"]): SilentRead => ({
    file,
    line: 1,
    shape,
    detail: "x",
  });

  it("keys per FILE and per SHAPE, so fixing an S2 cannot pay for a new S1", () => {
    assert.equal(baselineKey(mk("a.ts", "S2")), "a.ts::S2");
    const baseline = { "a.ts::S2": 1 };
    const { newViolations } = compareToBaseline([mk("a.ts", "S1")], baseline, baselineKey);
    assert.equal(newViolations.length, 1);
    assert.equal(newViolations[0].shape, "S1");
  });

  it("is two-sided: a fixed site leaves a STALE entry that also fails", () => {
    const { newViolations, staleEntries } = compareToBaseline([], { "a.ts::S2": 2 }, baselineKey);
    assert.equal(newViolations.length, 0);
    assert.deepEqual(staleEntries, [{ file: "a.ts::S2", baselined: 2, found: 0 }]);
  });

  it("does not treat the `__` floor key as a site that went stale", () => {
    const { staleEntries } = compareToBaseline([], { [TOTAL_KEY]: 400 }, baselineKey);
    assert.deepEqual(staleEntries, []);
  });

  it("the committed baseline matches the tree exactly, in both directions", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
    const { violations, filesScanned } = scanTree();
    const { newViolations, staleEntries } = compareToBaseline(violations, baseline, baselineKey);
    assert.deepEqual(newViolations, [], "NEW silent reads — see check:silent-supabase-reads");
    assert.deepEqual(staleEntries, [], "STALE baseline entries — lower the counts");
    assert.ok(
      filesScanned >= baseline[TOTAL_KEY],
      `scanned ${filesScanned} files, below the ${TOTAL_KEY} floor of ${baseline[TOTAL_KEY]}`,
    );
  });

  it("carries a floor so a guard whose subject vanished cannot pass green", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
    assert.ok(baseline[TOTAL_KEY] >= 400, "the floor must stay meaningful");
  });
});
