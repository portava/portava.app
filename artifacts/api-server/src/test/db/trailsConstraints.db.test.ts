/**
 * trailsConstraints.db.test.ts — `02_Trails.md` §4's label cap and §7's two
 * lifecycles, proved at the DATABASE on a real PostgreSQL (census-discovery
 * DC-02, DC-04; §51).
 *
 * Why the database and not only the TypeScript: 2910's own argument for its
 * label-cap trigger — "a cap that lives only in one write path stops being true
 * the moment a second write path exists" — applies to every rule below, and
 * two of them were NOT true at the database before 3380/3381:
 *
 *   L1  §4's cap under CONCURRENCY. The 2910 trigger counts held labels with a
 *       plain SELECT. Two sessions attaching a primary label to one piece of
 *       content in two different Trails each count zero — neither sees the
 *       other's uncommitted row — and both commit: two primaries. 3380 takes a
 *       transaction-scoped advisory lock on the content before counting, and
 *       adds a partial UNIQUE index for the one budget §4 itself fixes at 1.
 *   T*  §7's transition relation. `lib/discoveryTrailObject.ts` defines it and
 *       `moveTrailLifecycle` checks it in TypeScript — read, compare, write,
 *       with nothing at the database. A second writer (an admin UPDATE, a future
 *       moderation route), or two requests racing between the read and the
 *       write, could move `archived → active` — the one move the relation calls
 *       terminal. 3381 enforces the SAME relation in a trigger, for the Trail
 *       lifecycle and for the in-Trail content lifecycle, and T5/C3 compare the
 *       database's answer with the TypeScript relation for every ordered pair.
 *
 * Every probe runs as the harness superuser against the real tables; the
 * triggers fire for every role, which is the point.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HAVE_DB, LOCAL_DB_URL, psql, exec, scalar } from "./localDb.js";
import {
  TRAIL_LIFECYCLE_STATES, TRAIL_CONTENT_STATES,
  isTrailLifecycleTransitionAllowed, isTrailContentTransitionAllowed,
  MAX_PRIMARY_TRAILS, MAX_SUPPORTING_TRAILS, MAX_SIGNALS, TRAIL_SIGNALS,
} from "../../lib/discoveryTrailObject.js";

const TAG = `dbc${randomUUID().slice(0, 8)}`;
const trailIds: string[] = [];

function psqlAsync(script: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
    p.stdin.end(script);
  });
}

function newTrail(state = "active"): string {
  const id = randomUUID();
  trailIds.push(id);
  exec(`INSERT INTO public.trails (id, slug, title, lifecycle_status) VALUES ('${id}', '${TAG}-${id.slice(0, 8)}', 'probe ${id.slice(0, 8)}', '${state}');`);
  return id;
}

function label(trail: string, source: string, relationship: string, signal: string | null = null): string {
  return `INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal) VALUES ('${trail}', 'post', '${source}', '${relationship}', ${signal ? `'${signal}'` : "NULL"});`;
}

/** SQLSTATE of a refused statement, or null when it was admitted. */
function refusal(sql: string): string | null {
  const r = psql(`\\set VERBOSITY verbose\n${sql}`);
  if (r.status === 0) return null;
  return /ERROR:\s+([0-9A-Z]{5})/.exec(r.stderr)?.[1] ?? "?????";
}

