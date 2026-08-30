/**
 * checkSilentSupabaseWrites — unit tests for the silent-write guard.
 *
 * The guard's claim: an empty (or comment-only) catch around an awaited
 * supabase WRITE (.insert/.update/.upsert/.delete/.rpc) is dead code, because
 * supabase-js resolves rather than throws on a DB error — so the failure is
 * silently discarded. These fixtures pin every decision the scanner makes.
 *
 * Run: node --import tsx/esm --test src/test/silentSupabaseWritesGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findSilentSupabaseWrites,
  compareToBaseline,
  sanitize,
  ESCAPE_HATCH,
} from "../scripts/checkSilentSupabaseWrites.js";

const F = "fixture.ts";

describe("findSilentSupabaseWrites — try/catch shape", () => {
  it("flags an empty catch around an awaited insert", () => {
    const src = `
      async function f(sc: any) {
        try {
          await sc.from("t").insert({ a: 1 });
        } catch {}
      }`;
    const v = findSilentSupabaseWrites(src, F);
    assert.equal(v.length, 1);
    assert.equal(v[0].shape, "try-catch");
  });

  it("flags a comment-only catch (comments are not handling)", () => {
    const src = `
      async function f(sc: any) {
        try {
          await sc.rpc("do_thing", { x: 1 });
        } catch {
          // non-fatal
        }
      }`;
    assert.equal(findSilentSupabaseWrites(src, F).length, 1);
  });

  it("does NOT flag a catch containing real handling (a log call)", () => {
    const src = `
      async function f(sc: any) {
        try {
          await sc.from("t").update({ a: 1 }).eq("id", "x");
        } catch (err) {
          logger.warn({ err }, "update failed");
        }
      }`;
    assert.equal(findSilentSupabaseWrites(src, F).length, 0);
  });

  it(`does NOT flag an empty catch carrying the "${ESCAPE_HATCH}" escape hatch`, () => {
    const src = `
      async function f(sc: any) {
        try {
          await sc.from("t").delete().eq("id", "x");
        } catch {
          // ${ESCAPE_HATCH}: intentional fire-and-forget cleanup
        }
      }`;
    assert.equal(findSilentSupabaseWrites(src, F).length, 0);
  });

  it("does NOT flag an empty catch whose try body has no supabase write (read-only)", () => {
    const src = `
      async function f(sc: any) {
        try {
          const { data } = await sc.from("t").select("id").eq("id", "x");
          JSON.parse(String(data));
        } catch {}
      }`;
    assert.equal(findSilentSupabaseWrites(src, F).length, 0);
  });

  it("does NOT implicate the outer catch for a write inside a handled nested try", () => {
    const src = `
      async function f(sc: any) {
        try {
          try {
            await sc.from("t").insert({ a: 1 });
          } catch (err) {
            logger.warn({ err }, "handled");
          }
          JSON.parse("{}");
        } catch {}
      }`;
    assert.equal(findSilentSupabaseWrites(src, F).length, 0);
  });

  it("is not fooled by braces or 'catch' inside string literals", () => {
    const src = `
      async function f(sc: any) {
        try {
          const s = "} catch {} { try {";
          await sc.from("t").insert({ a: s });
        } catch {}
      }`;
    const v = findSilentSupabaseWrites(src, F);
    assert.equal(v.length, 1, "the real empty catch is still flagged");
  });
});

describe("findSilentSupabaseWrites — promise .catch shape", () => {
  it("flags .catch(() => {}) on a supabase write chain", () => {
    const src = `
      function f(sc: any) {
        sc.from("t").insert({ a: 1 }).then(() => {}).catch(() => {});
      }`;
    const v = findSilentSupabaseWrites(src, F);
    assert.equal(v.length, 1);
    assert.equal(v[0].shape, "promise-catch");
  });

  it("does NOT flag .catch(() => {}) on a non-supabase chain", () => {
    const src = `
      function f() {
        fetch("https://x").then(() => {}).catch(() => {});
      }`;
    assert.equal(findSilentSupabaseWrites(src, F).length, 0);
  });

  it("does NOT flag a .catch with a real handler body", () => {
    const src = `
      function f(sc: any) {
        sc.from("t").insert({ a: 1 }).catch((e: any) => { logger.warn({ e }, "x"); });
      }`;
    assert.equal(findSilentSupabaseWrites(src, F).length, 0);
  });
});

describe("compareToBaseline — ratchet semantics", () => {
  const v = (file: string, line: number) =>
    ({ file, line, shape: "try-catch" as const, call: "await sc.from(t).insert(" });

  it("a file at its baselined count passes; above it, the excess is NEW", () => {
    const found = [v("a.ts", 1), v("a.ts", 2), v("b.ts", 3)];
    const { newViolations, staleEntries } = compareToBaseline(found, { "a.ts": 2, "b.ts": 1 });
    assert.equal(newViolations.length, 0);
    assert.equal(staleEntries.length, 0);

    const grown = compareToBaseline([...found, v("a.ts", 9)], { "a.ts": 2, "b.ts": 1 });
    assert.equal(grown.newViolations.length, 1, "one above baseline = one NEW");
  });

  it("an unbaselined file's violations are all NEW", () => {
    const { newViolations } = compareToBaseline([v("c.ts", 5)], {});
    assert.equal(newViolations.length, 1);
  });

  it("a fixed site makes its baseline entry stale (must be lowered)", () => {
    const { staleEntries } = compareToBaseline([v("a.ts", 1)], { "a.ts": 2 });
    assert.deepEqual(staleEntries, [{ file: "a.ts", baselined: 2, found: 1 }]);
  });
});

describe("sanitize", () => {
  it("blanks strings and comments but preserves length and newlines", () => {
    const src = `const a = "x{y}"; // } catch {\n/* try { */ const b = 1;`;
    const out = sanitize(src);
    assert.equal(out.length, src.length);
    assert.equal(out.split("\n").length, src.split("\n").length);
    assert.ok(!out.includes("x{y}"), "string contents blanked");
    assert.ok(!out.includes("catch"), "comment contents blanked");
    assert.ok(out.includes("const b = 1"), "code preserved");
  });
});
