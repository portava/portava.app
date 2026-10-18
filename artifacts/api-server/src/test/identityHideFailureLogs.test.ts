/**
 * Wave 5 follow-up B, item 3 — hides that failed SILENTLY.
 *
 * `nameVisibilitySet` (lib/publicIdentity.ts) and `readVerifiedBadges`
 * (services/identityVerification/verifiedBadges.ts) answer "hide" when their
 * read fails: an empty allow-set hides every real name, an empty map shows no
 * badge. That direction is right — it never widens what a viewer sees — and it
 * is NOT changed here; many callers depend on these answers byte for byte.
 *
 * What was wrong is that the failure left no trace: supabase-js RESOLVES a
 * failed read as `{ data: null, error }`, the helpers turned it into the same
 * value as "nobody opted in" / "nobody is verified", and nothing was logged. An
 * outage of profile_privacy_settings or identity_verifications therefore looked
 * exactly like a quiet day. Each failure path now logs at warn, and the answer
 * on that path is asserted unchanged alongside the log.
 *
 * FAIL cases were RED on the pre-fix tree (no log line); CONTROL cases pin the
 * healthy answers and that a healthy read logs nothing.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../lib/logger.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { readVerifiedBadges, _resetVerifiedBadgeFlagCache, IDENTITY_VERIFIED_BADGE_FLAG } from "../services/identityVerification/verifiedBadges.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";

const A = "aaaaaaaa-0000-4000-a000-000000000001";
const B = "bbbbbbbb-0000-4000-a000-000000000002";
const ERR = { message: "canceling statement due to statement timeout", code: "57014" };
const ENV = {} as NodeJS.ProcessEnv;

type Line = { obj: any; msg: string };
const warns: Line[] = [];
const origWarn = logger.warn;

/** A client whose read of `table` THROWS (a broken builder, a dropped connection surfacing as an exception). */
function throwingOn(base: any, table: string): any {
  const from = base.from.bind(base);
  base.from = (t: string) => { if (t === table) throw new Error(`boom reading ${t}`); return from(t); };
  return base;
}

describe("item 3 — a hide caused by a failed read is logged, and the answer is unchanged", () => {
  beforeEach(() => { warns.length = 0; (logger as any).warn = (obj: any, msg?: string) => { warns.push({ obj, msg: msg ?? "" }); }; _resetVerifiedBadgeFlagCache(); });
  afterEach(() => { (logger as any).warn = origWarn; });

  // ── nameVisibilitySet ──────────────────────────────────────────────────────
  const privacy = (failOn?: boolean) => makeFailClosedClient({
    rows: { profile_privacy_settings: [{ user_id: A, show_real_name: true }, { user_id: B, show_real_name: false }] },
    failOn: (c) => (failOn && c.table === "profile_privacy_settings" ? ERR : null),
  });
  it("NV0 CONTROL: a healthy read → the opted-in set, and nothing is logged", async () => {
    const s = await nameVisibilitySet(privacy(), [A, B]);
    assert.deepEqual([...s], [A]); assert.equal(warns.length, 0, JSON.stringify(warns));
  });
  it("NV1 the privacy read RESOLVES an error → still the empty set (every name hidden), and a warn names the table", async () => {
    const s = await nameVisibilitySet(privacy(true), [A, B]);
    assert.deepEqual([...s], [], "the answer on failure must stay the empty set");
    assert.equal(warns.length, 1, `the failed read left no trace: ${JSON.stringify(warns)}`);
    assert.match(`${warns[0].msg} ${JSON.stringify(warns[0].obj)}`, /profile_privacy_settings/);
    assert.ok(warns[0].obj?.err, "the database error is attached");
  });
  it("NV2 the privacy read THROWS → still the empty set, and a warn", async () => {
    const s = await nameVisibilitySet(throwingOn(privacy(), "profile_privacy_settings"), [A]);
    assert.deepEqual([...s], []); assert.equal(warns.length, 1, JSON.stringify(warns)); assert.ok(warns[0].obj?.err);
  });
  it("NV3 CONTROL: no ids → no read, no log (the early return is untouched)", async () => {
    const s = await nameVisibilitySet(privacy(true), [null, undefined, ""]);
    assert.deepEqual([...s], []); assert.equal(warns.length, 0);
  });

  // ── readVerifiedBadges ─────────────────────────────────────────────────────
  const badges = (failTable?: string) => makeFailClosedClient({
    rows: {
      feature_flags: [{ flag: IDENTITY_VERIFIED_BADGE_FLAG, enabled: true }],
      identity_verifications: [{ id: "a1", user_id: A, status: "verified", provider_mode: "live", provider: "stripe_identity", created_at: "2026-09-01T00:00:00Z" }],
      profiles: [{ id: A, verification_level: "id_verified" }, { id: B, verification_level: null }],
    },
    failOn: (c) => (failTable && c.table === failTable ? ERR : null),
  });
  it("VB0 CONTROL: a healthy read → A is badged, and nothing is logged", async () => {
    const m = await readVerifiedBadges(badges(), [A, B], ENV);
    assert.deepEqual(Object.fromEntries(m!), { [A]: { tier: "id" } }); assert.equal(warns.length, 0, JSON.stringify(warns));
  });
  for (const [name, table] of [["VB1", "identity_verifications"], ["VB2", "profiles"]] as const) {
    it(`${name} the ${table} read RESOLVES an error → still an empty map (no badge), and a warn names ${table}`, async () => {
      const m = await readVerifiedBadges(badges(table), [A, B], ENV);
      assert.ok(m instanceof Map); assert.equal(m!.size, 0, "the answer on failure must stay 'no badge'");
      assert.equal(warns.length, 1, `the failed read left no trace: ${JSON.stringify(warns)}`);
      assert.match(`${warns[0].msg} ${JSON.stringify(warns[0].obj)}`, new RegExp(table));
      assert.ok(warns[0].obj?.err, "the database error is attached");
    });
  }
  it("VB3 the badge read THROWS → still an empty map, and a warn", async () => {
    const m = await readVerifiedBadges(throwingOn(badges(), "identity_verifications"), [A], ENV);
    assert.ok(m instanceof Map); assert.equal(m!.size, 0); assert.equal(warns.length, 1, JSON.stringify(warns)); assert.ok(warns[0].obj?.err);
  });
  it("VB4 CONTROL: flag OFF → null (no badge key at all), no read, no log — the flag path is untouched", async () => {
    const db = makeFailClosedClient({ rows: { feature_flags: [{ flag: IDENTITY_VERIFIED_BADGE_FLAG, enabled: false }] } });
    assert.equal(await readVerifiedBadges(db, [A], ENV), null); assert.equal(warns.length, 0);
  });
});
