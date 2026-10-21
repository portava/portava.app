/**
 * inputAssistanceTelemetryLive — a §44 event emitted through the APP's installed
 * sink lands in `input_assistance_telemetry_events` on real PostgreSQL, and is
 * read back (census-input-intelligence G306's first TURNS-GREEN clause; §40.2b
 * ledgers it as CI live-DB-tier code, not environment).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/inputAssistanceTelemetryLive.db.test.ts
 *      Skips without a database, like every src/test/db suite; scripts/local-db/run-tests.sh
 *      is the run that refuses a skip. It cannot run where there is no PostGIS harness.
 *
 * THE WHOLE PATH, NOTHING STUBBED BUT THE TWO ENDS THAT CANNOT RUN HERE:
 *
 *   device   the app's own `emitSuggestionsRendered` / `emitInputEvent`
 *            → the app's own `installInputTelemetry` (the sink `app/_layout.tsx`
 *              installs at boot, with its per-name outcome gate)
 *            → the app's own `createTelemetryBatcher` (six fields copied by name)
 *            → a poster that makes exactly the request `telemetryTransport.ts`
 *              makes (that module imports the Supabase token helper and cannot be
 *              imported under node; its body is mirrored here line for line: POST
 *              `${base}/api/input-assistance/telemetry`, bearer token, the batch
 *              as JSON, `ok` = res.ok)
 *   server   the REAL `routes/inputAssistance.ts` router on express, the REAL
 *            `requireUser`, the REAL rebuild and policy gate
 *            → `recordTelemetryEvents` over `creatorLedgerPsqlClient` (the
 *              harness has no PostgREST; the adapter issues the one INSERT
 *              PostgREST would, as `service_role`)
 *   database migration 2950's table, its CHECKs and its no-account-id rule.
 *
 *   TL-1  an impression emitted through the installed sink is stored with its
 *         context, field, request id, policy version and only its allow-listed
 *         props — and read back by this suite.
 *   TL-2  the impression and the selection that followed it share the serve's
 *         request id in the stored rows: the §44 action/result join (G355).
 *   TL-3  raw text handed to the emitter never reaches the row.
 *   TL-4  the row carries no account id, under any column.
 *   TL-5  an event emitted before install, or after dispose, stores nothing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, rows, scalar, seedUser, deleteUser } from "./localDb.js";
import { creatorPsqlClient } from "./creatorLedgerPsqlClient.js";
import { _setTestClient } from "../../lib/http.js";
import { _resetRateLimit } from "../../lib/rateLimit.js";
import inputAssistanceRouter from "../../routes/inputAssistance.js";
import { installInputTelemetry, type InputTelemetryHandle } from "../../../../../travel-buddy-standalone/src/platform/input-assistance/services/installInputTelemetry.ts";
import { createTelemetryBatcher, type TelemetryBatch } from "../../../../../travel-buddy-standalone/src/platform/input-assistance/services/telemetryBatcher.ts";
import { emitInputEvent, emitSuggestionsRendered } from "../../../../../travel-buddy-standalone/src/platform/input-assistance/services/inputTelemetry.ts";
import type { InputSuggestion } from "../../../../../travel-buddy-standalone/src/platform/input-assistance/types/inputSuggestion.ts";

const TABLE = "public.input_assistance_telemetry_events";
const TOKEN = "tok-g306";
const SESSION = `g306-${randomUUID().slice(0, 8)}`;
const REQUEST = `req-g306-${randomUUID().slice(0, 8)}`;
const FIELD = { fieldId: "global_search", context: "global_search" as const, requestId: REQUEST };

let USER = "";
let server: http.Server | null = null;
let base = "";
let handle: InputTelemetryHandle | null = null;

/** `telemetryTransport.ts`'s post, against this server, with this suite's token. */
async function post(batch: TelemetryBatch): Promise<{ ok: boolean; retryable?: boolean }> {
  const res = await fetch(`${base}/api/input-assistance/telemetry`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(batch),
  });
  return { ok: res.ok, retryable: res.status === 503 };
}

function suggestion(id: string, type: InputSuggestion["type"]): InputSuggestion {
  return { id, type, context: "global_search", label: `Label ${id}`, source: "canonical", policyVersion: "g306" };
}

interface StoredRow {
  session_id: string;
  request_id: string | null;
  event_name: string;
  context: string;
  field_id: string;
  policy_version: string;
  props: Record<string, unknown>;
}

