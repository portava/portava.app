/**
 * highlightsPermanentOwnerFirst.db.test.ts — the EXECUTING witness for
 * 3502_highlights_permanent_visibility_owner_first.sql.
 *
 * ── WHY A DATABASE TEST AND NOT A QUAL-STRING TEST ──────────────────────────
 * `src/test/highlightsOwnerFirstSelectShape.test.ts` is the DB-free half: it
 * proves the migration's text transformation is the right one. It cannot prove
 * that PostgreSQL hands the row over, and that is the claim that matters. A
 * qual that reads correctly is not evidence of visibility — this repository has
 * shipped an assertion-about-the-call before (CONTRIBUTING.md, "verify the
 * resulting STATE, not the return value"), and a policy predicate is exactly
 * that shape of hazard: `NULL > now()` is a perfectly well-formed expression
 * that refuses every row.
 *
 * So every assertion below is a real `SELECT` issued as `authenticated` or
 * `anon`, with `request.jwt.claim.sub` set the way PostgREST sets it, against
 * rows that are really in `public.highlights`, under the real policies the
 * harness chain produced.
 *
 * ── THE HARNESS IS PRODUCTION'S STRUCTURE, NOT A MODEL OF IT ────────────────
 * `scripts/local-db/up.sh` restores `baseline/20260819_baseline_structure.sql`
 * — production's own structure — and replays the canonical chain. Verified
 * 2026-10-02: the two `highlights` SELECT quals the replay produces are
 * CHARACTER-FOR-CHARACTER identical to the quals read off production
 * (`ajrurzioarfkagpuxfnb`) the same day, 532 and 448 characters. That is what
 * makes a result here evidence about production rather than about a fixture.
 *
 * ── THE DEFECT, AS THIS SUITE SEES IT ──────────────────────────────────────
 * The harness chain applies `2975` (which makes `expires_at` nullable) in
 * lexicographic order, so a PERMANENT Highlight is storable here. Before 3502,
 * both SELECT policies test `(expires_at > now())` as a TOP-LEVEL AND conjunct
 * ahead of the owner disjunct, and `NULL > now()` is NULL, which a PERMISSIVE
 * policy reads as a refusal. The row is then visible to NOBODY.
 *
 * ── RED BEFORE GREEN, by the harness's own documented mechanism ─────────────
 * `up.sh`'s `LOCAL_DB_TO` is an exclusive upper bound, "for before/after proofs
 * of one migration". Measured 2026-10-02:
 *
 *   LOCAL_DB_TO=3502  (chain stops BEFORE this migration)   6 pass,  5 FAIL
 *   full chain                                             11 pass,  0 fail
 *
 * The five failures are H1a, H1b, H2a, H3a and H3b: the owner cannot see their
 * own PERMANENT Highlight, the owner cannot see their own expired one, a
 * non-owner cannot see a public PERMANENT one, and neither policy's qual
 * satisfies the owner-first shape.
 *
 *   H1  the owner reaches their own row with no expiry test having a say
 *   H2  a non-owner reaches a PUBLIC PERMANENT row, and still cannot reach an
 *       expired one — the expiry test MOVED, it was not deleted
 *   H3  the stored quals are owner-first, have no top-level expiry conjunct,
 *       give the remaining expiry test a NULL arm, and route trip_only through
 *       authz.shares_accepted_trip rather than a trip_members self-join
 *   H4  the blocked guard still bites, on both policies
 *   H5  `anon` — which only `highlights_select` (TO PUBLIC) can admit — sees the
 *       unexpired public row and not the expired one, which isolates that
 *       policy from `highlights_select_active`
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const TAG = `hof${randomUUID().slice(0, 8)}`;

/** The shape constants the migration writes. Stated here, not imported, so a
 *  change to either side has to be made in two places on purpose. */
const OWNER_FIRST = "((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR ";
const TOP_EXPIRY = ") AND (expires_at > now()) AND ";
const NULL_ARM = "((expires_at IS NULL) OR (expires_at > now()))";
const TRIP_BRANCH = "((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))";

let owner = "";
let viewer = "";
let blocker = "";
let expiresAtNullable = false;

const ids = {
  permPriv: randomUUID(),
  pastPriv: randomUUID(),
  permPub: randomUUID(),
  futPub: randomUUID(),
  pastPub: randomUUID(),
};

