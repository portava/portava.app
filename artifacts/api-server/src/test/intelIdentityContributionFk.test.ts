/**
 * S19 / S118 — the World Intelligence store must not resolve a contribution to
 * a Portava account.
 *
 * THE FINDING, AND WHAT CLOSES IT
 * ===============================
 * `2130_intel_storage.sql:142` declares, on the one contribution table that has
 * a writer:
 *
 *     actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE
 *
 * and the same line again on `intel_evidence` (`:244`) and
 * `intel_confirmations` (`:266`). The spec names that exact shape twice:
 *
 *   §3   "World-intelligence contribution records should not carry a permanent
 *         profiles.id / account user_id foreign key unless a narrowly justified,
 *         reviewed security requirement proves it necessary."
 *   §24  "World Intelligence store cannot trivially resolve a contribution to a
 *         Portava account."
 *
 * `3002_intel_contribution_identity.sql` drops the foreign key, drops the NOT
 * NULL, and puts a BEFORE INSERT trigger on all three tables that replaces the
 * submitted account id with a rotating, non-reversible contributor token before
 * the row exists.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT
 * ===========================================
 * Two halves, because the property has two halves.
 *
 *   SCHEMA   a static contract over the migration corpus, in the shape
 *            src/test/intelStorage.test.ts and src/test/appendOnlyCascade.test.ts
 *            already use: this repo cannot reach a database from a unit test, so
 *            what is asserted is that the load-bearing DDL is PRESENT and cannot
 *            be removed silently. It is NOT a claim about Postgres semantics and
 *            does not pretend to be. The FK-drop is computed from the corpus —
 *            2130 declares it, a later file must remove it — so a future
 *            migration that re-adds one fails here.
 *
 *   BEHAVIOUR the capture path, run for real against a fake client that
 *            EMULATES 3002's trigger. This is the half a schema assertion cannot
 *            reach: that writeObservation still dedupes correctly once the
 *            stored identity is a token it cannot derive, and — the one that
 *            would be a disclosure rather than a bug — that the replay lookup
 *            never falls back to matching on `idempotency_key` alone, which a
 *            derived key makes shared between contributors.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeObservation } from "../services/intel/IntelCaptureService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");

const CONTRIBUTION_TABLES = ["intel_observations", "intel_evidence", "intel_confirmations"] as const;

/** Every migration file, ordered by numeric prefix — apply order. */
function corpus(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => (Number(a.split("_")[0]) || 0) - (Number(b.split("_")[0]) || 0))
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), "utf8") }));
}

const flat = (s: string) => s.replace(/\s+/g, " ");

/**
 * The migration that removes the account foreign key from the contribution
 * tables — found by WHAT IT DOES, never by filename, so a renumbered or
 * superseded file is still found and a second corrective one wins.
 *
 * Three properties together, because each alone matches something else:
 * 2136_profiles_auth_users_convergence.sql also drops foreign keys to profiles
 * by catalogue lookup, and would be picked by the first two.
 */
/**
 * True when the SQL contains an ARRAY literal holding exactly the three
 * contribution tables — the shape 3002 loops over to drop the constraint and
 * the NOT NULL on each. Order-insensitive; whitespace-tolerant.
 */
function contributionTableArrayLiteral(sql: string): boolean {
  const arrays = sql.match(/ARRAY\s*\[[^\]]*\]/g) ?? [];
  return arrays.some((a) => {
    const names = (a.match(/'([a-z_]+)'/g) ?? []).map((q) => q.slice(1, -1));
    return (
      names.length === CONTRIBUTION_TABLES.length &&
      CONTRIBUTION_TABLES.every((t) => names.includes(t))
    );
  });
}

