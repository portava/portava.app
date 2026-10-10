/**
 * telegraphAvailabilityClientDoor — lead rulings P-T1 / P-T1a on the DIRECT
 * PostgREST door (census-telegraph §65): migrations 3653 and 3762.
 *
 * THE DEFECT. Every API door that shows another person's availability asks the
 * invisibility read (services/telegraph/availabilityInvisibility.ts). PostgREST
 * does not, and the database granted the client roles exactly what the API
 * withholds:
 *   - profiles.open_to_meet: column SELECT to anon AND authenticated (baseline,
 *     re-issued by 3740), every non-private row admitted by profiles_select — the
 *     public anon key listed an invisible owner's "open to meet";
 *   - user_availability / quick_availability_status: GRANT ALL to both roles and
 *     friend / circle / trip SELECT policies — a crew-mate read an invisible
 *     person's weekly grid and live "free now" status.
 *
 * WHAT IS PROVEN HERE, OFFLINE (the executed proof against PostgreSQL is
 * src/test/db/telegraphAvailabilityClientDoor.db.test.ts, run by CI's local-db job):
 *   A-*  the chain's END STATE, folded in apply order over the baseline and every
 *        migration: neither client role holds SELECT on profiles.open_to_meet or
 *        any privilege on the two tables — and without 3653 / 3762 they would
 *        (anti-vacuity), and 3762 sorts after the last file that grants the column
 *        (a band-T number would be re-granted by 3740: the reason it is 3762).
 *   B-*  both files are shaped for certify:migrations: one $pre$, one assertion-only
 *        postcondition that recomputes from the catalog (COMMON 2026-10-08 07:55Z).
 *   P-*  the premise: no client tree reads the two tables or the column directly,
 *        so the REVOKEs break no reader.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { blankSqlComments, expandForeachLiteralLoops } from "../scripts/lib/liveVsCanonicalCore.js";
import { isAssertionOnlyDoBlock, isPreconditionDoBlock, topLevelStatements } from "../scripts/lib/migrationSqlBlocks.js";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const MIGRATIONS = join(API_ROOT, "src", "migrations");
const F3653 = "3653_availability_client_reads_withheld.sql";
const F3762 = "3762_profiles_open_to_meet_client_read_withheld.sql";
const F3740 = "3740_client_grant_excess_boundary.sql";
const TABLES = ["user_availability", "quick_availability_status"] as const;
const CLIENT_ROLES = ["anon", "authenticated"] as const;

type Role = "anon" | "authenticated" | "public";
/** What one role holds on the three objects this file is about. */
interface Held {
  openToMeetSelect: boolean;
  table: Record<(typeof TABLES)[number], Set<string>>;
}
const ALL_PRIVS = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];

function emptyHeld(): Held {
  return { openToMeetSelect: false, table: { user_availability: new Set(), quick_availability_status: new Set() } };
}

/** Split on commas at paren depth 0. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Apply every GRANT / REVOKE in `sql` that names one of the three objects to
 * `state`, in text order. Table-level REVOKE of SELECT (or ALL) on profiles also
 * removes the column grant, as PostgreSQL does. Grants to PUBLIC are tracked as
 * the role "public" (they reach both client roles).
 */
function applyAcl(sql: string, state: Map<Role, Held>): void {
  // The file's own text, then what its FOREACH-over-a-literal loops issue
  // (expandForeachLiteralLoops returns only those expansions).
  for (const text of [blankSqlComments(sql), expandForeachLiteralLoops(sql)]) applyAclText(text, state);
}