describe("DC-02 — §4's label cap holds at the database, including under concurrency", { skip: !HAVE_DB }, () => {
  after(() => { exec(`DELETE FROM public.trails WHERE slug LIKE '${TAG}-%';`); });

  test("L0. the three budgets refuse sequentially — one primary, MAX supporting, MAX signals", () => {
    const content = randomUUID();
    const ts = Array.from({ length: 1 + MAX_SUPPORTING_TRAILS + 1 }, () => newTrail());
    exec(label(ts[0]!, content, "primary"));
    assert.equal(refusal(label(ts[1]!, content, "primary")), "23514", "a second primary Trail must be refused");
    for (let i = 1; i <= MAX_SUPPORTING_TRAILS; i++) exec(label(ts[i]!, content, "supporting"));
    assert.equal(refusal(label(ts[MAX_SUPPORTING_TRAILS + 1]!, content, "supporting")), "23514");
    const sig = newTrail();
    for (let i = 0; i < MAX_SIGNALS; i++) exec(label(sig, content, "signal", TRAIL_SIGNALS[i]!));
    assert.equal(refusal(label(sig, content, "signal", TRAIL_SIGNALS[MAX_SIGNALS]!)), "23514");
    assert.equal(MAX_PRIMARY_TRAILS, 1, "§4: 'Content may have one primary Trail'");
  });

  test("L1. two sessions racing a PRIMARY label for one content into two Trails: exactly one lands", async () => {
    const content = randomUUID();
    const [a, b] = [newTrail(), newTrail()];
    // A inserts and HOLDS its transaction open; B inserts while A is uncommitted.
    const first = psqlAsync(`\\set VERBOSITY verbose\nBEGIN;\n${label(a, content, "primary")}\nSELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 400));
    const second = psqlAsync(`\\set VERBOSITY verbose\nBEGIN;\n${label(b, content, "primary")}\nCOMMIT;`);
    const [ra, rb] = await Promise.all([first, second]);
    const held = Number(scalar(`SELECT count(*) FROM public.content_trails WHERE source_id = '${content}' AND relationship = 'primary';`));
    assert.equal(held, 1, `§4 allows ONE primary Trail; the race landed ${held}.\nA: ${ra.stderr}\nB: ${rb.stderr}`);
    assert.equal(ra.status, 0, "the first writer keeps its label");
    assert.notEqual(rb.status, 0, "the second writer is refused, not silently admitted");
    assert.match(rb.stderr, /23514|23505/, "refused as a cap/uniqueness violation the API reports as a cap refusal");
  });

  test("L2. the race on a COUNTED budget (supporting) cannot overshoot MAX_SUPPORTING_TRAILS", async () => {
    const content = randomUUID();
    const ts = Array.from({ length: MAX_SUPPORTING_TRAILS + 1 }, () => newTrail());
    for (let i = 0; i < MAX_SUPPORTING_TRAILS - 1; i++) exec(label(ts[i]!, content, "supporting"));
    // One slot left; two sessions race for it.
    const first = psqlAsync(`BEGIN;\n${label(ts[MAX_SUPPORTING_TRAILS - 1]!, content, "supporting")}\nSELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 400));
    const second = psqlAsync(`BEGIN;\n${label(ts[MAX_SUPPORTING_TRAILS]!, content, "supporting")}\nCOMMIT;`);
    await Promise.all([first, second]);
    const held = Number(scalar(`SELECT count(*) FROM public.content_trails WHERE source_id = '${content}' AND relationship = 'supporting';`));
    assert.equal(held, MAX_SUPPORTING_TRAILS, `the race landed ${held} supporting labels`);
  });

  test("L3. an UPDATE that would move a label into a full budget is refused too", () => {
    const content = randomUUID();
    const [a, b] = [newTrail(), newTrail()];
    exec(label(a, content, "primary"));
    exec(label(b, content, "supporting"));
    assert.equal(
      refusal(`UPDATE public.content_trails SET relationship = 'primary' WHERE trail_id = '${b}' AND source_id = '${content}';`),
      "23514",
    );
  });
});

