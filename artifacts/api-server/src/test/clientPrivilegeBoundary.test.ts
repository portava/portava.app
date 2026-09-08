/**
 * The client-privilege boundary ratchet must fire on the shapes that reintroduce
 * the defect — and must NOT fire on the shape that is correct.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * RLS polices SELECT / INSERT / UPDATE / DELETE. It does NOT police TRUNCATE,
 * REFERENCES, TRIGGER or MAINTAIN — a policy is never consulted for those.
 * Supabase's default privileges hand a client role all eight on every new table,
 * which on production left `anon`, the UNAUTHENTICATED role, holding TRUNCATE on
 * 375 application-owned tables until 2490 revoked them.
 *
 * ── WHY THE NEGATIVE CASES MATTER MOST HERE ─────────────────────────────────
 * The first version of this check reported 18 violations, and every one was
 * wrong: it split `GRANT UPDATE (a, b, c)` on commas BEFORE stripping the
 * column list, so a COLUMN-level grant — the narrowest grant PostgreSQL offers,
 * and the opposite of this defect — was read as the unknown privileges
 * "UPDATE (A" and "B)". Those were the 21xx write-boundary migrations doing
 * exactly the right thing.
 *
 * A guard that fails on correct code gets disabled, so the column-grant case
 * below is not a nicety — it is the regression test for the bug that nearly
 * shipped.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/clientPrivilegeBoundary.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const CHECKER = join(API_ROOT, "src", "scripts", "checkClientPrivilegeBoundary.ts");

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "privbound-")); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/**
 * Build a fixture directory. Every fixture carries PADDING grants so the
 * check's own vacuity guard (>= 50 GRANT statements) is satisfied — otherwise
 * these cases would fail for the wrong reason and prove nothing about the rules.
 */
function fixture(name: string, sql: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const padding = Array.from(
    { length: 60 },
    (_, i) => `GRANT SELECT ON TABLE public.pad_${i} TO authenticated;`,
  ).join("\n");
  writeFileSync(join(dir, "0001_padding.sql"), padding);
  writeFileSync(join(dir, "9999_case.sql"), sql);
  return dir;
}

function run(dir: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: { ...process.env, CLIENT_PRIVILEGE_DIRS: dir },
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("client-privilege boundary ratchet", () => {
  it("PASSES on the real migration tree (the boundary currently holds)", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
      cwd: API_ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  });

  it("FAILS on GRANT TRUNCATE to a client role", () => {
    const { code, out } = run(fixture("truncate",
      "GRANT SELECT, TRUNCATE ON TABLE public.trips TO authenticated;"));
    assert.notEqual(code, 0);
    assert.match(out, /TRUNCATE/);
  });

  it("FAILS on GRANT REFERENCES / TRIGGER / MAINTAIN to anon", () => {
    for (const priv of ["REFERENCES", "TRIGGER", "MAINTAIN"]) {
      const { code, out } = run(fixture(`p_${priv}`,
        `GRANT ${priv} ON TABLE public.trips TO anon;`));
      assert.notEqual(code, 0, `${priv} must be rejected`);
      assert.match(out, new RegExp(priv));
    }
  });

  it("FAILS on GRANT ALL to a client role", () => {
    // This is the shape 2332's recorded rollback would execute.
    const { code, out } = run(fixture("all",
      "GRANT ALL ON TABLE public.rent_buddy_payouts TO anon, authenticated, service_role;"));
    assert.notEqual(code, 0);
    assert.match(out, /GRANT ALL to a client role/);
  });

  it("FAILS on GRANT to the PUBLIC pseudo-role", () => {
    // The shape ACL audits miss: grantee 0 does not join to pg_roles.
    const { code, out } = run(fixture("pub",
      "GRANT SELECT ON TABLE public.trips TO PUBLIC;"));
    assert.notEqual(code, 0);
    assert.match(out, /GRANT TO PUBLIC/);
  });

  it("does NOT fire on a column-level GRANT — the false positive that nearly shipped", () => {
    const { code, out } = run(fixture("cols",
      "GRANT UPDATE (bio, city_expertise, vibe_tags) ON TABLE public.local_guide_profiles TO authenticated;"));
    assert.equal(code, 0, `a column-level grant is the NARROWEST grant, not a violation:\n${out}`);
  });

  it("does NOT fire on the ordinary DML grants, nor on service_role", () => {
    const { code, out } = run(fixture("ok",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trips TO authenticated;\n" +
      "GRANT TRUNCATE, REFERENCES ON TABLE public.trips TO service_role;\n" +
      "GRANT EXECUTE ON FUNCTION public.some_fn(text) TO authenticated;"));
    assert.equal(code, 0, out);
  });

  it("FAILS VACUOUSLY-EMPTY rather than reporting success", () => {
    // A moved directory or broken glob must not read as "no violations".
    const dir = join(tmp, "empty");
    mkdirSync(dir, { recursive: true });
    const { code, out } = run(dir);
    assert.notEqual(code, 0);
    assert.match(out, /VACUOUS/);
  });
});
