/**
 * VERIFICATION LANE V1 — privacy / authorization.
 *
 * `POST /api/threads/:threadId/voice` may not attach an object belonging to
 * somebody else, and it may not be reached without a token.
 *
 * ── THE DEFECT, AS MEASURED ────────────────────────────────────────────────
 *
 * `routes/telegraphVoice.ts` validated `payload.url` with `appStorageUrlInfo()`
 * only. That function answers "is this one of OUR buckets", never "is this
 * YOUR object" — `lib/intelEvidenceCapture.ts` states it in those words:
 * "appStorageUrlInfo says whose HOST, never whose OBJECT."
 *
 * `post-media` is a PRIVATE bucket (measured on portava-ci 2026-09-16:
 * `SELECT id, public FROM storage.buckets` → post-media = false), and
 * `lib/mediaAccess.ts` branch 3c authorises message media purely by "some
 * message references this object AND the viewer is a member of that message's
 * thread" — it never asks whether the SENDER owned the object. Branches 3b
 * (posts), 3d (stories) and 3e (highlights) were each hardened against exactly
 * that composition; 3c was not.
 *
 * So a voice message pointing at a victim's key is a read primitive, not just a
 * mislabelled bubble. The sibling surface the Highlights & Memories lane
 * shipped closes its half of this: `POST /memories/:id/items` refuses
 * `foreign_storage` through `services/memory/memoryMediaOrigin.ts`. The voice
 * send path did not.
 *
 * ── RED EVIDENCE, BEFORE THE FIX ───────────────────────────────────────────
 *
 * Recorded against `routes/telegraphVoice.ts` at commit f224ae67e, unmodified:
 *
 *   $ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *       node --import tsx/esm --test src/test/verifyAuthzVoiceMediaOwnership.test.ts
 *   # fail 3
 *   not ok - REFUSES a voice note whose storage path belongs to ANOTHER user
 *     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *     201 !== 400
 *   not ok - REFUSES the absolute-URL spelling of another user's object too
 *     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *     201 !== 400
 *   not ok - the refusal names no other user's id
 *     (the 201 body echoes the payload, so it contains BOB's id)
 *
 * The rest of the file passed red — it is the regression net around the fix (an
 * own-storage note in both URL spellings, and the unattributable path that must
 * NOT be refused), plus the anonymous-caller gate that the existing
 * `telegraphVoice.test.ts` does not cover.
 *
 * Run: node --import tsx/esm --test src/test/verifyAuthzVoiceMediaOwnership.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphVoiceRouter from "../routes/telegraphVoice.js";
import { classifyMemoryMediaUrl } from "../services/memory/memoryMediaOrigin.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "dddddddd-0000-4000-8000-00000000000d";

const SB = "http://sb.example.test";
const OLD_SUPABASE_URL = process.env.SUPABASE_URL;

/** The bare key `POST /api/telegraph/voice/upload` actually mints for a user. */
const voiceKey = (uid: string) => `post-media/${uid}/voice/1700000000000.m4a`;
/** The same object in the absolute public-URL spelling rows predating 2081 hold. */
const voiceUrl = (uid: string) =>
  `${SB}/storage/v1/object/public/post-media/${uid}/voice/1700000000000.m4a`;
/** One of our objects whose path names no owner — must NOT be refused. */
const UNATTRIBUTABLE = "post-media/generated-visuals/event/hero.m4a";

function payload(url: string) {
  return {
    url,
    durationSeconds: 12,
    waveform: [0.1, 0.5, 0.9, 0.3],
    mimeType: "audio/mp4",
    sizeBytes: 98_304,
  };
}

// ── the fake, shaped like PostgREST ──────────────────────────────────────────

