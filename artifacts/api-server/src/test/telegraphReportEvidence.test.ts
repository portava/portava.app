/**
 * Telegraph §22 — restricted moderation storage for reported content.
 *
 * §22, both halves:
 *   "Evidence: store minimum necessary reported content/context under
 *    restricted policy."
 *   "Reported deleted content may remain in restricted moderation storage but
 *    must not appear in normal retrieval."
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * census T283: a report carries reporter, target and a 200-character reason and
 * NO CONTENT SNAPSHOT. T284: "Deletion redacts in place … so reported content
 * is DESTROYED, not restricted." A person reports a message, the sender deletes
 * it, and the moderator opens a report pointing at a row whose body is "".
 *
 * ── TWO MODES, NEITHER A SKIP ────────────────────────────────────────────────
 * Without `TELEGRAPH_DB_URL` the migration's decidable properties are asserted
 * from its TEXT — that RLS is FORCEd, that no policy is created, that there is
 * no foreign key to `messages`, that the flag is seeded FALSE, that the caps
 * are CHECKs rather than comments. With it, the file is EXECUTED and the same
 * properties are read back out of the catalog. The text assertions run either
 * way, so a run without a database is a smaller proof, not a vacuous one.
 *
 * ── WHY THE TEXT ASSERTIONS EXIST ────────────────────────────────────────────
 * Because the dangerous edits here are one line each. A `CREATE POLICY` added
 * "so admins can read it in the dashboard" hands the reported party their own
 * evidence file. A foreign key to `public.messages` added for tidiness makes a
 * deletion cascade the evidence away, which is the exact failure the table
 * exists to prevent. Neither shows up as a test failure anywhere else.
 *
 * Run: node --import tsx/esm --test src/test/telegraphReportEvidence.test.ts
 *      TELEGRAPH_DB_URL=postgresql://… node --import tsx/esm --test src/test/telegraphReportEvidence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureMessageEvidence,
  captureThreadEvidence,
  reportEvidenceEnabled,
  REPORT_EVIDENCE_FLAG,
  THREAD_CONTEXT_MESSAGES,
  MAX_BODY_SNAPSHOT,
} from "../services/telegraphReportEvidence.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, "../migrations/2812_telegraph_report_evidence.sql");
const ROLLBACK = path.join(here, "../../../../db/rollback/2026-09-12-2812-telegraph-report-evidence-rollback.sql");
const sql = readFileSync(MIGRATION, "utf8");

const DB_URL = (process.env["TELEGRAPH_DB_URL"] ?? "").trim();
const HAVE_DB = DB_URL !== "";

function exec(script: string): string[] {
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", DB_URL], {
    input: script, encoding: "utf8", timeout: 60_000,
  });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`psql exited ${r.status}:\n${(r.stderr ?? "").trim()}\n--- script ---\n${script}`);
  }
  return (r.stdout ?? "").split("\n").filter((l) => l.length > 0);
}

/* ───────────────────────── mode 1: the text, always ───────────────────────── */