function applyAclText(text: string, state: Map<Role, Held>): void {
  // The privilege clause may not cross a statement end (`;`) or an EXECUTE
  // literal's close (`'`): a GRANT this regex cannot finish (a FUNCTION target)
  // must not swallow the next statement.
  const re = /\b(GRANT|REVOKE)\s+([^;']+?)\s+ON\s+(?:TABLE\s+)?([A-Za-z0-9_."\s,]+?)\s+(TO|FROM)\s+([A-Za-z0-9_"\s,]+?)\s*(?:;|')/gi;
  for (const m of text.matchAll(re)) {
    const verb = m[1]!.toUpperCase();
    if ((verb === "GRANT") !== (m[4]!.toUpperCase() === "TO")) continue;
    const targets = splitTop(m[3]!).map((t) => t.trim().replace(/"/g, "").replace(/^public\./i, "").toLowerCase());
    const roles = splitTop(m[5]!)
      .map((r) => r.trim().replace(/"/g, "").toLowerCase())
      .filter((r): r is Role => r === "anon" || r === "authenticated" || r === "public");
    if (!roles.length) continue;
    for (const item of splitTop(m[2]!)) {
      const pm = /^\s*([A-Za-z]+)(?:\s+privileges)?\s*(?:\(([^)]*)\))?\s*$/i.exec(item);
      if (!pm) continue;
      const priv = pm[1]!.toLowerCase();
      const cols = pm[2]?.split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase());
      for (const t of targets) {
        for (const r of roles) {
          if (!state.has(r)) state.set(r, emptyHeld());
          const h = state.get(r)!;
          if (t === "profiles" && (priv === "select" || priv === "all")) {
            if (cols && !cols.includes("open_to_meet")) continue;
            h.openToMeetSelect = verb === "GRANT";
          } else if ((TABLES as readonly string[]).includes(t)) {
            const set = h.table[t as (typeof TABLES)[number]];
            const privs = priv === "all" ? ALL_PRIVS : [priv];
            for (const p of privs) (verb === "GRANT" ? set.add(p) : set.delete(p));
          }
        }
      }
    }
  }
}

/** The chain in apply order (byte order; ORDER_OVERRIDES names none of these files — A-0). */
function chainFiles(skip: readonly string[] = []): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !skip.includes(f)).sort();
}

function endState(files: readonly string[]): Map<Role, Held> {
  const state = new Map<Role, Held>();
  applyAcl(readFileSync(BASELINE_PATH, "utf8"), state);
  for (const f of files) applyAcl(readFileSync(join(MIGRATIONS, f), "utf8"), state);
  return state;
}

/** What `role` can use: its own grants plus PUBLIC's. */
function effective(state: Map<Role, Held>, role: "anon" | "authenticated") {
  const own = state.get(role) ?? emptyHeld();
  const pub = state.get("public") ?? emptyHeld();
  return {
    openToMeetSelect: own.openToMeetSelect || pub.openToMeetSelect,
    tables: Object.fromEntries(TABLES.map((t) => [t, [...new Set([...own.table[t], ...pub.table[t]])].sort()])) as Record<string, string[]>,
  };
}

describe("P-T1 / P-T1a — the chain's end state: no client role reads an owner's availability from PostgREST", () => {
  it("A-0: no apply-order override moves 3653, 3740 or 3762 (so byte order is the apply order here)", () => {
    const overrides = readFileSync(join(MIGRATIONS, "ORDER_OVERRIDES.json"), "utf8");
    for (const f of [F3653, F3740, F3762]) assert.ok(!overrides.includes(f), `${f} is named in ORDER_OVERRIDES.json`);
  });

  it("A-1 (anti-vacuity): WITHOUT 3653 and 3762 the chain leaves both client roles reading all three — the defect", () => {
    const state = endState(chainFiles([F3653, F3762]));
    for (const role of CLIENT_ROLES) {
      const e = effective(state, role);
      assert.equal(e.openToMeetSelect, true, `${role}: profiles.open_to_meet should be readable without 3762 (baseline + 3740)`);
      for (const t of TABLES) assert.ok(e.tables[t]!.includes("select"), `${role}: ${t} should be readable without 3653 (baseline GRANT ALL)`);
    }
  });

  it("A-2 THE POINT: with them, neither client role holds SELECT on profiles.open_to_meet or ANY privilege on the two tables", () => {
    const state = endState(chainFiles());
    for (const role of CLIENT_ROLES) {
      const e = effective(state, role);
      assert.equal(e.openToMeetSelect, false, `${role} can still SELECT profiles.open_to_meet at the end of the chain`);
      for (const t of TABLES) assert.deepEqual(e.tables[t], [], `${role} still holds ${e.tables[t]!.join(", ")} on ${t}`);
    }
  });

  it("A-3: 3762 sorts after the LAST migration that grants a client role SELECT on profiles.open_to_meet (3740 re-grants it)", () => {
    const granting: string[] = [];
    for (const f of chainFiles([F3762])) {
      const s = new Map<Role, Held>();
      applyAcl(readFileSync(join(MIGRATIONS, f), "utf8"), s);
      if ([...s.values()].some((h) => h.openToMeetSelect)) granting.push(f);
    }
    assert.ok(granting.includes(F3740), "the fold no longer sees 3740's column grant — the test went blind");
    const last = granting.sort().at(-1)!;
    assert.ok(F3762 > last, `${F3762} sorts before ${last}, which grants the column back`);
  });

  it("A-4: no migration after 3653 grants a client role anything through a run-time table name the fold cannot see", () => {
    const bad: string[] = [];
    for (const f of chainFiles().filter((x) => x > F3653)) {
      const text = blankSqlComments(readFileSync(join(MIGRATIONS, f), "utf8"));
      if (/format\(\s*'GRANT[^']*%I[^']*\bTO\s+(anon|authenticated|public)\b/i.test(text)) bad.push(f);
    }
    assert.deepEqual(bad, [], "a dynamic client GRANT after 3653 may re-open one of the three objects; resolve its targets here");
  });
});

describe("3653 / 3762 — shaped for certify:migrations, postconditions self-contained", () => {
  for (const [file, tag] of [[F3653, "3653"], [F3762, "3762"]] as const) {
    it(`B-1 ${tag}: exactly one $pre$ and one assertion-only postcondition, which reads only the catalog`, () => {
      const stmts = topLevelStatements(readFileSync(join(MIGRATIONS, file), "utf8"));
      const pre = stmts.filter((s) => isAssertionOnlyDoBlock(s) && isPreconditionDoBlock(s));
      const post = stmts.filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
      assert.equal(pre.length, 1, "exactly one $pre$ block");
      assert.equal(post.length, 1, "exactly one assertion-only postcondition");
      assert.match(post[0]!, new RegExp(`POSTCONDITION FAILED \\(${tag}\\)`));
      // The live applier runs the body and $post$ as separate requests: nothing
      // the body set in the session may be read back (COMMON 2026-10-08 07:55Z).
      assert.doesNotMatch(post[0]!, /pg_temp|current_setting\s*\(|set_config\s*\(|\btemp(orary)?\s+table\b/i);
    });
  }

  it("B-2: 3653 REVOKEs ALL from PUBLIC, anon and authenticated on exactly the two tables; 3762 one column's SELECT", () => {
    const body = (f: string) =>
      topLevelStatements(readFileSync(join(MIGRATIONS, f), "utf8"))
        .map((s) => s.replace(/^(\s|--[^\n]*\n)*/, "").trim())
        .filter((s) => /^(GRANT|REVOKE)\b/i.test(s));
    assert.deepEqual(body(F3653), [
      "REVOKE ALL ON TABLE public.user_availability FROM PUBLIC, anon, authenticated;",
      "REVOKE ALL ON TABLE public.quick_availability_status FROM PUBLIC, anon, authenticated;",
    ]);
    assert.deepEqual(body(F3762), ["REVOKE SELECT (open_to_meet) ON TABLE public.profiles FROM PUBLIC, anon, authenticated;"]);
  });
});

describe("the premise: no client tree reads the two tables or profiles.open_to_meet directly", () => {
  const CLIENT_ROOTS = ["travel-buddy-standalone/src", "travel-buddy-standalone/app", "src", "app", "packages", "posts-ui", "lib"];
  const SKIP_DIR = /(^|\/)(node_modules|__tests__|\.expo|dist|build)(\/|$)/;
  function* walk(dir: string): Generator<string> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (SKIP_DIR.test(p)) continue;
      const st = statSync(p);
      if (st.isDirectory()) yield* walk(p);
      else if (/\.(tsx?|jsx?|mjs)$/.test(e) && !/\.test\.|\.spec\./.test(e)) yield p;
    }
  }
  const clientFiles = () => CLIENT_ROOTS.flatMap((r) => [...walk(join(REPO_ROOT, r))]);

  it("P-1: no client source names either table (a .from(), a realtime filter, an rpc argument) — and the walk read real files", () => {
    const files = clientFiles();
    assert.ok(files.length > 200, `only ${files.length} client files scanned: the roots moved`);
    const hits = files
      .filter((p) => /['"`](user_availability|quick_availability_status)['"`]/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(REPO_ROOT.length + 1));
    assert.deepEqual(hits, [], "a client reads one of 3653's tables directly; it needs the API (which applies P-T1) or a GRANT migration with its reason");
  });

  it("P-2: every client .from('profiles') select list is a literal that does not name open_to_meet", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const p of clientFiles()) {
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/\.from\(\s*['"`]profiles['"`]\s*\)/g)) {
        seen++;
        const tail = src.slice(m.index!, m.index! + 600);
        const sel = /\.select\(\s*(['"`])([^'"`]*)\1/.exec(tail);
        const rel = p.slice(REPO_ROOT.length + 1);
        if (!sel) {
          if (/\.select\(/.test(tail)) bad.push(`${rel}: a non-literal select list`);
          continue;
        }
        // `*` is not flagged: with profiles' column ACL (production since the
        // baseline, every replayed database since 3740) a `*` read is already
        // refused for date_of_birth and the other ungranted columns, so 3762
        // changes nothing for it. (The two in the repository-root legacy
        // `src/services/trips.ts` are of that kind; the shipped app is
        // travel-buddy-standalone and has none.)
        if (/\bopen_to_meet\b/.test(sel[2]!)) bad.push(`${rel}: select('${sel[2]}')`);
      }
    }
    assert.ok(seen >= 3, `only ${seen} client profiles reads found: the scan went blind`);
    assert.deepEqual(bad, [], "a client selects profiles.open_to_meet directly; after 3762 it is refused with 42501");
  });
});
