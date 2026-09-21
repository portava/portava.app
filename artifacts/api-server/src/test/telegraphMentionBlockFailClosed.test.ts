/**
 * Census T344 / T363, the ERROR-INERT half — an unreadable `blocks` table let a
 * blocked user be @-mentioned in Telegraph's AI recommendations.
 *
 * `check:unchecked-supabase-reads` reports 0 FAIL-OPEN, and that number is true
 * of what it measures. Its own header says what it does not measure:
 *
 *   > "A read can bind its error, read it, and still produce the permissive
 *   >  result. … Call this shape ERROR-INERT: the error branch yields the same
 *   >  value the empty read would."
 *
 * `routes/telegraph.ts` held exactly that shape on `blocks`, which is an
 * EXCLUSION TABLE — a row there means DENY, so an empty read means ALLOW and a
 * dropped or inert error is fail-open by construction. The read bound
 * `blockErr`, logged a warning, and then carried on with an empty `blockedSet`.
 * Its own comment stated the consequence rather than preventing it:
 *
 *   > "Both leave blockedSet empty and both let blocked users through."
 *
 * So on an unreadable `blocks`, `POST /api/telegraph/recommend` emitted a
 * resolved `tagSpans` entry — a user id, a handle and a character range the
 * client renders as a live mention — for a person the caller may have blocked,
 * or who may have blocked the caller. A log line is not a guard.
 *
 * The fix is the direction this repository already uses for exclusion tables:
 * an unreadable block list must SUPPRESS, never admit. On a `blocks` read error
 * no mention span is emitted at all. Hashtag spans are untouched, because they
 * do not depend on the block set — a blanket "return nothing" would be a
 * different (and lazier) answer, and CASE 3 below is what holds it to that.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. It does not move T344 or T363; both are
 * already `C` and by §20.6's rule this site never counted against them (it is
 * not a plausible empty state presented as truth — it is a permissive one). It
 * closes a fail-open that no row in this census had named.
 *
 * A HARNESS LIMIT, STATED SO NO CASE HERE IS TRUSTED FOR THE WRONG REASON.
 * `telegraphCertificationHarness`'s `.or()` parser understands `eq`, `neq` and
 * `is`, not `in`, so a filter built as `blocked_id.in.(…)` matches NOTHING in
 * the fake even when a matching row is seeded. A "healthy tree, genuinely
 * blocked user, no span" case would therefore pass in this harness whether or
 * not the block guard works, which is the green-for-an-unrelated-reason failure
 * this repository has already paid for once. It is deliberately NOT written.
 * CASE 4 proves the suppression path with `tag_permission: 'nobody'`, which the
 * fake evaluates in full.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphMentionBlockFailClosed.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import telegraphRouter from "../routes/telegraph.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ALICE = "71000000-0000-4000-8000-000000000001";
const MALLORY = "71000000-0000-4000-8000-000000000002";

const BLOCKS_DOWN = { message: "permission denied for relation blocks", code: "42501" };

/** The one recommendation the stub model returns: one #hashtag, one @handle. */
const REASON = "Great with #sunset crowds — ask @mallory about it";

function stubModel() {
  return {
    chat: {
      completions: {
        async create() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      id: "rec_1",
                      title: "Sunset viewpoint",
                      category: "activity",
                      reason: REASON,
                      locationContext: "1 km away",
                      estimatedTime: "1 hour",
                      priceLevel: "free",
                      imageUrl: null,
                    },
                  ]),
                },
              },
            ],
          };
        },
      },
    },
  } as any;
}

function seed(over: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    user_follows: [],
    user_hashtag_follows: [],
    hashtags: [{ id: "h-sunset", slug: "sunset", is_blocked: false }],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", account_status: null, tag_permission: "anyone" },
      { id: MALLORY, handle: "mallory", name: "Mallory", account_status: null, tag_permission: "anyone" },
    ],
    ...over,
  };
}

type Spans = { tagSpans?: any[]; hashtagSpans?: any[] };

function firstRec(body: any): Spans {
  assert.ok(Array.isArray(body?.recommendations), "expected a recommendations array");
  assert.equal(body.recommendations.length, 1, "expected exactly one recommendation");
  return body.recommendations[0] as Spans;
}

describe("POST /telegraph/recommend — an unreadable block list must not admit a mention", () => {
  let h: RouterHarness;

  before(async () => {
    h = await startRouter(telegraphRouter);
  });
  after(async () => {
    await h.close();
    _setTestOpenAI(null);
  });
  beforeEach(() => {
    resetFakeIds();
    _setTestOpenAI(stubModel());
  });
  afterEach(() => {
    _setTestOpenAI(null);
  });

  // ── CASE 1 — the defect ────────────────────────────────────────────────────
  it("OUTAGE: an unreadable `blocks` emits NO mention span", async () => {
    _setTestClient(makeFakeClient(seed(), { errors: { blocks: BLOCKS_DOWN } }), true);
    const r = await call(h.base, "POST", "/telegraph/recommend", ALICE, { count: 1 });
    assert.equal(r.status, 200);
    const rec = firstRec(r.body);
    assert.equal(
      rec.tagSpans,
      undefined,
      "a mention resolved against a block list that could not be read is a claim the server cannot make",
    );
  });

  // ── CASE 2 — the control that makes CASE 1 mean something ──────────────────
  it("CONTROL: a healthy tree with no block DOES emit the mention span", async () => {
    _setTestClient(makeFakeClient(seed()), true);
    const r = await call(h.base, "POST", "/telegraph/recommend", ALICE, { count: 1 });
    assert.equal(r.status, 200);
    const rec = firstRec(r.body);
    assert.ok(Array.isArray(rec.tagSpans) && rec.tagSpans.length === 1, "expected one mention span");
    assert.equal(rec.tagSpans![0].id, MALLORY);
    assert.equal(rec.tagSpans![0].matchToken, "mallory");
  });

  // ── CASE 3 — the refusal is scoped, not a blanket empty ────────────────────
  it("CONTROL: the block outage suppresses mentions ONLY — hashtag spans survive", async () => {
    _setTestClient(makeFakeClient(seed(), { errors: { blocks: BLOCKS_DOWN } }), true);
    const r = await call(h.base, "POST", "/telegraph/recommend", ALICE, { count: 1 });
    assert.equal(r.status, 200);
    const rec = firstRec(r.body);
    assert.ok(
      Array.isArray(rec.hashtagSpans) && rec.hashtagSpans.length === 1,
      "hashtags do not depend on the block set; suppressing them too would be a different answer",
    );
    assert.equal(rec.hashtagSpans![0].slug, "sunset");
  });

  // ── CASE 4 — the suppression path itself, on a healthy tree ────────────────
  it("CONTROL: tag_permission 'nobody' suppresses the mention with blocks readable", async () => {
    _setTestClient(
      makeFakeClient(
        seed({
          profiles: [
            { id: ALICE, handle: "alice", name: "Alice", account_status: null, tag_permission: "anyone" },
            { id: MALLORY, handle: "mallory", name: "Mallory", account_status: null, tag_permission: "nobody" },
          ],
        }),
      ),
      true,
    );
    const r = await call(h.base, "POST", "/telegraph/recommend", ALICE, { count: 1 });
    assert.equal(r.status, 200);
    const rec = firstRec(r.body);
    assert.equal(rec.tagSpans, undefined, "an opted-out user must never appear as a mention");
  });
});