describe("Telegraph 2812 — properties decidable from the migration text", () => {
  it("reports which mode this run is in, so a green is never ambiguous", () => {
    assert.ok(typeof HAVE_DB === "boolean");
    console.log(`# telegraph 2812 suite mode: ${HAVE_DB ? "EXECUTED against TELEGRAPH_DB_URL" : "TEXT ONLY (set TELEGRAPH_DB_URL to execute)"}`);
  });

  it("enables RLS and FORCEs it — the table owner must not bypass it either", () => {
    assert.match(sql, /ALTER TABLE public\.telegraph_report_evidence ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.telegraph_report_evidence FORCE ROW LEVEL SECURITY/);
  });

  it("creates NO policy at all — restricted means service-role only", () => {
    // The other Telegraph tables in this lane ship a SELECT policy keyed on
    // thread membership. That policy would be a disclosure here: the reported
    // party is often still a member of the thread they were reported in.
    assert.ok(!/CREATE POLICY/i.test(sql),
      "a policy on the evidence table reopens it to a non-service role");
  });

  it("REFUSES to complete if a policy is ever added later", () => {
    assert.match(sql, /FROM pg_policies\s*\n?\s*WHERE schemaname = 'public' AND tablename = 'telegraph_report_evidence'/);
    assert.match(sql, /POSTCONDITION FAILED: a policy exists on telegraph_report_evidence/);
  });

  it("has NO foreign key to public.messages — a deletion must not cascade the evidence away", () => {
    const table = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS public.telegraph_report_evidence"));
    const body = table.slice(0, table.indexOf(");"));
    assert.ok(!/REFERENCES\s+public\.messages/.test(body),
      "an FK to messages would either block the delete or destroy the evidence with it");
    assert.match(body, /REFERENCES public\.reports\(id\) ON DELETE CASCADE/,
      "the one FK must be to reports, so retention ends when the report does");
  });

  it("caps 'minimum necessary' with CHECKs rather than with comments", () => {
    assert.match(sql, /length\(body_snapshot\) <= 4000/);
    assert.match(sql, /pg_column_size\(context\) <= 16384/);
    assert.equal(MAX_BODY_SNAPSHOT, 4000, "the service and the CHECK must agree on the cap");
  });

  it("records WHY a snapshot is empty, rather than leaving the row absent", () => {
    assert.match(sql, /capture_status\s+text\s+NOT NULL DEFAULT 'captured'/);
    assert.match(sql, /CHECK \(capture_status IN \('captured','already_deleted','unreadable'\)\)/);
  });

  it("seeds its flag FALSE and does not reset an operator's value on re-run", () => {
    assert.match(sql, /'telegraph_report_evidence_enabled',\s*false/);
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/);
    assert.match(sql, /POSTCONDITION FAILED: telegraph_report_evidence_enabled must be seeded FALSE/);
  });

  it("does not invent a retention schedule", () => {
    // A purge job running on a number this migration made up would destroy
    // evidence on a policy nobody agreed to.
    assert.ok(!/DELETE FROM public\.telegraph_report_evidence/i.test(sql));
    assert.ok(!/pg_cron|cron\.schedule/i.test(sql));
    assert.match(sql, /retention_until\s+timestamptz NULL/);
  });

  it("the rollback names the flag as the thing to reach for instead", () => {
    const rb = readFileSync(ROLLBACK, "utf8");
    assert.match(rb, /telegraph_report_evidence_enabled/);
    assert.match(rb, /DROP TABLE IF EXISTS public\.telegraph_report_evidence/);
    assert.ok(!/DROP TABLE IF EXISTS public\.reports/.test(rb), "the rollback must not touch reports");
  });
});

/* ─────────────────────── mode 2: executed, when we can ────────────────────── */

describe("Telegraph 2812 — executed against a real PostgreSQL", { skip: !HAVE_DB }, () => {
  it("the catalog agrees with the file: RLS forced, zero policies, one FK", () => {
    exec(readFileSync(MIGRATION, "utf8"));
    const [rls] = exec(
      "SELECT c.relrowsecurity || '/' || c.relforcerowsecurity FROM pg_class c " +
      "JOIN pg_namespace n ON n.oid=c.relnamespace " +
      "WHERE n.nspname='public' AND c.relname='telegraph_report_evidence';",
    );
    // psql -At renders booleans as 'true'/'false' here (the session's
    // boolean output), not 't'/'f' — measured, not assumed.
    assert.equal(rls, "true/true", "RLS must be enabled AND forced");

    const [policies] = exec(
      "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='telegraph_report_evidence';",
    );
    assert.equal(policies, "0");

    const fks = exec(
      "SELECT confrelid::regclass::text FROM pg_constraint " +
      "WHERE conrelid='public.telegraph_report_evidence'::regclass AND contype='f';",
    );
    assert.deepEqual(fks, ["reports"], "the only foreign key must be to reports");
  });

  it("the flag lands FALSE", () => {
    const [enabled] = exec(
      "SELECT enabled FROM public.feature_flags WHERE flag='telegraph_report_evidence_enabled';",
    );
    // 'f', not 'false': psql -At prints a bare boolean column as t/f. The RLS
    // assertion above compares 'true/true' because `||` casts boolean to text
    // first. Both spellings were MEASURED — the first draft had them swapped
    // and each one went red in turn.
    assert.equal(enabled, "f");
  });
});

/* ──────────────────────── the service, against doubles ─────────────────────── */

const REPORT_ID = "cc000000-0000-4000-8000-00000000f001";
const MESSAGE_ID = "cc000000-0000-4000-8000-00000000f002";
const THREAD_ID = "cc000000-0000-4000-8000-00000000f003";
const AUTHOR_ID = "cc000000-0000-4000-8000-00000000f004";

const silentLog = { warn() {}, error() {} };

/**
 * A double shaped like the reads this service makes, and NOTHING else — so a
 * table it should not touch is a thrown error rather than a quiet [].
 */
