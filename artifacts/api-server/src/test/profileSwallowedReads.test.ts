/**
 * PROFILE — an unreadable row is not an empty one, and the report must say
 * which of the two happened.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error. It does not throw and it does not
 * reject. `const { data } = await client.from(…)…` with `error` discarded
 * therefore produces a value that is BYTE-IDENTICAL to "the query succeeded and
 * returned nothing" — and `Promise.allSettled` reports such a read as
 * `fulfilled`, because the promise did fulfil, so `status === "fulfilled"` is
 * not evidence that anything was read.
 *
 * The lane that closed four of these in `routes/messaging.ts` left the sibling
 * in `routes/profile.ts` open and named it. Sweeping this file found it — and
 * four more, three of which a grep for `data` cannot see because they destructure
 * `count`, which is exactly how the fourth messaging site was originally missed.
 *
 * ── THE SITES, AND THE FALSE SENTENCE EACH ONE PRODUCED ─────────────────────
 *
 *  B  PATCH /me/profile, the retranslate gate's `auto_translate_messages` read.
 *     "This user has not enabled message translation." Said about a user who
 *     has: their display language is saved, they get a 200, and their existing
 *     message translations stay in the OLD language forever, because the sweep
 *     is fire-and-forget and is never retried. NOTE THE DIRECTION — it is the
 *     OPPOSITE of the messaging.ts defect, where the swallow made every FAILING
 *     save fire a ~200-message sweep at a PAID provider. Same swallow, same
 *     shared gate module, opposite blast radius.
 *
 *  A  PATCH /me/profile, the prior avatar/cover capture. "This user had no
 *     previous avatar or cover." The old storage object is then never deleted —
 *     and this is the highest-volume orphan producer in the codebase.
 *
 *  C  PATCH /me/profile, the onboarding `@portava` lookup. "There is no
 *     @portava account." The new user's feed starts empty and nothing retries.
 *
 *  D  GET /me/profile/analytics — five counters and one list.
 *     "You had 0 profile views in the last 7 days", "you have celebrated no
 *     milestones", said when the tables could not be read.
 *
 *  E  GET /me/profile — the completeness/trust batch. "0 followers", "0 trips".
 *     `countUserTrips` already returns `{ count: null, unavailable: true }`; the
 *     route discarded that discrimination one line later.
 *
 * ── WHAT THIS SUITE ASSERTS, AND WHY IT IS NOT VACUOUS ──────────────────────
 * At every one of these sites the swallow ALREADY fails closed — the sweep does
 * not fire, the object is not deleted, the follow is not written, the number is
 * a harmless zero. That is the correct answer and this lane does not move it.
 * So a test that only asserted "nothing happened on failure" would be GREEN on
 * the pre-fix code and would prove nothing whatsoever.
 *
 * Every failure case here is therefore asserted on TWO axes:
 *   (1) the fail-closed answer is UNCHANGED  — the property we must not break;
 *   (2) the failure is REPORTED, with a word that distinguishes "could not be
 *       read" from "there was nothing there" — the property the fix adds, and
 *       the ONLY axis on which the pre-fix code is red.
 * and is PAIRED with a positive control on a SUCCESSFUL read, which is what
 * stops "refuse everything" from satisfying the failure assertions.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/profileSwallowedReads.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import profileRouter from "../routes/profile.js";

const ME = "aa000000-0000-4000-a000-0000000000b1";
const PORTAVA = "aa000000-0000-4000-a000-0000000000b2";
const TOK = "tok-profile-swallow";

/** A resolved PostgREST failure. Never a throw — that is the whole point. */
const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

