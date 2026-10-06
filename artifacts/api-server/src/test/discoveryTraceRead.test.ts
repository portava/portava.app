/**
 * The READ-ONLY door behind report:discovery-trace-coverage and
 * report:discovery-outcomes (census-discovery §55). No database here: psql is
 * replaced on PATH by a recorder, so what the reader SENDS is asserted exactly.
 * The database half (a real READ ONLY refusal, the SQL on the real schema) is
 * `db/discoveryOutcomeMeasurement.db.test.ts`.
 *
 * Pinned:
 *   R1  the SQL is reads only: no write or DDL keyword, and it selects no user id
 *   R2  every statement is sent inside BEGIN TRANSACTION READ ONLY … ROLLBACK,
 *       with default_transaction_read_only=on in PGOPTIONS, to the URL given
 *   R3  the database is never defaulted: --db-url, else REPORT_DB_URL, else nothing
 *   R4  both scripts refuse to run without a database (exit 2), before any read
 *   R5  a failed read is an error, never a partial or empty corpus; an absent
 *       recommendations table is `null` (unobserved), not []
 *   R6  §120: a window reaching before 3501's retention horizon leaves the
 *       per-request rows UNOBSERVED with the reason, never short; inside it,
 *       or with no 3501 at all, they are read
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  TRACE_RANK_EVENTS_SQL, TRACE_SERVE_REQUESTS_SQL, TRACE_SERVE_REQUESTS_PRESENT_SQL, WRITE_KEYWORDS, TRACE_RETENTION_PRESENT_SQL, TRACE_RETENTION_SQL,
  runReadOnly, readTraceCorpus, dbUrlFrom,
} from "../lib/discoveryTraceRead.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..", "..");

let bin = "";
let log = "";
const ORIGINAL_PATH = process.env["PATH"];

/** A `psql` that records argv, PGOPTIONS and stdin, and answers from $FAKE_PSQL_REPLY. */
function installRecorder(reply: string, exitCode = 0) {
  writeFileSync(join(bin, "psql"), [
    "#!/usr/bin/env bash",
    `{ printf 'ARGS:%s\\n' "$*"; printf 'PGOPTIONS:%s\\n' "$PGOPTIONS"; printf 'STDIN:\\n'; cat; printf '\\n---\\n'; } >> "${log}"`,
    `printf '%s' '${reply.replace(/'/g, "'\\''")}'`,
    `exit ${exitCode}`,
  ].join("\n"));
  chmodSync(join(bin, "psql"), 0o755);
}

before(() => {
  bin = mkdtempSync(join(tmpdir(), "p6-psql-"));
  log = join(bin, "calls.log");
  process.env["PATH"] = `${bin}:${ORIGINAL_PATH}`;
});
after(() => {
  process.env["PATH"] = ORIGINAL_PATH;
  rmSync(bin, { recursive: true, force: true });
});

