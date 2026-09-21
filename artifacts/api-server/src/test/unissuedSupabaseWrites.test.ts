/**
 * `check:unissued-supabase-writes` must fire — and must not fire on the correct
 * idiom, which differs from the broken one by a single chained call.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * PostgrestBuilder is a THENABLE, not a promise: it builds its headers and calls
 * `_fetch` inside `then()` (@supabase/postgrest-js@2.108.2,
 * PostgrestBuilder.ts:267-311). So
 *
 *     void sc.from("buddy_booking_events").insert({ ... });
 *
 * constructs a request object and discards it. No HTTP call is made. Not a lost
 * error, not an unawaited race — the row is never written. Twenty such sites
 * existed when this guard was written, including essentially the whole
 * Rent-A-Buddy booking audit trail, post edit history and the stamp
 * reconciliation log.
 *
 * ── WHY A GUARD AND NOT A TEST ───────────────────────────────────────────────
 * Because a test fake CANNOT see it, and one in this repository was written
 * around it: src/test/rentABuddy.test.ts captures inserted rows EAGERLY inside
 * `.insert()`, with a comment recording that "`_resolve()` is never reached". The
 * suite therefore proved the row was CONSTRUCTED and never that it was SENT. The
 * only witness that can tell those apart is the real client — which is exactly
 * what a suite replaces — so the check has to be static.
 *
 * The runtime fact underneath is measured, not reasoned. With a counting fetch on
 * a real client: bare void -> 0 requests; `.then(undefined, …)` -> 1; awaited -> 1.
 * `it("proves the premise at runtime")` below re-measures it, so this suite fails
 * loudly if a future supabase-js makes the bare form work and the guard becomes a
 * rule about nothing.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/unissuedSupabaseWrites.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { scanFile } from "../scripts/checkUnissuedSupabaseWrites.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const CHECKER = join(API_ROOT, "src", "scripts", "checkUnissuedSupabaseWrites.ts");

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "unissued-")); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** Run the checker over a crafted tree. */
function overTree(name: string, files: Record<string, string>, env: Record<string, string> = {}) {
  const root = join(tmp, name);
  mkdirSync(join(root, "routes"), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(root, f), body);
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      UNISSUED_WRITES_SRC: root,
      UNISSUED_WRITES_MIN_FILES: "1",
      UNISSUED_WRITES_MIN_VOIDS: "1",
      ...env,
    },
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("the premise, re-measured against the installed client", () => {
  it("a bare `void` write issues NO request; a continued one does", async () => {
    // If a future supabase-js makes the bare form send, this guard becomes a rule
    // about nothing and this case is where that is noticed.
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    const sc = createClient("http://127.0.0.1:9", "dummy", { global: { fetch: countingFetch } });
    const settle = () => new Promise((r) => setTimeout(r, 50));

    calls = 0;
    void sc.from("t").insert({ a: 1 });
    await settle();
    assert.equal(calls, 0, "a bare void write must issue nothing — that is the defect");

    calls = 0;
    void sc.from("t").insert({ a: 1 }).then(undefined, () => {});
    await settle();
    assert.equal(calls, 1, "the corrected idiom must actually send");

    calls = 0;
    await sc.from("t").insert({ a: 1 });
    assert.equal(calls, 1, "and an awaited write must send");
  });
});