function fkDropper(): { file: string; sql: string } {
  const candidates = corpus()
    .filter((m) => (Number(m.file.split("_")[0]) || 0) > 2130)
    .filter(
      (m) =>
        /DROP CONSTRAINT/.test(m.sql) &&
        /confrelid\s*=\s*'public\.profiles'::regclass/.test(m.sql) &&
        // THE THREE NAMES MUST DRIVE THE DROP, not merely appear in the file.
        //
        // The filter used to accept any migration that quoted all three names
        // anywhere. 3003 quotes them as RETURN values inside the erasure
        // function (`table_name := 'intel_evidence'`) while dropping foreign
        // keys on three ENTIRELY DIFFERENT tables, so it was selected as "the
        // dropper" and then failed for not dropping a NOT NULL it was never
        // about. A quotation is not a DDL target; the array literal that the
        // loop iterates is.
        contributionTableArrayLiteral(m.sql),
    );
  assert.ok(
    candidates.length > 0,
    "no migration after 2130 drops the actor_id -> profiles foreign key from the three contribution tables; §3's named prohibition is still violated",
  );
  return candidates[candidates.length - 1];
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The schema half
// ─────────────────────────────────────────────────────────────────────────────

describe("S19 — the account foreign key on the contribution tables", () => {
  it("premise: 2130 really does declare it on all three (else everything below is vacuous)", () => {
    const sql = readFileSync(join(MIGRATIONS, "2130_intel_storage.sql"), "utf8");
    const declarations = sql.match(/actor_id\s+uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/g) ?? [];
    assert.equal(
      declarations.length,
      3,
      "2130 no longer declares the FK three times — this test was written against that file and must be re-derived, not adjusted",
    );
  });

  it("a later migration drops every contribution-table foreign key to profiles", () => {
    const dropper = fkDropper();
    assert.ok(
      /contype\s*=\s*'f'/.test(dropper.sql),
      `${dropper.file} does not select the constraint by type; it may be dropping something else`,
    );
    // And the NOT NULL with it: a column that MUST hold a contributor identity is
    // the same requirement that forced the nearest-place snap on subject_id.
    assert.match(
      dropper.sql,
      /ALTER COLUMN actor_id DROP NOT NULL/,
      `${dropper.file} leaves actor_id NOT NULL`,
    );
  });

  it("the file that drops it asserts, in a postcondition, that none survived", () => {
    const f = flat(fkDropper().sql);
    assert.ok(
      /POSTCONDITION FAILED: % foreign key\(s\) from the intel contribution tables to profiles survive/.test(f),
      "the drop is not certified — a migration that silently failed to drop would report success",
    );
    assert.ok(
      /POSTCONDITION FAILED: % observation\(s\) still carry a value that resolves to a profiles row/.test(f),
      "nothing checks that the rows that ALREADY existed stopped resolving to accounts; dropping the constraint alone leaves the data resolvable",
    );
  });
});

describe("S19 — what replaces the foreign key", () => {
  const dropper = fkDropper;

  it("a BEFORE INSERT trigger on all three tables, so no writer can store an account id", () => {
    const f = flat(dropper().sql);
    assert.ok(
      /CREATE TRIGGER %I BEFORE INSERT ON public\.%I FOR EACH ROW EXECUTE FUNCTION public\.intel_assign_contributor_token\(\)/.test(f),
      "the swap is not enforced at the table — it would be a rule the application has to remember",
    );
    assert.ok(
      /FOREACH t IN ARRAY ARRAY\['intel_observations','intel_evidence','intel_confirmations'\]/.test(f),
      "the trigger loop does not cover all three contribution tables",
    );
    assert.ok(
      /POSTCONDITION FAILED: expected 3 contributor-token triggers/.test(f),
      "the trigger's existence is not certified",
    );
  });

  it("the trigger is NOT statement-level and NOT on UPDATE or DELETE", () => {
    // src/test/appendOnlyCascade.test.ts records, twice over, what a
    // statement-level UPDATE/DELETE trigger on these tables does to account
    // deletion. This one must not become a third round.
    const sql = dropper().sql;
    const creates = [...sql.matchAll(/CREATE TRIGGER[\s\S]{0,160}?FOR EACH (ROW|STATEMENT)/g)];
    assert.ok(creates.length > 0, "premise: the file creates a trigger");
    for (const m of creates) {
      assert.equal(m[1], "ROW", `a statement-level trigger was added: ${flat(m[0])}`);
      assert.ok(!/\bDELETE\b/.test(m[0]), `the trigger fires on DELETE: ${flat(m[0])}`);
      assert.ok(!/\bUPDATE\b/.test(m[0]), `the trigger fires on UPDATE: ${flat(m[0])}`);
    }
  });

  it("the pepper the token is derived from is readable by no application role", () => {
    const f = flat(dropper().sql);
    assert.ok(/CREATE TABLE IF NOT EXISTS public\.intel_contributor_pepper/.test(f), "no pepper table");
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      assert.ok(
        f.includes(`REVOKE ALL ON public.intel_contributor_pepper FROM ${role}`),
        `${role} is not revoked on the pepper table — the token becomes derivable over PostgREST`,
      );
    }
    assert.ok(
      !/GRANT [A-Z, ]*ON public\.intel_contributor_pepper/.test(f),
      "something is granted on the pepper table",
    );
    assert.ok(
      /ALTER TABLE public\.intel_contributor_pepper ENABLE ROW LEVEL SECURITY/.test(f),
      "RLS is not enabled on the pepper table",
    );
  });

  it("the token ROTATES — a stable pseudonym would be the tracking identity §3 forbids", () => {
    const f = flat(dropper().sql);
    assert.ok(/604800/.test(f), "no epoch length in the derivation; the token would never rotate");
    assert.ok(
      /'intel-contributor\/v1\|' \|\| p_epoch::text/.test(f),
      "the epoch is not inside the digest, so two epochs could collide on one pepper",
    );
  });

  it("erasure survives: the one entry point still refuses a null actor and still scopes every DELETE", () => {
    // The same properties src/test/intelSqlFunctionContracts.test.ts asserts,
    // re-asserted HERE against the token arm specifically: a rebuild that erased
    // only the legacy rows would pass that file and silently stop erasing.
    const all = corpus();
    let last: { file: string; body: string } | null = null;
    for (const { file, sql } of all) {
      const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.erase_intel_for_actor\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql))) {
        const end = sql.indexOf("\n$$;", m.index);
        assert.ok(end > m.index, `${file}: could not find the end of erase_intel_for_actor`);
        last = { file, body: sql.slice(m.index, end + 4) };
      }
    }
    assert.ok(last, "no migration defines erase_intel_for_actor");
    const f = flat(last.body);
    assert.ok(/IF p_actor_id IS NULL THEN RAISE EXCEPTION/.test(f), "a null actor must raise");
    assert.ok(f.includes("set_config('portava.erasure_in_progress'"), "the erasure is not declared");
    const deletes = f.match(/DELETE FROM public\.[a-z_]+[^;]*;/g) ?? [];
    assert.ok(deletes.length >= 5, `expected the five scoped deletes, found ${deletes.length}`);
    for (const t of CONTRIBUTION_TABLES) {
      const d = deletes.find((x) => x.includes(`public.${t} `));
      assert.ok(d, `${t} is no longer erased at all`);
      assert.ok(
        d.includes("actor_id = p_actor_id"),
        `${t}: pre-3002 rows (whose actor_id IS the account id) are no longer erased — \`${d}\``,
      );
      assert.ok(
        /actor_id = ANY \(v_tokens\)/.test(d),
        `${t}: tokenised rows are not erased, so account deletion silently stops removing contributions — \`${d}\``,
      );
    }
    assert.ok(
      /intel_contributor_token_for_pepper\(p_actor_id, p\.epoch, p\.pepper\)/.test(f),
      "the tokens are not derived from the pepper table, so v_tokens can only ever be empty",
    );
  });

  it("the contributor's own read survives, keyed on their own tokens and nobody else's", () => {
    const f = flat(dropper().sql);
    assert.ok(
      /CREATE POLICY intel_observations_select_own ON public\.intel_observations FOR SELECT TO authenticated USING \(actor_id = ANY \(public\.intel_self_contributor_tokens\(\)\)\)/.test(f),
      "2130's `actor_id = auth.uid()` policy was left in place (it now matches nothing) or removed without replacement",
    );
    // No argument = it can only ever answer about auth.uid(). An id parameter
    // would make it an oracle about anyone.
    assert.ok(
      /CREATE OR REPLACE FUNCTION public\.intel_self_contributor_tokens\(\) RETURNS uuid\[\]/.test(f),
      "intel_self_contributor_tokens takes an argument or is missing — it must read auth.uid() itself",
    );
    assert.ok(/v_uid := auth\.uid\(\);/.test(f), "the self-token function does not read auth.uid()");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The behaviour half — the capture path against a post-3002 database
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ACTOR_B = "11111111-1111-4111-8111-111111111112";
const PLACE = "22222222-2222-4222-8222-222222222222";
const OBSERVED = () => new Date(Date.now() - 5 * 60_000).toISOString();

/**
 * Whether the migration corpus declares the contributor-token boundary at all.
 *
 * The fake below emulates "a database with the tree's migrations applied", and
 * that is a fact ABOUT THE TREE, not a fixture switch — so it is read from the
 * corpus rather than hardcoded. Without it the fake would assert its own
 * premise: it would tokenise whether or not any migration says to, and the two
 * "what the store holds" cases below would pass against a tree that still
 * stores account ids.
 */
const TRIGGER_DECLARED = corpus().some((m) =>
  /CREATE TRIGGER %I BEFORE INSERT ON public\.%I FOR EACH ROW EXECUTE FUNCTION public\.intel_assign_contributor_token\(\)/.test(
    flat(m.sql),
  ),
);

/**
 * A fake client that behaves like a database with the corpus applied: the insert
 * trigger is emulated (actor_id in, token out) when a migration declares it,
 * `intel_contributor_token` is exposed as an RPC, and the unique index is on the
 * STORED identity.
 *
 * `rpcCalls` and `_tables` are what the assertions read; nothing else is mocked.
 */
function makePost3002Db(opts: { rpc?: boolean } = {}) {
  const token = (actorId: string) => (TRIGGER_DECLARED ? `token-of-${actorId}` : actorId);
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "intel_capture_quick_signal", enabled: true },
      { flag: "map_contributions_enabled", enabled: true },
    ],
    places: [{ id: PLACE }],
    intel_contribution_consent: [
      { user_id: ACTOR, enabled: true, withdrawn_at: null },
      { user_id: ACTOR_B, enabled: true, withdrawn_at: null },
    ],
    intel_observations: [],
  };
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  let seq = 0;

  function from(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    const filters: Array<{ col: string; val: any }> = [];
    const match = (row: any) => filters.every((f) => row[f.col] === f.val);

    function run(): { data: any; error: any } {
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...payload };
        // 3002's BEFORE INSERT trigger: the account id never reaches storage.
        // Absent that migration there is no trigger, and the account id is what
        // is stored — which is the finding, and is what the cases below catch.
        if (table === "intel_observations" && row.actor_id) row.actor_id = token(row.actor_id);
        if (table === "intel_observations" && store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      return { data: store.filter(match), error: null };
    }
    const first = () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    };
    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(col: string, val: any) { filters.push({ col, val }); return b; },
      in() { return b; },
      is() { return b; },
      lte() { return b; },
      gte() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return Promise.resolve(first()); },
      single() { return Promise.resolve(first()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }

  const client: any = { from, _tables: tables, _rpcCalls: rpcCalls, _token: token };
  if (opts.rpc !== false) {
    client.rpc = async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (fn === "intel_contributor_token") return { data: token(args.p_actor_id), error: null };
      return { data: null, error: { message: `no such function ${fn}` } };
    };
  }
  return client as SupabaseClient & {
    _tables: typeof tables;
    _rpcCalls: typeof rpcCalls;
    _token: (a: string) => string;
  };
}

