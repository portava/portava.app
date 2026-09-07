/**
 * Meetup RLS — the two-table policy cycle (2461) and the self-invite it would
 * have opened (2460).
 *
 * WHAT WAS WRONG
 * ==============
 * meetups.meetups_invitee_select subqueried meetup_invites; four policies on
 * meetup_invites (and every read-path policy on meetup_time_options and
 * meetup_time_votes) subqueried meetups. Postgres, finding meetups already on
 * the policy-expansion stack, raised 42P17 on EVERY non-service read and write
 * of all four tables, on both databases. No policy selected FROM its own table,
 * so the self-reference sweep in rlsPolicyShapeLive.test.ts never saw it: the
 * cycle had length two.
 *
 * Repairing the cycle alone would have made meetup_invites writable, and
 * mi_own — FOR ALL, WITH CHECK (auth.uid() = user_id) — let any authenticated
 * caller INSERT an invite for themselves on any meetup id, then read the
 * meetup through meetups_invitee_select. 2460 (inert) hardens mi_own first;
 * 2461 (not inert) refuses to run without it. Same shape as 2401 + 2402.
 *
 * WHAT THIS FILE ASSERTS
 * ======================
 * The property is a property of the SQL, and this suite cannot reach a
 * database (the `test` script pins the connection URL at a dead port), so it
 * reads the corpus as text: the 2026-08-19 production baseline dump first,
 * then every canonical migration in order, the LAST definition of each policy
 * winning. From the winning definitions it builds the policy-reference graph
 * over the four meetup tables and asserts it is acyclic — and, so the detector
 * is not vacuous, that the same graph built from the corpus BEFORE 2461 has
 * exactly the measured cycle. The live counterpart (a sweep over the real
 * catalog) is in rlsPolicyShapeLive.test.ts; the behavioural matrix is in
 * meetupRlsLive.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/meetupRlsRecursion.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RLS_DISPOSITIONS } from "../scripts/rlsDispositions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");
const REPO_ROOT = join(HERE, "../../../..");
const BASELINE = join(HERE, "../../baseline/20260819_baseline_structure.sql");

const M2460 = "2460_meetup_invites_self_invite_latent_disclosure.sql";
const M2461 = "2461_meetup_rls_recursion.sql";

const MEETUP_TABLES = ["meetups", "meetup_invites", "meetup_time_options", "meetup_time_votes"] as const;
type MeetupTable = (typeof MEETUP_TABLES)[number];

/** The counts the migrations preserve, as scripts/rlsDispositions.ts records them. */
const EXPECTED_POLICY_COUNTS: Record<MeetupTable, number> = {
  meetups: 4, meetup_invites: 5, meetup_time_options: 4, meetup_time_votes: 3,
};

interface PolicyDef { policy: string; table: string; body: string; predicate: string; file: string }

function stripComments(sql: string): string {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

function parsePolicies(sql: string, file: string): PolicyDef[] {
  const out: PolicyDef[] = [];
  const re = /CREATE\s+POLICY\s+"?([A-Za-z0-9_]+)"?\s+ON\s+(?:public\.)?"?([A-Za-z0-9_]+)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    let depth = 0; let end = sql.length;
    for (let i = re.lastIndex; i < sql.length; i++) {
      const c = sql[i];
      if (c === "(") depth++; else if (c === ")") depth--; else if (c === ";" && depth === 0) { end = i; break; }
    }
    const body = stripComments(sql.slice(m.index, end));
    const kw = body.search(/\b(USING|WITH\s+CHECK)\b/i);
    out.push({ policy: m[1], table: m[2], body, predicate: kw >= 0 ? body.slice(kw) : "", file });
  }
  return out;
}

function migrationsInOrder(): Array<{ file: string; sql: string; order: number }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS, f), "utf8"), order: Number.parseInt(f, 10) }))
    .filter((m) => Number.isFinite(m.order))
    .sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
}

/** Winning definitions on the meetup tables: baseline, then migrations with order < `before`. */
function finalPolicies(before = Number.POSITIVE_INFINITY): Map<string, PolicyDef> {
  const winner = new Map<string, PolicyDef>();
  const layers = [{ file: "baseline", sql: readFileSync(BASELINE, "utf8"), order: -1 }, ...migrationsInOrder()];
  for (const { file, sql, order } of layers) {
    if (order >= before) continue;
    for (const p of parsePolicies(sql, file)) {
      if (!(MEETUP_TABLES as readonly string[]).includes(p.table)) continue;
      winner.set(`${p.table}.${p.policy}`, p);
    }
  }
  return winner;
}

