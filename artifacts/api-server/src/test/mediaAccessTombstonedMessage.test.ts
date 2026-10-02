/**
 * mediaAccess §3c — a retracted message's photo must stop authorizing itself.
 *
 * ── THE DEFECT THIS FILE MEASURES ───────────────────────────────────────────
 * Deleting or unsending a message does not clear `media_url` /
 * `media_thumbnail_url`. The group-chat delete writes `{ deleted_at, body: '' }`
 * (`routes/groupChat.ts`) and the authoritative unsend RPC writes
 * `{ unsent_at, deleted_at, lifecycle_state, body }`
 * (`migrations/3000_telegraph_unsend_authoritative.sql`). Nothing in the tree
 * nulls those two columns, by design — the row is the only pointer the
 * orphan-media sweeps have to the storage object.
 *
 * `lib/mediaAccess.ts` branch §3c finds a message BY those columns. So the
 * tombstone went on matching, and §3c went on handing out a signed URL into the
 * PRIVATE `post-media` bucket for a picture its sender had retracted.
 *
 * What made it survive review: the TEXT reader already redacts. `routes/
 * messaging.ts` substitutes all four media fields on
 * `isDeleted = Boolean(m.deleted_at)`, so the picture does vanish from the
 * thread. Only the direct media door stayed open — and it is the door that
 * gives up bytes rather than a thumbnail URL, to exactly the person an unsend
 * is meant to take the picture back from: someone who was in the thread and
 * kept the object path.
 *
 * ── WHY A SEPARATE FILE ─────────────────────────────────────────────────────
 * `mediaAccessFailClosed.test.ts` measures the FAILURE paths with a fake that
 * can fail a named table; its fake models no `messages` source at all, and its
 * header says it deliberately does not reach into the shared helper to add one.
 * This is a different claim — not "an unreadable table must deny" but "a
 * readable tombstone must not be servable" — so it gets its own fake and its
 * own file rather than widening that one.
 *
 * The CONTROL below is what stops this suite from passing vacuously: the same
 * object, same sender, same viewer, same membership, with the message LIVE must
 * be ALLOWED. Without it, a §3c that denied everything would look correct here.
 *
 * ── SHOWN RED BEFORE GREEN ──────────────────────────────────────────────────
 * With the one-line `.is("deleted_at", null)` predicate deleted from
 * `lib/mediaAccess.ts` §3c, this file is **1 pass / 3 fail**: the CONTROL stays
 * green and all three refusals go red. With the predicate restored it is
 * **4 pass / 0 fail**. The 1/3 split is the measurement that matters — a suite
 * where the CONTROL had also gone red would mean the predicate was eating every
 * row rather than only the retracted ones. The file was restored afterwards and
 * compared byte-for-byte with `cmp`.
 *
 * Run: node --import tsx/esm --test src/test/mediaAccessTombstonedMessage.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { authorizeMediaAccess, _clearMediaAccessCache } from "../lib/mediaAccess.js";

const SENDER = "c1000000-0000-4000-a000-000000000001";
const VIEWER = "c1000000-0000-4000-a000-000000000002";
const THREAD = "c1000000-0000-4000-a000-0000000000a1";

/** The object lives under the SENDER's prefix, so §1 attributes it to them. */
const OBJ = `${SENDER}/retracted.jpg`;
const URL = `https://sb.example.test/storage/v1/object/public/post-media/${OBJ}`;

interface MsgRow {
  thread_id: string;
  sender_id: string;
  created_at: string;
  deleted_at: string | null;
  media_url: string | null;
  media_thumbnail_url: string | null;
}

/**
 * A PostgREST double for the §3c path only. Every table §3a/§3b/§3d-§3g read
 * answers empty so the object falls through to §3c, which is the branch under
 * test. `.or()` is a no-op here exactly as it is in the sibling fake: the
 * `media_url` match is the premise, and what this file measures is whether the
 * TOMBSTONE predicate excludes the row.
 */
function makeFake(messages: MsgRow[], signs: { n: number }) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitN = Infinity;
    const src = () =>
      table === "messages" ? messages :
      table === "message_thread_members"
        ? [{ thread_id: THREAD, user_id: VIEWER, status: "active", role: "member" }]
        : [];
    const rows = () => src().filter((r: any) => filters.every((f) => f(r))).slice(0, limitN);
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return b; },
      is: (c: string, v: any) => {
        filters.push((r) => (v === null ? r[c] == null : r[c] === v));
        return b;
      },
      not: () => b,
      order: () => b,
      or: () => b,
      overlaps: () => b,
      limit: (n: number) => { limitN = n; return b; },
      // `feature_flags` has no row, so historyBoundEnabled is false and
      // membership alone decides — which keeps this file about the tombstone.
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (onF: any, onR: any) =>
        Promise.resolve({ data: rows(), error: null }).then(onF, onR),
    };
    return b;
  }
  return {
    from,
    storage: {
      from: () => ({
        createSignedUrl: async (p: string, ttl: number) => {
          signs.n++;
          return { data: { signedUrl: `signed:${p}:${ttl}` }, error: null };
        },
      }),
    },
  } as any;
}

function liveRow(): MsgRow {
  return {
    thread_id: THREAD,
    sender_id: SENDER,
    created_at: "2026-09-01T12:00:00Z",
    deleted_at: null,
    media_url: URL,
    media_thumbnail_url: null,
  };
}

describe("mediaAccess §3c — tombstoned message media", () => {
  beforeEach(() => { _clearMediaAccessCache(); });

  it("CONTROL: a LIVE message's media is served to a thread member", async () => {
    const signs = { n: 0 };
    const sc = makeFake([liveRow()], signs);
    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ),
      true,
      "if this is false the object never reaches §3c and the two tests below prove nothing",
    );
  });

  it("a DELETED message's media is refused", async () => {
    const signs = { n: 0 };
    const row = { ...liveRow(), deleted_at: "2026-09-02T09:00:00Z" };
    const sc = makeFake([row], signs);
    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ),
      false,
      "the row still carries media_url; the tombstone is the only thing that can refuse it",
    );
    assert.equal(signs.n, 0, "a refused object must not have been signed on the way to being refused");
  });

  it("an UNSENT message's media is refused — the shape migration 3000 writes", async () => {
    const signs = { n: 0 };
    // 3000 sets unsent_at AND deleted_at. Only deleted_at is filtered on, and
    // that is deliberate: it is in the baseline dump, so it is safe to name on a
    // database that has not run 2325/2810/3000 — none of which is in production.
    const row = {
      ...liveRow(),
      deleted_at: "2026-09-02T09:00:00Z",
      unsent_at: "2026-09-02T09:00:00Z",
      lifecycle_state: "unsent",
    } as unknown as MsgRow;
    const sc = makeFake([row], signs);
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
    assert.equal(signs.n, 0);
  });

  it("the thumbnail column is the same door, and is refused too", async () => {
    const signs = { n: 0 };
    const row = {
      ...liveRow(),
      media_url: null,
      media_thumbnail_url: URL,
      deleted_at: "2026-09-02T09:00:00Z",
    };
    const sc = makeFake([row], signs);
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
  });
});