describe("§55 — the reports' read-only door", () => {
  it("R1. the SQL is reads only, and selects no user id", () => {
    for (const [name, sql] of Object.entries({ TRACE_RANK_EVENTS_SQL, TRACE_SERVE_REQUESTS_SQL, TRACE_SERVE_REQUESTS_PRESENT_SQL, TRACE_RETENTION_PRESENT_SQL, TRACE_RETENTION_SQL })) {
      assert.doesNotMatch(sql, WRITE_KEYWORDS, `${name} contains a write/DDL keyword`);
      assert.match(sql.trim(), /^(WITH|SELECT)\b/, `${name} is a query`);
      assert.doesNotMatch(sql, /\buser_id\b/, `${name} must not read who`);
    }
    assert.match("INSERT INTO x", WRITE_KEYWORDS);
    assert.match("delete from x", WRITE_KEYWORDS);
    assert.match("ALTER TABLE x", WRITE_KEYWORDS);
  });

  it("R2. every statement goes inside a READ ONLY transaction that is rolled back, to the URL given", () => {
    writeFileSync(log, "");
    installRecorder("[]");
    const r = runReadOnly("postgres://given@127.0.0.1:1/x", "SELECT 1;", { since: "2026-09-01T00:00:00.000Z", until: "" });
    assert.deepEqual(r, { ok: true, stdout: "[]" });
    const call = readFileSync(log, "utf8");
    assert.match(call, /ARGS:.*-v ON_ERROR_STOP=1/);
    assert.match(call, /ARGS:.*-v since=2026-09-01T00:00:00\.000Z -v until= postgres:\/\/given@127\.0\.0\.1:1\/x/);
    assert.match(call, /PGOPTIONS:.*-c default_transaction_read_only=on/);
    assert.match(call, /STDIN:\nBEGIN TRANSACTION READ ONLY;\nSELECT 1;\nROLLBACK;\n/);
    assert.deepEqual(runReadOnly("", "SELECT 1;"), { ok: false, error: "no database URL was given" });
  });

  it("R3. the database is never defaulted", () => {
    assert.equal(dbUrlFrom(["--db-url", "postgres://a"], { REPORT_DB_URL: "postgres://b" }), "postgres://a");
    assert.equal(dbUrlFrom([], { REPORT_DB_URL: "postgres://b" }), "postgres://b");
    assert.equal(dbUrlFrom([], {}), null);
    assert.equal(dbUrlFrom([], { REPORT_DB_URL: "  " }), null);
    assert.equal(dbUrlFrom(["--db-url", "--json"], {}), null, "a flag with no value is not a URL");
    assert.equal(dbUrlFrom(["--db-url"], { REPORT_DB_URL: "postgres://b" }), null, "an explicit empty --db-url does not fall back");
  });

  it("R4. both scripts refuse to run without a database, before any read", () => {
    for (const script of ["reportDiscoveryTraceCoverage.ts", "reportDiscoveryOutcomes.ts"]) {
      writeFileSync(log, "");
      installRecorder("[]");
      const env = { ...process.env };
      delete env["REPORT_DB_URL"];
      const r = spawnSync(process.execPath, ["--import", "tsx/esm", join("src", "scripts", script), "--days", "7"], {
        cwd: API, env, encoding: "utf8", timeout: 60_000,
      });
      assert.equal(r.status, 2, `${script}: ${r.stderr}`);
      assert.match(r.stderr, /There is no default/);
      assert.equal(readFileSync(log, "utf8"), "", `${script} read nothing`);
    }
  });

  it("R5. a failed read is an error, never a partial corpus; an absent recommendations table is null", () => {
    installRecorder("", 3);
    const failed = readTraceCorpus("postgres://x", { since: "2026-09-01T00:00:00.000Z", until: null });
    assert.equal(failed.ok, false);
    // rank_events answers, and the probe says the table is absent.
    writeFileSync(join(bin, "psql"), [
      "#!/usr/bin/env bash",
      "input=$(cat)",
      `if printf '%s' "$input" | grep -q to_regclass; then printf 'f'; else printf '[{"id":"r1","surface":"discovery","outcome":"impression","event_type":null,"features":{}}]'; fi`,
    ].join("\n"));
    chmodSync(join(bin, "psql"), 0o755);
    const read = readTraceCorpus("postgres://x", { since: "2026-09-01T00:00:00.000Z", until: null });
    assert.ok(read.ok);
    if (read.ok) {
      assert.equal(read.corpus.rankEvents.length, 1);
      assert.equal(read.corpus.serveRequests, null, "absent is unobserved, not []");
    }
  });
  it("R6. a window reaching before 3501's retention horizon leaves per-request rows unobserved, said; inside it they are read", () => {
    // Routes on what each statement asks: rank_events, the table probe, the horizon probe, the horizon, the request rows.
    const fakePsql = (horizonAnswer: string, retentionPresent: string) => {
      writeFileSync(join(bin, "psql"), [
        "#!/usr/bin/env bash",
        "input=$(cat)",
        `if printf '%s' "$input" | grep -q "to_regprocedure"; then printf '${retentionPresent}';`,
        `elif printf '%s' "$input" | grep -q "discovery_recommendations_retention_cutoff()"; then printf '${horizonAnswer}';`,
        "elif printf '%s' \"$input\" | grep -q to_regclass; then printf 't';",
        "elif printf '%s' \"$input\" | grep -q 'FROM public.recommendations'; then printf '[{\"id\":\"q1\"}]';",
        "else printf '[]'; fi",
      ].join("\n"));
      chmodSync(join(bin, "psql"), 0o755);
    };
    const W = { since: "2026-08-01T00:00:00.000Z", until: null };

    fakePsql("true|2026-08-31 16:00:00+00", "t");
    const before = readTraceCorpus("postgres://x", W);
    assert.ok(before.ok);
    if (before.ok) {
      assert.equal(before.corpus.serveRequests, null, "possibly purged is unobserved, not short");
      assert.match(before.corpus.serveRequestsUnobserved ?? "", /before the per-request retention horizon \(2026-08-31 16:00:00\+00; 3501/);
    }

    fakePsql("false|2026-08-31 16:00:00+00", "t");
    const inside = readTraceCorpus("postgres://x", W);
    assert.ok(inside.ok);
    if (inside.ok) {
      assert.deepEqual(inside.corpus.serveRequests, [{ id: "q1" }]);
      assert.equal(inside.corpus.serveRequestsUnobserved, null);
    }

    fakePsql("never asked", "f");
    const no3501 = readTraceCorpus("postgres://x", W);
    assert.ok(no3501.ok);
    if (no3501.ok) assert.deepEqual(no3501.corpus.serveRequests, [{ id: "q1" }], "no 3501: nothing is purged, the record is whole");

    fakePsql("garbage", "t");
    const bad = readTraceCorpus("postgres://x", W);
    assert.equal(bad.ok, false, "an unreadable horizon is an error, never a guess");
  });
});