/** table -> tables its winning policies read (FROM/JOIN), among the meetup set. */
function referenceGraph(finals: Map<string, PolicyDef>): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>(MEETUP_TABLES.map((t) => [t, new Set<string>()]));
  for (const def of finals.values()) {
    for (const t of MEETUP_TABLES) {
      if (t === def.table) continue;
      if (new RegExp(`(FROM|JOIN)\\s+(public\\.)?${t}\\b`, "i").test(def.predicate)) g.get(def.table)!.add(t);
    }
  }
  return g;
}

/** Every simple cycle as "a -> b -> a", deduplicated by rotation. */
function cycles(g: Map<string, Set<string>>): string[] {
  const found = new Set<string>();
  const walk = (start: string, cur: string, path: string[]) => {
    for (const next of g.get(cur) ?? []) {
      if (next === start) { const c = [...path]; const min = [...c].sort()[0]; const i = c.indexOf(min); found.add([...c.slice(i), ...c.slice(0, i), min].join(" -> ")); }
      else if (!path.includes(next)) walk(start, next, [...path, next]);
    }
  };
  for (const t of g.keys()) walk(t, t, [t]);
  return [...found].sort();
}

const migration = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

describe("meetup RLS recursion (2460 + 2461)", () => {
  it("both migrations exist, each with a rollback", () => {
    assert.ok(existsSync(join(MIGRATIONS, M2460)), `${M2460} is missing`);
    assert.ok(existsSync(join(MIGRATIONS, M2461)), `${M2461} is missing`);
    const rollbacks = readdirSync(join(REPO_ROOT, "db/rollback"));
    assert.equal(rollbacks.filter((f) => f.includes("2460")).length, 1, "exactly one 2460 rollback");
    assert.equal(rollbacks.filter((f) => f.includes("2461")).length, 1, "exactly one 2461 rollback");
  });

  it("before 2461 the corpus carries the measured cycle — the detector is not vacuous", () => {
    const before = cycles(referenceGraph(finalPolicies(2461)));
    assert.deepEqual(before, ["meetup_invites -> meetups -> meetup_invites"],
      `expected exactly the measured meetups ⇄ meetup_invites cycle before 2461, found: ${JSON.stringify(before)}`);
  });

  it("after 2461 the winning policy graph over the four meetup tables is acyclic", () => {
    const after = cycles(referenceGraph(finalPolicies()));
    assert.deepEqual(after, [], `policy-reference cycles remain: ${after.join("; ")}`);
  });

  it("the graph is layered: each table's policies read only tables below it", () => {
    const g = referenceGraph(finalPolicies());
    const rank = new Map<string, number>(MEETUP_TABLES.map((t, i) => [t, i]));
    for (const [from, tos] of g) for (const to of tos) {
      assert.ok(rank.get(to)! < rank.get(from)!,
        `${from} reads ${to}, which is not below it in ${MEETUP_TABLES.join(" < ")}`);
    }
  });

  it("no winning meetup policy selects FROM its own table or compares a column to itself", () => {
    for (const [key, def] of finalPolicies()) {
      assert.ok(!new RegExp(`(FROM|JOIN)\\s+(public\\.)?${def.table}\\b`, "i").test(def.predicate), `${key} (${def.file}) selects from its own table`);
      assert.ok(!/\(([a-z_]+)\.([a-z_]+) = \1\.\2\)/.test(def.predicate), `${key} (${def.file}) compares a column to itself`);
    }
  });

  it("2460 is inert: it touches meetup_invites.mi_own and nothing else", () => {
    const defs = parsePolicies(migration(M2460), M2460).map((p) => `${p.table}.${p.policy}`);
    assert.deepEqual(defs, ["meetup_invites.mi_own"]);
    assert.ok(!/DROP POLICY IF EXISTS meetups_invitee_select/i.test(stripComments(migration(M2460))),
      "2460 must not repair the recursion — that is 2461's job, and it is not inert");
  });

  it("2460's mi_own WITH CHECK requires an existing invitation, so a row cannot be minted", () => {
    const def = finalPolicies().get("meetup_invites.mi_own");
    assert.ok(def && def.file === M2460, `mi_own's winning definition must be 2460's, is ${def?.file}`);
    assert.match(def!.predicate, /WITH\s+CHECK\s*\([\s\S]*auth\.uid\(\)\s*=\s*user_id[\s\S]*authz\.is_meetup_invitee\s*\(\s*meetup_id\s*\)/i);
    assert.match(def!.predicate, /USING\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)/i, "the USING half (read / update / delete of one's own row) is unchanged");
  });

  it("the helper is SECURITY DEFINER, in authz, pins search_path, takes one uuid, and reads auth.uid() itself", () => {
    const sql = stripComments(migration(M2460));
    const at = sql.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+authz\.is_meetup_invitee\s*\(/i);
    assert.ok(at >= 0, "authz.is_meetup_invitee is not created by 2460");
    const fn = sql.slice(at, sql.indexOf("$fn$;", at));
    assert.match(fn, /is_meetup_invitee\s*\(\s*p_meetup_id\s+uuid\s*\)/i, "exactly one uuid parameter — a (meetup, user) signature would be an invitation oracle");
    assert.match(fn, /SECURITY\s+DEFINER/i);
    assert.match(fn, /SET\s+search_path\s*=\s*public,\s*pg_catalog/i);
    assert.match(fn, /auth\.uid\(\)/, "the viewer is auth.uid() inside the function");
    assert.ok(!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.is_meetup_invitee/i.test(sql), "never in public, where PostgREST would expose it as an RPC");
    assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+authz\.is_meetup_invitee\(uuid\)\s+TO\s+anon,\s*authenticated/i,
      "policy predicates evaluate with the querying role's privileges; anon and authenticated must be able to execute it");
  });

  it("2461 refuses to run unless 2460 is in effect", () => {
    const pre = stripComments(migration(M2461));
    assert.match(pre, /PRECONDITION FAILED:[^;]*is_meetup_invitee[^;]*apply 2460 first/i);
    assert.match(pre, /mi_own WITH CHECK does not require an existing invitation/i);
  });

  it("2461 rewrites exactly the two invitee policies, both onto the helper", () => {
    const defs = parsePolicies(migration(M2461), M2461);
    assert.deepEqual(defs.map((p) => `${p.table}.${p.policy}`).sort(), ["meetup_time_options.mto_invitee_select", "meetups.meetups_invitee_select"]);
    for (const d of defs) assert.match(d.predicate, /authz\.is_meetup_invitee\s*\(/);
  });

  it("2461 measures the error path inside the migration rather than inferring it", () => {
    assert.match(stripComments(migration(M2461)), /SET LOCAL ROLE authenticated[\s\S]*PERFORM count\(\*\) FROM public\.meetups/);
  });

  it("the rollbacks say what they reopen", () => {
    const dir = join(REPO_ROOT, "db/rollback");
    const rb2461 = readFileSync(join(dir, readdirSync(dir).find((f) => f.includes("2461"))!), "utf8");
    assert.match(rb2461, /42P17/, "2461's rollback restores the recursion and must say so");
    assert.match(rb2461, /FROM public\.meetup_invites[\s\S]*meetup_invites\.meetup_id = meetups\.id/, "it restores the measured original text");
    const rb2460 = readFileSync(join(dir, readdirSync(dir).find((f) => f.includes("2460"))!), "utf8");
    assert.match(rb2460, /REFUSING:[^']*2461 is applied/, "2460's rollback must refuse while 2461 stands");
    assert.match(rb2460, /Roll back 2461 first/);
  });

  it("policy counts on the four tables are what rlsDispositions records", () => {
    for (const t of MEETUP_TABLES) {
      assert.equal(RLS_DISPOSITIONS[t]?.policyCount, EXPECTED_POLICY_COUNTS[t], `rlsDispositions.${t}.policyCount`);
      assert.match(stripComments(migration(M2461)), new RegExp(`tablename = '${t}'\\) <> ${EXPECTED_POLICY_COUNTS[t]}`),
        `2461's postcondition must pin ${t} at ${EXPECTED_POLICY_COUNTS[t]} policies`);
    }
  });
});