describe("DC-04 — §7's transition relation is enforced by the database", { skip: !HAVE_DB }, () => {
  after(() => { exec(`DELETE FROM public.trails WHERE slug LIKE '${TAG}-%';`); });

  const move = (id: string, to: string) =>
    refusal(`UPDATE public.trails SET lifecycle_status = '${to}' WHERE id = '${id}';`);

  test("T1. archived is TERMINAL at the database — an UPDATE cannot revive it", () => {
    const id = newTrail("archived");
    assert.equal(move(id, "active"), "23514", "archived → active must be refused by the database itself");
    assert.equal(scalar(`SELECT lifecycle_status FROM public.trails WHERE id = '${id}';`), "archived");
  });

  test("T2. proposed → active is admitted; proposed → stale is not", () => {
    const id = newTrail("proposed");
    assert.equal(move(id, "stale"), "23514");
    assert.equal(move(id, "active"), null);
  });

  test("T3. an UPDATE that leaves the state alone is not a transition and is admitted", () => {
    const id = newTrail("archived");
    assert.equal(refusal(`UPDATE public.trails SET title = 'renamed', updated_at = now() WHERE id = '${id}';`), null);
  });

  test("T4. two requests racing a proposed Trail — one archives, one activates — cannot end in archived → active", async () => {
    const id = newTrail("proposed");
    const archive = psqlAsync(`BEGIN;\nUPDATE public.trails SET lifecycle_status = 'archived' WHERE id = '${id}';\nSELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 400));
    // The promotion read `proposed` before the archive committed; its UPDATE
    // waits on the row lock and then re-evaluates against the ARCHIVED row.
    const activate = psqlAsync(`\\set VERBOSITY verbose\nUPDATE public.trails SET lifecycle_status = 'active' WHERE id = '${id}';`);
    const [ra, rb] = await Promise.all([archive, activate]);
    assert.equal(ra.status, 0);
    assert.notEqual(rb.status, 0, "the losing move must be refused, not applied over the archive");
    assert.equal(scalar(`SELECT lifecycle_status FROM public.trails WHERE id = '${id}';`), "archived");
  });

  test("T5. for EVERY ordered pair of distinct Trail states, the database agrees with lib/discoveryTrailObject", () => {
    const disagreements: string[] = [];
    for (const from of TRAIL_LIFECYCLE_STATES) {
      for (const to of TRAIL_LIFECYCLE_STATES) {
        if (from === to) continue;
        const id = newTrail(from);
        const admitted = move(id, to) === null;
        if (admitted !== isTrailLifecycleTransitionAllowed(from, to)) disagreements.push(`${from} → ${to}: db ${admitted}`);
      }
    }
    assert.deepEqual(disagreements, []);
  });

  test("C1. in-Trail content: just_arrived → featured is refused, just_arrived → growing admitted", () => {
    const t = newTrail();
    const content = randomUUID();
    exec(label(t, content, "primary"));
    const set = (to: string) => refusal(`UPDATE public.content_trails SET content_state = '${to}' WHERE trail_id = '${t}' AND source_id = '${content}';`);
    assert.equal(set("featured"), "23514");
    assert.equal(set("rediscovered"), "23514", "nothing that never cooled can be RE-discovered");
    assert.equal(set("growing"), null);
  });

  test("C2. for EVERY ordered pair of distinct content states, the database agrees with lib/discoveryTrailObject", () => {
    const t = newTrail();
    const disagreements: string[] = [];
    for (const from of TRAIL_CONTENT_STATES) {
      for (const to of TRAIL_CONTENT_STATES) {
        if (from === to) continue;
        const content = randomUUID();
        exec(`INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal, content_state) VALUES ('${t}', 'post', '${content}', 'signal', 'food', '${from}');`);
        const admitted = refusal(`UPDATE public.content_trails SET content_state = '${to}' WHERE trail_id = '${t}' AND source_id = '${content}';`) === null;
        if (admitted !== isTrailContentTransitionAllowed(from, to)) disagreements.push(`${from} → ${to}: db ${admitted}`);
      }
    }
    assert.deepEqual(disagreements, []);
  });

  test("C3. 2910's vocabularies still refuse what the spec does not name", () => {
    const t = newTrail();
    assert.equal(refusal(`UPDATE public.trails SET lifecycle_status = 'deleted' WHERE id = '${t}';`), "23514");
    assert.equal(refusal(`INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, content_state) VALUES ('${t}', 'post', '${randomUUID()}', 'primary', 'viral');`), "23514");
    assert.equal(refusal(`INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal) VALUES ('${t}', 'post', '${randomUUID()}', 'signal', 'vibes');`), "23514");
    assert.equal(refusal(`INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type) VALUES ('${t}', '${t}', 'related');`), "23514");
    assert.equal(refusal(`INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type) VALUES ('${t}', '${newTrail()}', 'cousin');`), "23514");
  });
});

before(() => {
  if (!HAVE_DB) return;
  assert.ok(scalar("SELECT to_regclass('public.trails') IS NOT NULL;") === "t", "2910 must be applied on the harness");
});