function makeClient() {
  const db: Record<string, any[]> = {
    feature_flags: [{ flag: "disable_messaging", enabled: false }],
    message_threads: [{ id: THREAD, is_e2ee: false }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null },
    ],
    blocks: [],
    messages: [],
  };
  const inserted: any[] = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const target: any = {
      select() { return proxy; },
      insert(row: any) {
        pendingInsert = { id: "new-voice-1", ...row };
        inserted.push({ table, row: pendingInsert });
        (db[table] ??= []).push(pendingInsert);
        return proxy;
      },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      or() { return proxy; },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.map(String).includes(String(r[col])));
        return proxy;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return proxy;
      },
      limit() { return proxy; },
      order() { return proxy; },
      maybeSingle() { return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null }); },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        if (pendingUpdate) {
          const applied = rowsNow();
          for (const r of applied) Object.assign(r, pendingUpdate);
          return Promise.resolve({ data: applied, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: pendingInsert ? [pendingInsert] : rowsNow(), error: null })
          .then(resolve, reject);
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

  return {
    _db: db,
    _inserted: inserted,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    // Any bearer token IS a user id here, which is what makes the no-token case
    // below a real test of `requireUser` rather than of the fake.
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

async function sendVoice(body: unknown, asUser: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (asUser) headers.authorization = `Bearer ${asUser}`;
  const r = await fetch(`${base}/threads/${THREAD}/voice`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  process.env.SUPABASE_URL = SB;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", telegraphVoiceRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  process.env.SUPABASE_URL = OLD_SUPABASE_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The anonymous caller
// ═══════════════════════════════════════════════════════════════════════════

describe("what stops an ANONYMOUS caller", () => {
  it("REFUSES a voice send with no bearer token, and writes nothing", async () => {
    const c = makeClient();
    _setTestClient(c, true);
    const { status } = await sendVoice({ payload: payload(voiceKey(ALICE)) }, null);
    assert.equal(status, 401, "an unauthenticated send must not reach the thread guard");
    assert.equal(c._inserted.length, 0, "nothing may be written for an unauthenticated caller");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The participant who should not be able to do THIS — attach someone
//    else's object. Membership is not in question in these cases: ALICE is an
//    active member of THREAD throughout.
// ═══════════════════════════════════════════════════════════════════════════

describe("a member may attach their OWN object and no one else's", () => {
  it("ACCEPTS the bare key the upload endpoint mints for this caller", async () => {
    // The legitimate shape. If this ever fails, the guard has become stricter
    // than the upload endpoint and voice notes are broken for everyone — which
    // is worse than the leak, because it reaches every user rather than one
    // whose object key is known.
    const c = makeClient();
    _setTestClient(c, true);
    const { status, body } = await sendVoice({ payload: payload(voiceKey(ALICE)) }, ALICE);
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(c._inserted.length, 1);
  });

  it("ACCEPTS the absolute public-URL spelling of that same object", async () => {
    // Two spellings, one object. A guard that read only the bare key would be
    // bypassed by sending the URL form, so both must reach the same verdict.
    const c = makeClient();
    _setTestClient(c, true);
    const { status, body } = await sendVoice({ payload: payload(voiceUrl(ALICE)) }, ALICE);
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(c._inserted.length, 1);
  });

  it("REFUSES a voice note whose storage path belongs to ANOTHER user", async () => {
    // RED at f224ae67e: 201. `appStorageUrlInfo` accepted it because the bucket
    // is ours; nothing asked whose object it is.
    const c = makeClient();
    _setTestClient(c, true);
    const { status, body } = await sendVoice({ payload: payload(voiceKey(BOB)) }, ALICE);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(
      c._inserted.length,
      0,
      "a refused voice note must leave no row — a row is what lib/mediaAccess.ts branch 3c reads",
    );
  });

  it("REFUSES the absolute-URL spelling of another user's object too", async () => {
    const c = makeClient();
    _setTestClient(c, true);
    const { status } = await sendVoice({ payload: payload(voiceUrl(BOB)) }, ALICE);
    assert.equal(status, 400);
    assert.equal(c._inserted.length, 0);
  });

  it("does NOT refuse one of our objects whose path names no owner", async () => {
    // `unattributable_storage`. Refusing on an inability to attribute turns a
    // naming convention into an outage — the reasoning
    // services/memory/memoryMediaOrigin.ts records, applied consistently here.
    const c = makeClient();
    _setTestClient(c, true);
    const { status, body } = await sendVoice({ payload: payload(UNATTRIBUTABLE) }, ALICE);
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(c._inserted.length, 1);
  });

  it("the refusal names no other user's id", async () => {
    // A refusal that echoed BOB's uuid would turn the guard into the oracle it
    // exists to remove.
    const c = makeClient();
    _setTestClient(c, true);
    const { body } = await sendVoice({ payload: payload(voiceKey(BOB)) }, ALICE);
    assert.ok(!JSON.stringify(body).includes(BOB), JSON.stringify(body));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The classifier this route now shares with the memories surface, on the
//    voice path shape specifically. `memoryMediaOrigin` was written for
//    `<uid>/<file>` and `memories/<uid>/<file>`; a voice key is
//    `<uid>/voice/<ts>.m4a`, so the segment rule has to hold for a
//    three-segment path as well.
// ═══════════════════════════════════════════════════════════════════════════

describe("the shared classifier reads the voice path convention correctly", () => {
  it("attributes `<uid>/voice/<ts>.m4a` to that uid", () => {
    assert.equal(classifyMemoryMediaUrl(voiceKey(ALICE), ALICE).verdict, "own_storage");
  });

  it("calls the same path foreign for a different caller", () => {
    assert.equal(classifyMemoryMediaUrl(voiceKey(BOB), ALICE).verdict, "foreign_storage");
  });

  it("a victim id in the FILENAME attributes nothing — segments, not substrings", () => {
    const v = classifyMemoryMediaUrl(`post-media/${ALICE}/voice/${BOB}.m4a`, ALICE);
    assert.equal(v.verdict, "own_storage", "the owner segment is the first one, not any occurrence");
  });
});