function stored(where = ""): StoredRow[] {
  return rows<StoredRow>(
    `SELECT session_id, request_id, event_name, context, field_id, policy_version, props FROM ${TABLE} ` +
    `WHERE session_id = '${SESSION}' ${where} ORDER BY id`,
  );
}

describe("G306: a §44 event through the installed sink lands in the serve log", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  before(async () => {
    USER = seedUser("g306tel");
    _setTestClient(creatorPsqlClient({ tokens: { [TOKEN]: USER } }), true);
    _resetRateLimit();
    const app = express();
    app.use(express.json());
    app.use("/api", inputAssistanceRouter);
    await new Promise<void>((res) => { server = app.listen(0, "127.0.0.1", () => res()); });
    const addr = server!.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    handle?.dispose();
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    if (!USER) return;
    exec(`DELETE FROM ${TABLE} WHERE session_id = '${SESSION}';`);
    deleteUser(USER);
  });

  it("TL-5a — an event emitted BEFORE install reaches nothing", async () => {
    emitSuggestionsRendered({ ...FIELD, requestId: `${REQUEST}-pre` }, [suggestion("p", "entity")]);
    assert.equal(scalar(`SELECT count(*) FROM ${TABLE} WHERE request_id = '${REQUEST}-pre'`), "0");
  });

  it("TL-1 — an impression through the installed sink is stored, and read back", async () => {
    handle = installInputTelemetry({
      // The flush is driven by the test, not by the batcher's 5 s timer.
      createBatcher: () => createTelemetryBatcher({ post, sessionId: SESSION, schedule: () => {} }),
    });
    emitSuggestionsRendered(FIELD, [suggestion("a", "entity"), suggestion("b", "recent"), suggestion("c", "entity")]);
    assert.equal(handle.batcher.pending(), 1, "the installed sink buffered the event");
    await handle.batcher.flush();
    assert.equal(handle.batcher.dropped(), 0, "the ingest accepted the batch (a 503 would be dropped and counted)");
    const got = stored(`AND event_name = 'suggestion_rendered'`);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.request_id, REQUEST);
    assert.equal(got[0]!.context, "global_search");
    assert.equal(got[0]!.field_id, "global_search");
    assert.ok(got[0]!.policy_version.length > 0);
    assert.deepEqual(got[0]!.props, { count: 3, types: "entity,recent" });
  });

  it("TL-2 — the selection that followed shares the serve's request id: the §44 join holds in the stored rows", async () => {
    emitInputEvent("suggestion_selected", FIELD.fieldId, FIELD.context, { suggestionType: "entity", source: "canonical" }, undefined, REQUEST);
    await handle!.batcher.flush();
    const joined = rows<{ event_name: string }>(
      `SELECT event_name FROM ${TABLE} WHERE session_id = '${SESSION}' AND request_id = '${REQUEST}' ORDER BY id`,
    ).map((r) => r.event_name);
    assert.deepEqual(joined, ["suggestion_rendered", "suggestion_selected"]);
  });

  it("TL-3 — raw text handed to the emitter never reaches the row", async () => {
    emitInputEvent("query_length_changed", FIELD.fieldId, FIELD.context, { length: 10, text: "secret bar", query: "secret bar" }, undefined, `${REQUEST}-len`);
    await handle!.batcher.flush();
    const got = stored(`AND request_id = '${REQUEST}-len'`);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0]!.props, { length: 10 });
    assert.equal(scalar(`SELECT count(*) FROM ${TABLE} t WHERE session_id = '${SESSION}' AND row_to_json(t)::text LIKE '%secret%'`), "0");
  });

  it("TL-4 — the serve log carries no account id, under any column", () => {
    assert.equal(scalar(
      `SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' ` +
      `AND table_name = 'input_assistance_telemetry_events' AND column_name IN ('user_id', 'viewer_id', 'actor_id', 'profile_id', 'author_id')`,
    ), "0");
    assert.ok(stored().length >= 3);
    assert.equal(scalar(`SELECT count(*) FROM ${TABLE} t WHERE session_id = '${SESSION}' AND row_to_json(t)::text LIKE '%${USER}%'`), "0");
  });

  it("TL-5b — after dispose the sink is the no-op again: nothing more is stored", async () => {
    handle!.dispose();
    handle = null;
    emitSuggestionsRendered({ ...FIELD, requestId: `${REQUEST}-post` }, [suggestion("z", "entity")]);
    assert.equal(scalar(`SELECT count(*) FROM ${TABLE} WHERE request_id = '${REQUEST}-post'`), "0");
  });
});