describe("check:unissued-supabase-writes", () => {
  it("CONTROL — the real tree", () => {
    // Deliberately NOT asserting exit 0: at the time of writing the real tree has
    // 20 findings and a burn-down lane is on them. What must hold either way is
    // that the checker RAN and examined a plausible amount — an exit code alone
    // cannot tell a clean tree from a crashed scan.
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
      cwd: API_ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.match(out, /check:unissued-supabase-writes — [1-9]\d{2,} file\(s\), [1-9]\d+ void statement\(s\) examined/);
    assert.ok(r.status === 0 || r.status === 1, `unexpected exit ${r.status}: ${out}`);
  });

  it("FAILS a bare void insert", () => {
    const { code, out } = overTree("bare", {
      "routes/a.ts": `export async function f(sc: any) {\n  void sc.from("audit_events").insert({ a: 1 });\n}\n`,
    });
    assert.notEqual(code, 0);
    assert.match(out, /insert audit_events/);
    assert.match(out, /NEVER SENT/);
  });

  it("PASSES the corrected fire-and-forget idiom", () => {
    // The one that matters most: routes/reports.ts and routes/compass.ts already
    // write this, and a guard that failed on correct code would be deleted.
    const { code, out } = overTree("continued", {
      "routes/a.ts": `export async function f(sc: any) {\n  void sc.from("audit_events").insert({ a: 1 }).then(undefined, () => {});\n}\n`,
    });
    assert.equal(code, 0, out);
    assert.match(out, /every void supabase write is continued/);
  });

  it("PASSES a void over an awaited chain inside an async IIFE", () => {
    const { code, out } = overTree("awaited", {
      "routes/a.ts": `export async function f(sc: any) {\n  void (async () => { await sc.from("audit_events").insert({ a: 1 }); })();\n}\n`,
    });
    assert.equal(code, 0, out);
  });

  it("PASSES a .catch continuation", () => {
    const { code, out } = overTree("caught", {
      "routes/a.ts": `export async function f(sc: any) {\n  void sc.from("audit_events").insert({ a: 1 }).catch(() => {});\n}\n`,
    });
    assert.equal(code, 0, out);
  });

  it("does NOT flag a void over something that is not a database write", () => {
    const { code, out } = overTree("notdb", {
      "routes/a.ts": `export function f(x: any) {\n  void x.doSomething();\n  void 0;\n}\n`,
    });
    assert.equal(code, 0, out);
  });

  it("does NOT flag a void READ — a read that is never issued returns nothing to nobody", () => {
    const { code, out } = overTree("read", {
      "routes/a.ts": `export async function f(sc: any) {\n  void sc.from("audit_events").select("id");\n}\n`,
    });
    assert.equal(code, 0, out);
  });

  it("FAILS a bare void update, upsert and delete too", () => {
    for (const verb of ["update({ a: 1 })", "upsert({ a: 1 })", "delete()"]) {
      const { code, out } = overTree(`verb-${verb.slice(0, 6)}`, {
        "routes/a.ts": `export async function f(sc: any) {\n  void sc.from("audit_events").${verb};\n}\n`,
      });
      assert.notEqual(code, 0, `${verb} must be flagged: ${out}`);
    }
  });

  it("is not fooled by the word `then` in a COMMENT or a STRING", () => {
    // Six guards in this tree shipped a bug from matching raw text. The unit here
    // is the AST node, so neither can satisfy the rule.
    const { code, out } = overTree("commentstring", {
      "routes/a.ts":
        `export async function f(sc: any) {\n` +
        `  // this used to have a .then(undefined, () => {}) on it\n` +
        `  const note = ".then(undefined, () => {})";\n` +
        `  void sc.from("audit_events").insert({ note });\n` +
        `}\n`,
    });
    assert.notEqual(code, 0, out);
    assert.match(out, /insert audit_events/);
  });

  it("judges a chain that spans many lines as one unit", () => {
    const { code, out } = overTree("multiline", {
      "routes/a.ts":
        `export async function f(sc: any) {\n  void sc\n    .from("audit_events")\n    .insert({\n      a: 1,\n      b: 2,\n    })\n    .then(undefined, () => {});\n}\n`,
    });
    assert.equal(code, 0, out);
  });

  it("FAILS VACUOUSLY-EMPTY rather than reporting success", () => {
    const { code, out } = overTree("empty", { "routes/a.ts": "export const x = 1;\n" },
      { UNISSUED_WRITES_MIN_FILES: "100" });
    assert.notEqual(code, 0);
    assert.match(out, /VACUOUS/);
  });

  it("FAILS when it found no void statements at all", () => {
    const { code, out } = overTree("novoids", { "routes/a.ts": "export const x = 1;\n" });
    assert.notEqual(code, 0);
    assert.match(out, /VACUOUS/);
  });
});

describe("scanFile, directly", () => {
  it("reports the table and verb it actually found", () => {
    const r = scanFile(`export async function f(sc: any) {\n  void sc.from("post_edits").insert({ a: 1 });\n}\n`, "x.ts");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.table, "post_edits");
    assert.equal(r.hits[0]!.verb, "insert");
    assert.equal(r.hits[0]!.line, 2);
    assert.equal(r.voidsSeen, 1);
  });

  it("counts voids it did NOT flag, so vacuity can be told from cleanliness", () => {
    const r = scanFile(`export function f(x: any) { void x.go(); void 0; }\n`, "x.ts");
    assert.equal(r.hits.length, 0);
    assert.equal(r.voidsSeen, 2, "a clean file that HAS voids is not the same as a file that was never parsed");
  });
});