// ── log capture ────────────────────────────────────────────────────────────
// The fail-closed ANSWER does not move at any of these sites, so the log is
// where the fix is observable. Capturing it is not a stylistic assertion: it is
// the difference between an operator seeing a failed read and a user being
// handed a confident zero.
let logged: Array<{ level: string; obj: any; msg: string }> = [];
function recordLog() {
  const mk = (level: string) => (obj: any, msg?: string) => {
    logged.push({ level, obj, msg: typeof obj === "string" ? obj : (msg ?? "") });
  };
  const l: any = { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") };
  l.child = () => l;
  return l;
}
/** Every logged message, lowercased, joined — for substring assertions. */
function loggedText(level?: string): string {
  return logged.filter((e) => !level || e.level === level).map((e) => e.msg).join("\n").toLowerCase();
}

// ── read tracking ──────────────────────────────────────────────────────────
let readTables: string[] = [];
/** Storage objects the handler actually asked to delete. */
let removedPaths: string[] = [];

function install(spec: FakeClientSpec & { fail?: (ctx: FakeReadContext, n: number) => any }) {
  const perTable: Record<string, number> = {};
  const userFail = spec.fail;
  const full: FakeClientSpec = {
    ...spec,
    users: { [TOK]: ME },
    failOn: (ctx) => {
      readTables.push(ctx.table);
      perTable[ctx.table] = (perTable[ctx.table] ?? 0) + 1;
      return userFail ? (userFail(ctx, perTable[ctx.table]) ?? null) : null;
    },
  };
  const client = makeFailClosedClient(full);
  // makeFailClosedClient models PostgREST only. cleanupOldMedia reaches for
  // `sc.storage`, so the double gets one — and recording the removals is what
  // lets the site-A positive control assert that the healthy path still DELETES
  // rather than merely not-warning.
  removedPaths = [];
  client.storage = {
    from: () => ({
      remove: async (paths: string[]) => { removedPaths.push(...paths); return { data: null, error: null }; },
      upload: async () => ({ data: null, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: "https://example.com/f" } }),
    }),
    createBucket: async () => ({ data: null, error: null }),
    listBuckets: async () => ({ data: [], error: null }),
  };
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return full;
}

function profilesRow(extra: Record<string, any> = {}) {
  return { id: ME, account_status: "active", username: "me", handle: "me", name: "Me", ...extra };
}

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = recordLog(); next(); });
  app.use("/api", profileRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
after(() => { server.close(); });

async function call(method: "GET" | "PATCH", path: string, body?: any) {
  logged = [];
  readTables = [];
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOK}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  // The sweep, the storage cleanup and the auto-follow are all fire-and-forget:
  // they are LAUNCHED before the response is written and must be allowed to run.
  await new Promise((r) => setTimeout(r, 40));
  return { status: res.status, body: parsed };
}

/* ══════════════════════════════════════════════════════════════════════════
 * SITE B — the retranslate gate's auto_translate_messages read
 * ════════════════════════════════════════════════════════════════════════ */