function client(opts: {
  flagOn?: boolean;
  flagError?: boolean;
  message?: Record<string, unknown> | null;
  messageError?: boolean;
  threadMessages?: Array<Record<string, unknown>>;
  threadError?: boolean;
  insertError?: { message: string; code?: string };
}) {
  const inserted: Array<{ table: string; row: any }> = [];
  const seen: string[] = [];

  function from(table: string) {
    seen.push(table);
    const target: any = {
      select() { return proxy; },
      eq() { return proxy; },
      is() { return proxy; },
      order() { return proxy; },
      limit() { return proxy; },
      insert(row: any) {
        inserted.push({ table, row });
        return {
          then(resolve: (v: any) => void) {
            return Promise.resolve(
              opts.insertError ? { data: null, error: opts.insertError } : { data: null, error: null },
            ).then(resolve);
          },
        };
      },
      maybeSingle() {
        if (table === "feature_flags") {
          if (opts.flagError) return Promise.resolve({ data: null, error: { message: "flags down" } });
          return Promise.resolve({ data: { enabled: opts.flagOn === true }, error: null });
        }
        if (table === "messages") {
          if (opts.messageError) return Promise.resolve({ data: null, error: { message: "db down", code: "57P01" } });
          return Promise.resolve({ data: opts.message ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: (v: any) => void) {
        if (table === "feature_flags") {
          if (opts.flagError) return Promise.resolve({ data: null, error: { message: "flags down" } }).then(resolve);
          return Promise.resolve({ data: [{ enabled: opts.flagOn === true }], error: null }).then(resolve);
        }
        if (table === "messages") {
          if (opts.threadError) return Promise.resolve({ data: null, error: { message: "db down", code: "57P01" } }).then(resolve);
          return Promise.resolve({ data: opts.threadMessages ?? [], error: null }).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return { from, _inserted: inserted, _tables: seen };
}

describe("captureMessageEvidence — what gets kept, and what gets recorded when nothing can be", () => {
  it("the flag OFF never names the evidence table at all", async () => {
    // A database without 2812 answers 42P01, not silence. The OFF path must be
    // byte-identical to the report path as it was before this migration.
    const c = client({ flagOn: false, message: { id: MESSAGE_ID, body: "hi" } });
    const r = await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.attempted, false);
    assert.equal(r.written, false);
    assert.equal(c._tables.includes("telegraph_report_evidence"), false);
    assert.equal(c._tables.includes("messages"), false, "the message must not be read either when nothing can store it");
  });

  it("an unreadable feature_flags behaves as OFF", async () => {
    // isFlagEnabled is false-on-error, and that polarity is the safe one here:
    // guessing ON against a database without the table logs a 42P01 per report.
    const c = client({ flagError: true, message: { id: MESSAGE_ID, body: "hi" } });
    const r = await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.attempted, false);
    assert.equal(c._tables.includes("telegraph_report_evidence"), false);
  });

  it("a live message is snapshotted with its body, author, thread and media", async () => {
    const c = client({
      flagOn: true,
      message: {
        id: MESSAGE_ID, thread_id: THREAD_ID, sender_id: AUTHOR_ID,
        body: "meet me and bring cash", media_url: "https://cdn/x.jpg",
        msg_type: "text", subtype: null, created_at: "2026-05-01T00:00:00.000Z", deleted_at: null,
      },
    });
    const r = await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.written, true);
    assert.equal(r.status, "captured");
    const row = c._inserted.find((i) => i.table === "telegraph_report_evidence")!.row;
    assert.equal(row.body_snapshot, "meet me and bring cash");
    assert.equal(row.author_id, AUTHOR_ID);
    assert.equal(row.thread_id, THREAD_ID);
    assert.equal(row.media_url_snapshot, "https://cdn/x.jpg");
    assert.equal(row.capture_status, "captured");
  });

  it("a body longer than the cap is truncated to exactly the cap", async () => {
    const long = "x".repeat(MAX_BODY_SNAPSHOT + 500);
    const c = client({
      flagOn: true,
      message: { id: MESSAGE_ID, thread_id: THREAD_ID, sender_id: AUTHOR_ID, body: long, deleted_at: null },
    });
    await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    const row = c._inserted[0]!.row;
    assert.equal(row.body_snapshot.length, MAX_BODY_SNAPSHOT,
      "an oversize body must be truncated here, not rejected by the CHECK at insert time");
  });

  it("a message deleted BEFORE the report is recorded as already_deleted, with no body", async () => {
    // The body has already been blanked in place, so there is nothing to keep.
    // The row still exists so a moderator can tell "we captured nothing" from
    // "nobody tried".
    const c = client({
      flagOn: true,
      message: {
        id: MESSAGE_ID, thread_id: THREAD_ID, sender_id: AUTHOR_ID, body: "",
        created_at: "2026-05-01T00:00:00.000Z", deleted_at: "2026-05-02T00:00:00.000Z",
      },
    });
    const r = await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.status, "already_deleted");
    assert.equal(r.written, true);
    const row = c._inserted[0]!.row;
    assert.equal(row.capture_status, "already_deleted");
    assert.equal(row.body_snapshot, undefined, "a blanked body must not be stored as if it were content");
    assert.equal(row.author_id, AUTHOR_ID, "who wrote it is still worth keeping");
  });

  it("a message that no longer exists is already_deleted too", async () => {
    const c = client({ flagOn: true, message: null });
    const r = await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.status, "already_deleted");
    assert.equal(r.written, true);
  });

  it("an unreadable messages table writes an 'unreadable' row rather than nothing", async () => {
    // supabase-js resolves on a DB error, so this is the same `data: null` a
    // deleted message gives. The two must not be recorded as the same fact.
    const c = client({ flagOn: true, messageError: true });
    const r = await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.status, "unreadable");
    assert.equal(r.written, true);
    assert.equal(c._inserted[0]!.row.capture_status, "unreadable");
  });

  it("a failed evidence write is reported as not written — never as success", async () => {
    const c = client({
      flagOn: true,
      message: { id: MESSAGE_ID, thread_id: THREAD_ID, sender_id: AUTHOR_ID, body: "x", deleted_at: null },
      insertError: { message: "permission denied", code: "42501" },
    });
    const r = await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.attempted, true);
    assert.equal(r.written, false);
  });

  it("a duplicate capture is success, not failure — one report retains one copy", async () => {
    const c = client({
      flagOn: true,
      message: { id: MESSAGE_ID, thread_id: THREAD_ID, sender_id: AUTHOR_ID, body: "x", deleted_at: null },
      insertError: { message: "duplicate key value", code: "23505" },
    });
    const r = await captureMessageEvidence(c as any, { reportId: REPORT_ID, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.written, true, "the evidence for this report is already there; a second copy is a second retention");
  });

  it("no report id means nothing to attach evidence to", async () => {
    const c = client({ flagOn: true, message: { id: MESSAGE_ID, body: "x" } });
    const r = await captureMessageEvidence(c as any, { reportId: null, messageId: MESSAGE_ID, log: silentLog });
    assert.equal(r.attempted, false);
    assert.equal(c._tables.length, 0, "not even the flag is read when there is nothing to attach to");
  });
});

describe("captureThreadEvidence — bounded context, never the whole conversation", () => {
  function msg(i: number) {
    return {
      id: `m${i}`, sender_id: AUTHOR_ID, body: `message ${i}`,
      msg_type: "text", subtype: null, created_at: `2026-05-0${(i % 9) + 1}T00:00:00.000Z`,
    };
  }

  it("keeps a window and says so, rather than keeping everything", async () => {
    const c = client({ flagOn: true, threadMessages: [msg(1), msg(2), msg(3)] });
    const r = await captureThreadEvidence(c as any, { reportId: REPORT_ID, threadId: THREAD_ID, log: silentLog });
    assert.equal(r.status, "captured");
    const row = c._inserted[0]!.row;
    assert.equal(row.target_type, "thread");
    assert.equal(row.context.limit, THREAD_CONTEXT_MESSAGES);
    assert.equal(row.context.messages.length, 3);
    assert.equal(row.context.messages[0].body, "message 1");
    assert.equal(row.body_snapshot, undefined, "a thread report names no single message");
  });

  it("the window is a stated number, small enough not to be an archive", () => {
    assert.ok(THREAD_CONTEXT_MESSAGES > 0 && THREAD_CONTEXT_MESSAGES <= 50);
  });

  it("an empty thread is already_deleted, not a silent empty capture", async () => {
    const c = client({ flagOn: true, threadMessages: [] });
    const r = await captureThreadEvidence(c as any, { reportId: REPORT_ID, threadId: THREAD_ID, log: silentLog });
    assert.equal(r.status, "already_deleted");
    assert.equal(r.written, true);
  });

  it("an unreadable thread window records the gap", async () => {
    const c = client({ flagOn: true, threadError: true });
    const r = await captureThreadEvidence(c as any, { reportId: REPORT_ID, threadId: THREAD_ID, log: silentLog });
    assert.equal(r.status, "unreadable");
    assert.equal(c._inserted[0]!.row.context, null, "an unreadable window must not be stored as an empty one");
  });

  it("the flag OFF never names the evidence table", async () => {
    const c = client({ flagOn: false, threadMessages: [msg(1)] });
    const r = await captureThreadEvidence(c as any, { reportId: REPORT_ID, threadId: THREAD_ID, log: silentLog });
    assert.equal(r.attempted, false);
    assert.equal(c._tables.includes("telegraph_report_evidence"), false);
  });
});

describe("reportEvidenceEnabled", () => {
  it("names the flag the migration seeds", () => {
    assert.equal(REPORT_EVIDENCE_FLAG, "telegraph_report_evidence_enabled");
    assert.match(sql, new RegExp(`'${REPORT_EVIDENCE_FLAG}'`));
  });

  it("is false when the flag row says false and false when the flags table is unreadable", async () => {
    assert.equal(await reportEvidenceEnabled(client({ flagOn: false }) as any), false);
    assert.equal(await reportEvidenceEnabled(client({ flagError: true }) as any), false);
  });
});