const capture = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE,
  claimType: "crowd.level",
  value: { level: "busy" },
  observedAt: OBSERVED(),
  idempotencyKey: "map:one:crowd_level:busy:1",
  ...over,
});

describe("S118 — what the store holds after a capture", () => {
  it("no stored contribution carries the contributor's account id", async () => {
    const db = makePost3002Db();
    const r = await writeObservation(db, ACTOR, capture() as any);
    assert.equal(r.ok, true);
    const row = db._tables.intel_observations[0];
    assert.notEqual(row.actor_id, ACTOR, "the account id reached storage");
    assert.equal(row.actor_id, db._token(ACTOR), "the stored identity is not the rotating contributor token");
  });

  it("the contributor identity is still DISTINCT per contributor — the k-anonymity floor counts people", async () => {
    const db = makePost3002Db();
    await writeObservation(db, ACTOR, capture({ idempotencyKey: "a-1" }) as any);
    await writeObservation(db, ACTOR_B, capture({ idempotencyKey: "b-1" }) as any);
    const ids = new Set(db._tables.intel_observations.map((r) => r.actor_id));
    assert.equal(ids.size, 2, "two contributors collapsed to one stored identity — independence counting would under-count");
  });
});

describe("S19 — the idempotent replay still works once the identity is a token", () => {
  it("a replay returns the STORED row, found through the database's own derivation", async () => {
    const db = makePost3002Db();
    const first = await writeObservation(db, ACTOR, capture() as any);
    assert.equal(first.ok, true);
    const again = await writeObservation(db, ACTOR, capture() as any);
    assert.equal(again.ok, true, `replay was refused: ${JSON.stringify(again)}`);
    assert.equal((again as any).deduped, true, "the replay was stored as a second observation");
    assert.equal((again as any).observation.id, (first as any).observation.id);
    assert.ok(
      db._rpcCalls.some((c) => c.fn === "intel_contributor_token" && c.args.p_actor_id === ACTOR),
      "the replay never asked the database for the token, so it cannot have looked the row up by the stored identity",
    );
    assert.equal(db._tables.intel_observations.length, 1);
  });

  it("it does NOT fall back to matching on idempotency_key alone — that would hand back someone else's observation", async () => {
    // A derived key is a function of the CONTRIBUTION (objectId, kind, value,
    // minute), not of the contributor, so two travellers tapping the same prompt
    // in the same minute share one. Matching on it alone is a disclosure.
    const db = makePost3002Db({ rpc: false });
    const shared = "map:zone:crowd_level:busy:1";
    const mine = await writeObservation(db, ACTOR_B, capture({ idempotencyKey: shared }) as any);
    assert.equal(mine.ok, true);
    // Force the 23505 for a DIFFERENT actor by pre-seeding their stored row.
    db._tables.intel_observations.push({
      id: "someone-elses",
      actor_id: db._token(ACTOR),
      idempotency_key: shared,
      subject_id: PLACE,
    });
    const r = await writeObservation(db, ACTOR, capture({ idempotencyKey: shared }) as any);
    assert.equal(r.ok, false, "a replay that could not be confirmed was reported as success");
    assert.equal((r as any).reason, "db_error", "the unconfirmable replay must be retryable, not a silent dedup");
    assert.ok(
      !db._tables.intel_observations.some((x) => x.id === (r as any).observation?.id),
      "an observation was returned despite the lookup failing",
    );
  });
});
