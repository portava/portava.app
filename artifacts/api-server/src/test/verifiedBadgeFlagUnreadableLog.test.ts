/**
 * Wave 5 follow-up B2, item 5 — the verified-badge FLAG read hid every badge in
 * silence when it could not be read.
 *
 * readVerifiedBadges (services/identityVerification/verifiedBadges.ts) asks
 * `identity_verified_badge_enabled` before computing any badge. It asked through
 * `isFlagEnabled`, which answers `false` on a database error, so an unreadable
 * flag returned the flag-OFF shape (null: no `identityBadge` key on any
 * response) and logged nothing — an outage of feature_flags looked exactly like
 * the badge being switched off. The answer is RIGHT (fail-closed: no badge) and
 * is unchanged here; the failure now logs at warn, naming the flag.
 *
 * FAIL cases were RED on the pre-fix tree (no log line); CONTROL cases pin the
 * answers and that a readable flag logs nothing.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../lib/logger.js";
import { readVerifiedBadges, _resetVerifiedBadgeFlagCache, IDENTITY_VERIFIED_BADGE_FLAG } from "../services/identityVerification/verifiedBadges.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";

const A = "aaaaaaaa-0000-4000-a000-000000000001";
const ERR = { message: "canceling statement due to statement timeout", code: "57014" };
const ENV = {} as NodeJS.ProcessEnv;

type Line = { obj: any; msg: string };
const warns: Line[] = [];
const origWarn = logger.warn;
const namesFlag = (l: Line) => new RegExp(IDENTITY_VERIFIED_BADGE_FLAG).test(`${l.msg} ${JSON.stringify(l.obj ?? {})}`);

function db(flag: "on" | "off" | "absent" | "unreadable" | "throws"): any {
  const client = makeFailClosedClient({
    rows: {
      feature_flags: flag === "absent" ? [] : [{ flag: IDENTITY_VERIFIED_BADGE_FLAG, enabled: flag === "on" || flag === "unreadable" || flag === "throws" }],
      identity_verifications: [{ user_id: A, status: "verified", provider_mode: "live", created_at: "2026-09-01T00:00:00.000Z" }],
      profiles: [{ id: A, verification_level: "id_verified" }],
    },
    failOn: (c) => (flag === "unreadable" && c.table === "feature_flags" ? ERR : null),
  });
  if (flag === "throws") {
    const from = client.from.bind(client);
    client.from = (t: string) => { if (t === "feature_flags") throw new Error("boom reading feature_flags"); return from(t); };
  }
  return client;
}

describe("item 5 — an unreadable verified-badge flag is logged; the answer (no badge) is unchanged", () => {
  beforeEach(() => { warns.length = 0; (logger as any).warn = (obj: any, msg?: string) => { warns.push({ obj, msg: msg ?? "" }); }; _resetVerifiedBadgeFlagCache(); });
  afterEach(() => { (logger as any).warn = origWarn; _resetVerifiedBadgeFlagCache(); });

  it("VF1 the flag read RESOLVES an error → null (no badge key, as OFF), and a warn names the flag", async () => {
    const out = await readVerifiedBadges(db("unreadable"), [A], ENV);
    assert.equal(out, null, "the answer on an unreadable flag stays the OFF shape");
    assert.equal(warns.filter(namesFlag).length, 1, `the unreadable flag left no trace: ${JSON.stringify(warns)}`);
  });
  it("VF2 the flag read THROWS → null, and a warn names the flag", async () => {
    const out = await readVerifiedBadges(db("throws"), [A], ENV);
    assert.equal(out, null);
    assert.equal(warns.filter(namesFlag).length, 1, `the throwing flag read left no trace: ${JSON.stringify(warns)}`);
  });
  it("VF3 the unreadable answer is cached like any other (30 s): a second call reads nothing and logs nothing more", async () => {
    const client = db("unreadable");
    await readVerifiedBadges(client, [A], ENV); await readVerifiedBadges(client, [A], ENV);
    assert.equal(warns.filter(namesFlag).length, 1, JSON.stringify(warns));
  });
  for (const flag of ["off", "absent"] as const) {
    it(`VF0-${flag} CONTROL: flag ${flag.toUpperCase()} → null, and nothing is logged`, async () => {
      const out = await readVerifiedBadges(db(flag), [A], ENV);
      assert.equal(out, null); assert.equal(warns.length, 0, JSON.stringify(warns));
    });
  }
  it("VF0-on CONTROL: flag ON → the badge, and nothing is logged", async () => {
    const out = await readVerifiedBadges(db("on"), [A], ENV);
    assert.deepEqual(out && [...out.entries()], [[A, { tier: "id" }]]); assert.equal(warns.length, 0, JSON.stringify(warns));
  });
});