describe("site B: retranslate gate — 'could not read the preference' is not 'the preference is off'", () => {
  it("POSITIVE CONTROL: a readable preference of true still fires the sweep", async () => {
    install({ rows: { profiles: [profilesRow({ auto_translate_messages: true, preferred_language: "en" })] } });
    const res = await call("PATCH", "/me/profile", { preferredLanguage: "es" });
    assert.equal(res.status, 200);
    assert.ok(
      readTables.includes("message_translations"),
      `the sweep must still fire on a healthy read — tables read: ${readTables.join(", ")}`,
    );
    assert.equal(
      loggedText("warn").includes("auto_translate_messages unreadable"),
      false,
      "a healthy read must not report itself as unreadable",
    );
  });

  it("POSITIVE CONTROL: a readable preference of false still suppresses the sweep", async () => {
    install({ rows: { profiles: [profilesRow({ auto_translate_messages: false, preferred_language: "en" })] } });
    const res = await call("PATCH", "/me/profile", { preferredLanguage: "es" });
    assert.equal(res.status, 200);
    assert.equal(
      readTables.includes("message_translations"), false,
      "auto-translate off must not buy a ~200-message provider sweep",
    );
    assert.equal(
      loggedText("warn").includes("auto_translate_messages unreadable"), false,
      "a preference that was READ and is false is not an unreadable preference",
    );
  });

  it("an UNREADABLE preference still suppresses the sweep AND is reported as unread", async () => {
    // The preference IS true in the seed. Only the read fails, so "the user has
    // not enabled translation" is not an available reading of the result.
    install({
      rows: { profiles: [profilesRow({ auto_translate_messages: true, preferred_language: "en" })] },
      // profiles read #1 is requireUser's account_status ban gate — failing it
      // would 503 the whole request and this case would pass for the wrong
      // reason. #2 is the preference read. One read, one gate, one reason.
      fail: (ctx, n) => (ctx.table === "profiles" && n === 2 ? READ_ERROR : null),
    });
    const res = await call("PATCH", "/me/profile", { preferredLanguage: "es" });

    // (1) the answer does not move — the write committed, so a 503 here would
    //     tell the client to retry a save that succeeded.
    assert.equal(res.status, 200, "the profile save itself succeeded and must still report success");
    assert.equal(
      readTables.includes("message_translations"), false,
      "FAIL CLOSED: an unread preference must never be spent against",
    );
    // (2) and the loss is reported. This is the axis the pre-fix code is red on.
    const t = loggedText("warn");
    assert.ok(
      t.includes("auto_translate_messages unreadable"),
      `an unreadable preference must be reported, not silently treated as 'off'. warns seen:\n${t}`,
    );
    assert.ok(
      t.includes("no retranslation sweep"),
      "the report must say what was LOST, not merely that a read failed",
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * SITE A — prior avatar/cover capture (old-media cleanup)
 * ════════════════════════════════════════════════════════════════════════ */
describe("site A: prior avatar/cover — 'could not read it' is not 'there wasn't one'", () => {
  const OLD = "profile-media/avatars/" + ME + "/old.jpg";

  it("POSITIVE CONTROL: a readable prior avatar is still cleaned up", async () => {
    install({ rows: { profiles: [profilesRow({ avatar_url: OLD })] } });
    const res = await call("PATCH", "/me/profile", { avatarUrl: "https://cdn.example/new.jpg" });
    assert.equal(res.status, 200);
    assert.deepEqual(
      removedPaths, ["avatars/" + ME + "/old.jpg"],
      "the healthy path must still DELETE the replaced object — a fix that simply stopped cleaning up would satisfy the failure case below",
    );
    assert.equal(
      loggedText("warn").includes("prior avatar/cover unreadable"), false,
      "a healthy read must not report itself as unreadable",
    );
  });

  it("an UNREADABLE prior avatar deletes nothing AND says the object is orphaned", async () => {
    install({
      rows: { profiles: [profilesRow({ avatar_url: OLD })] },
      // #1 = account_status ban gate, #2 = the prior-media capture.
      fail: (ctx, n) => (ctx.table === "profiles" && n === 2 ? READ_ERROR : null),
    });
    const res = await call("PATCH", "/me/profile", { avatarUrl: "https://cdn.example/new.jpg" });

    // (1) fail-OPEN is correct here and must not move: deleting on a guess
    //     destroys the wrong object, which is unrecoverable.
    assert.equal(res.status, 200, "an unreadable prior URL must not fail the save");
    assert.deepEqual(removedPaths, [], "nothing may be deleted on the strength of a read that failed");
    // (2) but the orphan must be reported rather than produced in silence.
    const t = loggedText("warn");
    assert.ok(
      t.includes("prior avatar/cover unreadable"),
      `an unreadable prior-media read must be reported. warns seen:\n${t}`,
    );
    assert.ok(t.includes("orphan"), "the report must name the consequence (an orphaned storage object)");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * SITE C — onboarding @portava lookup
 * ════════════════════════════════════════════════════════════════════════ */
describe("site C: @portava lookup — 'could not read it' is not 'it does not exist'", () => {
  const withPortava = () => [profilesRow(), { id: PORTAVA, account_status: "active", username: "portava" }];

  it("POSITIVE CONTROL: a readable @portava row is still auto-followed", async () => {
    const spec = install({ rows: { profiles: withPortava() } });
    const res = await call("PATCH", "/me/profile", { onboardingComplete: true, displayName: "Me" });
    assert.equal(res.status, 200);
    assert.deepEqual(
      (spec.inserted?.user_follows ?? [])[0],
      { follower_id: ME, following_id: PORTAVA },
      "the auto-follow must still be written on a healthy read",
    );
    assert.equal(loggedText("warn").includes("@portava"), false, "a healthy lookup reports nothing");
  });

  it("POSITIVE CONTROL: a genuinely ABSENT @portava row is reported as not found", async () => {
    const spec = install({ rows: { profiles: [profilesRow()] } });
    await call("PATCH", "/me/profile", { onboardingComplete: true, displayName: "Me" });
    assert.equal((spec.inserted?.user_follows ?? []).length, 0);
    const t = loggedText("warn");
    assert.ok(t.includes("not found"), `an absent account must be reported as ABSENT. warns seen:\n${t}`);
    assert.equal(
      t.includes("unreadable"), false,
      "absent and unreadable must not share a word — they need different fixes",
    );
  });

  it("an UNREADABLE @portava lookup follows nobody AND is reported as UNREADABLE, not absent", async () => {
    const spec = install({
      rows: { profiles: withPortava() },
      // The @portava lookup is the LAST profiles read in this request.
      fail: (ctx) => (ctx.table === "profiles" && ctx.eq("username") === "portava" ? READ_ERROR : null),
    });
    const res = await call("PATCH", "/me/profile", { onboardingComplete: true, displayName: "Me" });

    assert.equal(res.status, 200, "an unreadable ancillary lookup must not fail the profile save");
    assert.equal(
      (spec.inserted?.user_follows ?? []).length, 0,
      "FAIL CLOSED: we do not follow a row we could not read",
    );
    const t = loggedText("warn");
    assert.ok(t.includes("unreadable"), `warns seen:\n${t}`);
    assert.ok(t.includes("@portava"), "the report must name what could not be read");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * SITE D — GET /me/profile/analytics counters and the milestone list
 * ════════════════════════════════════════════════════════════════════════ */
describe("site D: analytics — an unreadable counter is not a zero", () => {
  const seed = () => ({
    profiles: [profilesRow()],
    profile_views: [
      { id: "v1", target_id: ME, viewer_id: "other", viewed_at: new Date().toISOString() },
      { id: "v2", target_id: ME, viewer_id: "other2", viewed_at: new Date().toISOString() },
    ],
    stamp_milestones: [{ user_id: ME, milestone_level: 3, celebrated_at: new Date().toISOString() }],
  });

  it("POSITIVE CONTROL: healthy reads still report the real numbers and the real list", async () => {
    install({ rows: seed() });
    const res = await call("GET", "/me/profile/analytics");
    assert.equal(res.status, 200);
    assert.equal(res.body.profileViews.sevenDay, 2, "a genuine count must survive the change");
    assert.deepEqual(res.body.milestones.map((m: any) => m.level), [3]);
    assert.equal(loggedText("warn").includes("unreadable"), false);
  });

  it("POSITIVE CONTROL: a genuinely EMPTY table still reports zero, silently", async () => {
    install({ rows: { profiles: [profilesRow()] } });
    const res = await call("GET", "/me/profile/analytics");
    assert.equal(res.status, 200);
    assert.equal(res.body.profileViews.sevenDay, 0);
    assert.equal(
      loggedText("warn").includes("unreadable"), false,
      "an empty table is an ANSWER — reporting it as a failure would be the mirror-image defect",
    );
  });

  it("an UNREADABLE profile_views still reports 0 AND says the count could not be read", async () => {
    install({ rows: seed(), fail: (ctx) => (ctx.table === "profile_views" ? READ_ERROR : null) });
    const res = await call("GET", "/me/profile/analytics");
    assert.equal(res.status, 200, "an analytics blip must not take down the endpoint");
    assert.equal(res.body.profileViews.sevenDay, 0, "the fail-open zero is deliberate and must not move");
    const t = loggedText("warn");
    assert.ok(t.includes("counter unreadable"), `warns seen:\n${t}`);
    assert.ok(
      logged.some((e) => e.level === "warn" && e.obj?.label === "profile_views_7d"),
      "the report must name WHICH counter failed, or an operator cannot act on it",
    );
  });

  it("an UNREADABLE stamp_milestones still reports [] AND says the list could not be read", async () => {
    install({ rows: seed(), fail: (ctx) => (ctx.table === "stamp_milestones" ? READ_ERROR : null) });
    const res = await call("GET", "/me/profile/analytics");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.milestones, [], "the fail-open empty list is deliberate and must not move");
    const t = loggedText("warn");
    assert.ok(t.includes("list unreadable"), `an unreadable list is not an empty one. warns seen:\n${t}`);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * SITE E — GET /me/profile completeness/trust batch
 * ════════════════════════════════════════════════════════════════════════ */
describe("site E: profile counters — an unreadable follower count is not zero followers", () => {
  const seed = () => ({
    profiles: [profilesRow()],
    user_follows: [
      { follower_id: "f1", following_id: ME },
      { follower_id: "f2", following_id: ME },
    ],
  });

  it("POSITIVE CONTROL: a healthy follower count still reaches the wire", async () => {
    install({ rows: seed() });
    const res = await call("GET", "/me/profile");
    assert.equal(res.status, 200);
    assert.equal(res.body.followersCount, 2, "a genuine count must survive the change");
    assert.equal(loggedText("warn").includes("counter unreadable"), false);
  });

  it("an UNREADABLE user_follows still reports 0 AND says the count could not be read", async () => {
    install({ rows: seed(), fail: (ctx) => (ctx.table === "user_follows" ? READ_ERROR : null) });
    const res = await call("GET", "/me/profile");
    assert.equal(res.status, 200, "GET /me/profile is the app's primary read — a counter blip must not 503 it");
    assert.equal(res.body.followersCount, 0, "the fail-open zero is deliberate and must not move");
    const t = loggedText("warn");
    assert.ok(t.includes("counter unreadable"), `warns seen:\n${t}`);
    assert.ok(
      logged.some((e) => e.level === "warn" && e.obj?.label === "followers"),
      "the report must name WHICH counter failed",
    );
  });

  it("an UNAVAILABLE trip count (countUserTrips' own third state) is reported, not discarded", async () => {
    // countUserTrips already returns `{ count: null, unavailable: true, reason }`.
    // The route used to throw that discrimination away one line later.
    install({ rows: seed(), fail: (ctx) => (ctx.table === "trip_members" ? READ_ERROR : null) });
    const res = await call("GET", "/me/profile");
    assert.equal(res.status, 200);
    assert.equal(res.body.tripCount, 0, "the fail-open zero is deliberate and must not move");
    assert.ok(
      logged.some((e) => e.level === "warn" && e.obj?.label === "trip_count" && typeof e.obj?.reason === "string"),
      `the domain layer's own reason must be carried through, not dropped. warns seen:\n${loggedText("warn")}`,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * STRUCTURE — both gate call sites, and the file as a whole
 * ════════════════════════════════════════════════════════════════════════ */
describe("structure: the property, pinned where a behavioural test cannot reach", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("every `const { data … } = await` in routes/profile.ts binds its error", () => {
    const src = read("../routes/profile.ts");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /const\s*\{\s*(data|count)\b[^}]*\}\s*=\s*await/.test(line))
      .filter(({ line }) => !/\berror\b/.test(line));
    assert.deepEqual(
      offenders.map((o) => `${o.n}: ${o.line.trim()}`),
      [],
      "a discarded `error` makes a failed read indistinguishable from an empty one",
    );
  });

  it("BOTH shouldRetranslateOnLanguageChange call sites gate on a bound read error", () => {
    // The two call sites' unreadable inputs are DIFFERENT (messaging.ts cannot
    // read the PRIOR LANGUAGE; profile.ts cannot read the PREFERENCE) and the
    // shared gate gives those two inputs OPPOSITE defaults — `oldLanguage:
    // undefined` means "assume a change and SPEND", `autoTranslateMessages:
    // undefined` means "fail closed". That is precisely why the discrimination
    // stayed at the call sites; this test is what makes "each call site
    // remembers" enforceable in one place instead of a hope.
    const sites: Array<[string, string]> = [
      ["../routes/messaging.ts", "beforeErr"],
      ["../routes/profile.ts", "prefErr"],
    ];
    for (const [file, errVar] of sites) {
      const src = read(file);
      const idx = src.indexOf("shouldRetranslateOnLanguageChange({");
      assert.ok(idx > 0, `${file}: expected a gate call site`);
      const window = src.slice(Math.max(0, idx - 3000), idx + 300);
      assert.ok(
        new RegExp(`error:\\s*${errVar}\\b`).test(window),
        `${file}: the read feeding the gate must BIND its error as ${errVar}`,
      );
      assert.ok(
        new RegExp(`!${errVar}\\s*&&\\s*(shouldRetranslateOnLanguageChange|newLang)`).test(window)
          || new RegExp(`!${errVar}\\s*&&`).test(window),
        `${file}: the gate call must be suppressed when ${errVar} is set — an unread input is not evidence`,
      );
    }
  });

  it("the ruling on the fail-open counters is written down, not merely implied", () => {
    const src = read("../routes/profile.ts");
    assert.ok(/function settledCount\(/.test(src));
    assert.ok(/function settledRows\(/.test(src));
    assert.ok(
      /RULED HARMLESS/.test(src),
      "a site ruled harmless must carry the reasoning, or the ruling cannot be re-checked",
    );
  });
});