/** One real SELECT through RLS as a signed-in user; returns the row count. */
function visibleTo(userId: string, highlightId: string): number {
  const out = exec(
    [
      `SELECT set_config('request.jwt.claim.sub', '${userId}', true);`,
      `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
      `SET LOCAL ROLE authenticated;`,
      `SELECT count(*) FROM public.highlights WHERE id = '${highlightId}';`,
    ].join("\n"),
    { single: true },
  );
  return Number(out[out.length - 1]);
}

/** The same, as `anon`: only `highlights_select` (TO PUBLIC) can admit it. */
function visibleToAnon(highlightId: string): number {
  const out = exec(
    [
      `SELECT set_config('request.jwt.claim.sub', '', true);`,
      `SELECT set_config('request.jwt.claim.role', 'anon', true);`,
      `SET LOCAL ROLE anon;`,
      `SELECT count(*) FROM public.highlights WHERE id = '${highlightId}';`,
    ].join("\n"),
    { single: true },
  );
  return Number(out[out.length - 1]);
}

function insertHighlight(
  id: string,
  ownerId: string,
  visibility: string,
  expiresAt: string | null,
  lifetimeClass: string,
): void {
  exec(
    `INSERT INTO public.highlights (id, owner_id, media_url, media_type, visibility, expires_at, lifetime_class) ` +
      `VALUES ('${id}', '${ownerId}', 'https://example.invalid/${TAG}.jpg', 'image/jpeg', '${visibility}', ` +
      `${expiresAt === null ? "NULL" : `now() ${expiresAt}`}, '${lifetimeClass}');`,
  );
}

describe("3502 — a PERMANENT Highlight is reachable, owner first", { skip: !HAVE_DB }, () => {
  before(() => {
    expiresAtNullable =
      scalar(
        `SELECT (NOT a.attnotnull)::text FROM pg_attribute a WHERE a.attrelid = 'public.highlights'::regclass AND a.attname = 'expires_at' AND a.attnum > 0 AND NOT a.attisdropped`,
      ) === "true";

    owner = seedUser(`${TAG}own`);
    viewer = seedUser(`${TAG}vw`);
    blocker = seedUser(`${TAG}blk`);

    exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${blocker}', '${owner}');`);

    insertHighlight(ids.pastPriv, owner, "private", "- interval '2 hours'", "DAY");
    insertHighlight(ids.futPub, owner, "public", "+ interval '2 hours'", "DAY");
    insertHighlight(ids.pastPub, owner, "public", "- interval '2 hours'", "DAY");
    if (expiresAtNullable) {
      insertHighlight(ids.permPriv, owner, "private", null, "PERMANENT");
      insertHighlight(ids.permPub, owner, "public", null, "PERMANENT");
    }
  });

  after(() => {
    if (!HAVE_DB) return;
    exec(`DELETE FROM public.highlights WHERE owner_id = '${owner}';`);
    exec(`DELETE FROM public.blocks WHERE blocker_id = '${blocker}' OR blocked_id = '${owner}';`);
    for (const u of [owner, viewer, blocker]) if (u) deleteUser(u);
  });

  // ── H0 — the harness really is the database this suite claims it is ───────
  test("H0 the column that makes PERMANENT storable is nullable here", () => {
    // Not a skip condition dressed as a test: if `expires_at` were NOT NULL the
    // two PERMANENT rows below could not exist, and H1a/H2a would be vacuous.
    // The migration itself handles that database (its truth table covers the
    // NULL cases without a row); THIS suite requires the stronger harness and
    // says so rather than quietly testing less.
    assert.equal(
      expiresAtNullable,
      true,
      "public.highlights.expires_at is NOT NULL on this harness, so a PERMANENT Highlight cannot be inserted and the decisive cases of this suite would prove nothing. The harness chain applies 2975, which drops that NOT NULL — if it did not run, fix the harness rather than relaxing this assertion.",
    );
  });

  // ── H1 — the owner reaches their own row ──────────────────────────────────
  test("H1a the OWNER sees their own PERMANENT (NULL-expiry) Highlight", () => {
    assert.equal(
      visibleTo(owner, ids.permPriv),
      1,
      "the owner of a PERMANENT Highlight selected 0 rows. `NULL > now()` is NULL and a PERMISSIVE policy admits only TRUE, so with the expiry test ahead of the owner disjunct the row is visible to nobody at all — a write-only record.",
    );
  });

  test("H1b the OWNER sees their own EXPIRED Highlight", () => {
    assert.equal(
      visibleTo(owner, ids.pastPriv),
      1,
      "the owner's arm is still gated on expiry. This is the same defect as H1a with a value that is merely false instead of NULL, and it is insertable even while expires_at is NOT NULL.",
    );
  });

  // ── H2 — the expiry test moved; it was not deleted ────────────────────────
  test("H2a a NON-OWNER sees a PUBLIC PERMANENT Highlight", () => {
    assert.equal(visibleTo(viewer, ids.permPub), 1);
  });

  test("H2b a NON-OWNER sees an unexpired PUBLIC Highlight", () => {
    assert.equal(visibleTo(viewer, ids.futPub), 1, "the ordinary read path is broken");
  });

  test("H2c a NON-OWNER still does NOT see an EXPIRED PUBLIC Highlight", () => {
    assert.equal(
      visibleTo(viewer, ids.pastPub),
      0,
      "the expiry test has been LOST rather than moved. Without this case passing, 3502 would have turned a 24-hour surface into a permanent one, which is a worse defect than the one it fixes.",
    );
  });

  // ── H3 — the stored quals, read back from the catalog ─────────────────────
  for (const policy of ["highlights_select", "highlights_select_active"] as const) {
    test(`H3 ${policy} is owner-first with a NULL expiry arm and no top-level expiry conjunct`, () => {
      // rows(), not scalar(): a deparsed qual contains newlines and psql's
      // unaligned output would hand back only its first line, which every
      // assertion below would then pass against by accident.
      const got = rows<{ qual: string | null }>(
        `SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'highlights' AND policyname = '${policy}'`,
      );
      assert.equal(got.length, 1, `${policy} does not exist on public.highlights`);
      const qual = got[0]!.qual;
      assert.ok(qual, `${policy} has a NULL qual, which a SELECT policy cannot`);
      assert.ok(
        qual.startsWith(OWNER_FIRST),
        `${policy} does not evaluate the owner disjunct first. qual=${qual}`,
      );
      assert.ok(
        !qual.includes(TOP_EXPIRY),
        `${policy} still carries a top-level expiry conjunct. qual=${qual}`,
      );
      assert.ok(qual.includes(NULL_ARM), `${policy} has no NULL expiry arm. qual=${qual}`);
      assert.ok(
        !qual.includes("trip_members"),
        `${policy} reaches trip_members directly. 2530 removed that self-join because it admitted pending invitees and removed members; docs/architecture/blocker-ledger.md:22 marks the blocker CLOSED and warns that PR #461's 2313 restores it byte-for-byte. qual=${qual}`,
      );
    });
  }

  test("H3c exactly one SELECT policy carries the trip_only branch, as the helper call", () => {
    assert.equal(
      scalar(
        `SET search_path = public, pg_catalog; SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'highlights' AND cmd = 'SELECT' AND position($tb$${TRIP_BRANCH}$tb$ in coalesce(qual, '')) <> 0`,
      ),
      "1",
      "the trip_only branch is not present exactly once as the authz.shares_accepted_trip call. highlights_select has no trip_only arm (2033: 'No trip_id in live schema -> trip_only branch omitted'), so the answer is one, not two.",
    );
  });

  // ── H4 — the blocked guard moved into the non-owner arm INTACT ────────────
  test("H4 a BLOCKED viewer sees nothing, on either policy", () => {
    assert.equal(
      visibleTo(blocker, ids.futPub),
      0,
      "a blocked viewer reached an unexpired public Highlight. Both policies carry the guard in their non-owner arm; if either lost it, this count is 1.",
    );
    assert.equal(visibleTo(blocker, ids.permPub), 0, "a blocked viewer reached a PERMANENT Highlight");
  });

  // ── H5 — highlights_select (TO PUBLIC) in isolation ───────────────────────
  test("H5 anon sees the unexpired public row and not the expired one", () => {
    // Only highlights_select applies to anon, so these two counts are that
    // policy's own verdict rather than the union of the two.
    assert.equal(visibleToAnon(ids.futPub), 1, "highlights_select stopped admitting anon at all");
    assert.equal(visibleToAnon(ids.pastPub), 0, "highlights_select lost its expiry test");
  });
});
