/**
 * profileAvatarUrlStorageOnly — a person's avatar is their own Portava upload or
 * nothing, at both doors that write it (lane PRIV-FIX-3; census-telegraph §97).
 *
 * ── THE DEFECT (B58 lane TM-2, "Adjacent findings" (a)) ──────────────────────
 * Every viewer of a person draws their avatar. Until this change a person could
 * set it to any https URL — through PATCH /api/me/profile (`appMediaRef` admits
 * "https anywhere") and through PostgREST (the baseline's and 3740's column grant
 * `UPDATE (avatar_url)` to anon and authenticated, 2078 took back `role` only) —
 * and the app's hydration passes a non-storage URL through, so each viewer's
 * device fetched a host the person chose: a presence beacon.
 *
 * WHAT IS PROVED HERE (offline; the executed SQL proof is
 * src/test/db/profileAvatarUrlStorageOnly.db.test.ts on CI's local-db job):
 *   AV-R   the rule (lib/avatarStorageRef.ts) over a table of hostile references;
 *   AV-S   the database trigger (3827) states the SAME rule: its regex, run over
 *          the same table, admits exactly what the API admits;
 *   AV-A   PATCH /api/me/profile refuses every reference that is not the caller's
 *          own upload, and writes nothing; it still saves its own upload, a clear,
 *          and an edit that does not touch the avatar;
 *   AV-C   the replayed chain (baseline + every migration, both starting ACLs)
 *          leaves no client role able to UPDATE profiles.avatar_url, a trigger
 *          guards it on INSERT and UPDATE, and 3827 sorts after every file that
 *          grants the column to a client role;
 *   AV-P1  the premise: no client tree writes avatar_url through PostgREST.
 *
 * Run: node --import tsx/esm --test src/test/profileAvatarUrlStorageOnly.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";
import { avatarRefAcceptedFor, avatarRefOwner, AVATAR_REF_FILE_MAX } from "../lib/avatarStorageRef.js";
import { replayProfilesTriggers, replayProfilesUpdateAcl, triggerGuards, type MigrationText } from "../scripts/lib/profileAuthorityColumns.js";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const MIGRATIONS = join(API_ROOT, "src", "migrations");
const THE_FILE = "3827_profiles_avatar_url_storage_only.sql";

const ME = "aa000000-0000-4000-a000-000000000099";
const OTHER = "bb000000-0000-4000-a000-000000000001";
const OWN = `profile-media/avatars/${ME}/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg`;

/** [reference, accepted as ME's own avatar?, what it is]. Every refusal is a shape a person could PATCH. */
const CASES: ReadonlyArray<[string, boolean, string]> = [
  [OWN, true, "exactly what POST /me/avatar/upload answers"],
  [`profile-media/avatars/${ME}/a.webp`, true, "a short file name"],
  [`profile-media/avatars/${ME}/x_y-z.PNG`, true, "underscore, hyphen, upper case extension"],
  [`profile-media/avatars/${ME}/${"a".repeat(AVATAR_REF_FILE_MAX)}`, true, "the longest file name admitted"],
  [`profile-media/avatars/${ME}/${"a".repeat(AVATAR_REF_FILE_MAX + 1)}`, false, "one character too long"],
  ["https://tracker.example/p.gif?u=me", false, "an outside host — the beacon"],
  ["http://tracker.example/p.gif", false, "plain http"],
  [`https://abc.supabase.co/storage/v1/object/public/profile-media/avatars/${ME}/a.jpg`, false, "the absolute public URL of the person's OWN object: the upload never answers it"],
  [`http://127.0.0.1:9/storage/v1/object/public/profile-media/avatars/${ME}/a.jpg`, false, "the configured local storage origin"],
  [`//tracker.example/profile-media/avatars/${ME}/a.jpg`, false, "scheme-relative"],
  [`/api/media/file/profile-media/avatars/${ME}/a.jpg`, false, "the relay path"],
  [`/profile-media/avatars/${ME}/a.jpg`, false, "a leading slash"],
  [`profile-media/avatars/${OTHER}/a.jpg`, false, "ANOTHER person's avatar"],
  [`profile-media/avatars/${ME.toUpperCase()}/a.jpg`, false, "the person's uid upper-cased: another object key"],
  [`profile-media/covers/${ME}/cover.jpg`, false, "a cover, not an avatar"],
  [`post-media/${ME}/a.jpg`, false, "a post's media"],
  [`PROFILE-MEDIA/avatars/${ME}/a.jpg`, false, "bucket in upper case"],
  [`profile-media/avatars/${ME}/../${OTHER}/a.jpg`, false, "traversal into another person's folder"],
  [`profile-media/avatars/${ME}/a..jpg`, false, "a double dot inside the name"],
  [`profile-media/avatars/${ME}/..`, false, "the parent directory"],
  [`profile-media/avatars/${ME}/.hidden`, false, "a leading dot"],
  [`profile-media/avatars/${ME}/a.jpg?x=1`, false, "a query"],
  [`profile-media/avatars/${ME}/a.jpg#f`, false, "a fragment"],
  [`profile-media/avatars/${ME}/a%2Fb.jpg`, false, "percent-encoding"],
  [`profile-media/avatars/${ME}/a b.jpg`, false, "whitespace"],
  [`profile-media/avatars/${ME}/a\\b.jpg`, false, "a backslash"],
  [`profile-media/avatars/${ME}/a.jpg\n`, false, "a trailing newline"],
  [` profile-media/avatars/${ME}/a.jpg`, false, "a leading space"],
  [`profile-media/avatars/${ME}/`, false, "no file"],
  [`profile-media/avatars/${ME}/a.jpg/`, false, "a trailing slash"],
  [`profile-media/avatars/${ME}/sub/a.jpg`, false, "a nested path"],
  [`profile-media/avatars/${ME}`, false, "the folder itself"],
  ["data:image/png;base64,iVBORw0KGgo=", false, "a data: URI"],
  ["javascript:alert(1)", false, "javascript:"],
];

describe("AV-R the rule (lib/avatarStorageRef.ts)", () => {
  for (const [ref, ok, what] of CASES) {
    it(`${ok ? "admits" : "refuses"} ${what}`, () => {
      assert.equal(avatarRefAcceptedFor(ref, ME), ok, JSON.stringify(ref));
    });
  }
  it("names the owner only for the exact upload shape, and NULL clears (always admitted)", () => {
    assert.equal(avatarRefOwner(OWN), ME);
    assert.equal(avatarRefOwner(`profile-media/avatars/${OTHER}/a.jpg`), OTHER);
    assert.equal(avatarRefAcceptedFor(`profile-media/avatars/${OTHER}/a.jpg`, OTHER), true, "the other person may set their own");
    assert.equal(avatarRefAcceptedFor(null, ME), true);
    assert.equal(avatarRefAcceptedFor(undefined, ME), true);
    for (const v of [42, {}, [], true]) assert.equal(avatarRefOwner(v), null);
  });
});

describe("AV-S the database trigger states the same rule as the API", () => {
  const sql = readFileSync(join(MIGRATIONS, THE_FILE), "utf8");
  // The trigger's own regular expression, lifted from the migration text (not restated here).
  const m = /NEW\.avatar_url ~ \('(\^profile-media\/avatars\/)' \|\| NEW\.id::text \|\| '([^']+)'\)\s+AND strpos\(NEW\.avatar_url, '\.\.'\) = 0\)/.exec(sql);
  it("the migration's trigger carries one owner-path regex and the `..` refusal", () => {
    assert.ok(m, "could not find the trigger's owner-path test in 3827");
  });
  const sqlAdmits = (ref: string, id: string) => new RegExp(`${m![1]}${id}${m![2]}`).test(ref) && !ref.includes("..");
  for (const [ref, ok, what] of CASES) {
    it(`agrees with the API on ${what}`, () => {
      assert.equal(sqlAdmits(ref, ME), ok, `3827 and lib/avatarStorageRef.ts disagree on ${JSON.stringify(ref)}`);
    });
  }
  it("judges a value against the ROW's id: another person's own path is refused for this row", () => {
    assert.equal(sqlAdmits(`profile-media/avatars/${OTHER}/a.jpg`, ME), false);
    assert.equal(sqlAdmits(`profile-media/avatars/${OTHER}/a.jpg`, OTHER), true);
  });
  it("consults caller_may_write_profile_role() only after the value failed the owner-path test, and refuses 42501", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_profile_avatar_url_storage_only()"), sql.indexOf("$fn$;"));
    const pathAt = fn.indexOf("NEW.avatar_url ~ (");
    const predAt = fn.indexOf("public.caller_may_write_profile_role()");
    const raiseAt = fn.indexOf("RAISE EXCEPTION");
    assert.ok(pathAt > 0 && predAt > pathAt && raiseAt > predAt, "path test, then predicate, then the refusal");
    assert.match(fn, /ERRCODE = '42501'/);
    assert.match(fn, /SECURITY INVOKER/);
  });
});

// ── AV-A: PATCH /api/me/profile ───────────────────────────────────────────────

const FOREIGN_STORED = "https://api.dicebear.com/9.x/adventurer/svg?seed=x";

function makeClient(store: { profile: Record<string, unknown>; updates: Array<Record<string, unknown>> }) {
  function chain(table: string) {
    let mode: "update" | null = null;
    let payload: Record<string, unknown> | null = null;
    const obj: any = {
      select: () => obj, eq: () => obj, neq: () => obj, in: () => obj, is: () => obj, gte: () => obj, lte: () => obj,
      ilike: () => obj, or: () => obj, not: () => obj, order: () => obj, limit: () => obj, range: () => obj,
      update(d: Record<string, unknown>) { mode = "update"; payload = d; return obj; },
      upsert: () => obj, insert: () => obj, delete: () => obj,
      maybeSingle: () => resolveOne(), single: () => resolveOne(),
      then(f: any, r: any) { return resolveOne().then((x) => ({ ...x, data: x.data === null ? [] : [x.data] })).then(f, r); },
    };
    async function resolveOne(): Promise<any> {
      if (table !== "profiles") return { data: null, error: null, count: 0 };
      if (mode === "update") {
        store.updates.push({ ...payload! });
        Object.assign(store.profile, payload);
      }
      return { data: { ...store.profile }, error: null, count: 1 };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (token: string) => (token === ME ? { data: { user: { id: ME } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    storage: { from: () => ({ remove: async () => ({ error: null }), upload: async () => ({ error: null }) }), createBucket: async () => ({ error: null }) },
  };
}

async function withApp<T>(storedAvatar: string | null, fn: (patch: (body: unknown) => Promise<{ status: number; body: any }>, store: { profile: Record<string, unknown>; updates: Array<Record<string, unknown>> }) => Promise<T>): Promise<T> {
  const store = {
    profile: {
      id: ME, handle: "me", username: "me", name: "Me", display_name: "Me", bio: null,
      avatar_url: storedAvatar, cover_photo_url: null, account_status: "active", role: "user",
      is_private: false, passport_visibility: "public", interests: [], created_at: "2026-01-01T00:00:00.000Z",
    } as Record<string, unknown>,
    updates: [] as Array<Record<string, unknown>>,
  };
  const client = makeClient(store);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", profileRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  const patch = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/me/profile`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ME}`, "Content-Type": "application/json", connection: "close" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    return await fn(patch, store);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

describe("AV-A PATCH /api/me/profile accepts only the caller's own upload as their avatar", () => {
  after(() => { _setTestServiceClient(null); });
  for (const [ref, ok, what] of CASES) {
    if (ok) continue;
    it(`refuses ${what}, and writes nothing`, async () => {
      await withApp(null, async (patch, store) => {
        const r = await patch({ avatarUrl: ref });
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body?.error, "invalid_payload", JSON.stringify(r.body));
        assert.deepEqual(store.updates, [], "a refused avatar wrote something");
        assert.equal(store.profile.avatar_url, null);
      });
    });
  }
  it("saves exactly the reference its own upload answered", async () => {
    await withApp(null, async (patch, store) => {
      const r = await patch({ avatarUrl: OWN });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(store.profile.avatar_url, OWN);
    });
  });
  it("clears the avatar (null), even over an outside URL stored before this change", async () => {
    await withApp(FOREIGN_STORED, async (patch, store) => {
      const r = await patch({ avatarUrl: null });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(store.profile.avatar_url, null);
    });
  });
  it("an edit that does not name the avatar is untouched by the rule, whatever is stored", async () => {
    await withApp(FOREIGN_STORED, async (patch, store) => {
      const r = await patch({ bio: "hello" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(store.profile.bio, "hello");
      assert.ok(store.updates.every((u) => !("avatar_url" in u)), "the edit wrote the avatar");
    });
  });
  it("re-sending an outside URL already stored is refused too (the API never re-asserts one)", async () => {
    await withApp(FOREIGN_STORED, async (patch, store) => {
      const r = await patch({ avatarUrl: FOREIGN_STORED, bio: "x" });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.deepEqual(store.updates, [], "the whole PATCH is refused, bio included");
    });
  });
});

// ── AV-C: the replayed chain ──────────────────────────────────────────────────

const baselineSql = readFileSync(BASELINE_PATH, "utf8");
function chain(skip: readonly string[] = []): MigrationText[] {
  return readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql") && !skip.includes(n))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));
}
function clientUpdatesAvatar(files: readonly MigrationText[], base: string): string[] {
  const out: string[] = [];
  for (const model of ["production", "default-acl"] as const) {
    const acl = replayProfilesUpdateAcl(files, base, model);
    for (const role of ["anon", "authenticated", "public"] as const) {
      if (acl[role].table || acl[role].cols.has("avatar_url")) out.push(`${role} (${model})`);
    }
  }
  return out;
}

describe("AV-C the chain leaves avatar_url server-written and trigger-guarded", () => {
  it("AV-C1 no client role, under either starting ACL, can UPDATE profiles.avatar_url after the chain", () => {
    assert.deepEqual(clientUpdatesAvatar(chain(), baselineSql), []);
  });
  it("AV-C2 the replay sees the hole without 3827 (the test is not blind)", () => {
    const open = clientUpdatesAvatar(chain([THE_FILE]), baselineSql);
    assert.ok(open.includes("authenticated (production)") && open.includes("anon (production)"), JSON.stringify(open));
  });
  it("AV-C3 an enabled, unconditional BEFORE INSERT OR UPDATE row trigger guards avatar_url and consults the 2078 predicate", () => {
    const guards = replayProfilesTriggers(chain(), baselineSql).filter((t) => triggerGuards(t, "avatar_url"));
    assert.deepEqual(guards.map((t) => t.name), ["trg_profiles_avatar_url_storage_only"]);
    assert.deepEqual(replayProfilesTriggers(chain([THE_FILE]), baselineSql).filter((t) => triggerGuards(t, "avatar_url")), [], "without 3827 nothing guards it");
  });
  it("AV-C4 3827 sorts after every migration that grants a client role UPDATE on avatar_url (3740 re-grants it)", () => {
    const granting = chain([THE_FILE])
      .filter((f) => f.name >= "2000")
      .filter((f) => clientUpdatesAvatar([f], "").some((x) => x.endsWith("(production)")))
      .map((f) => f.name)
      .sort();
    assert.ok(granting.includes("3740_client_grant_excess_boundary.sql"), `the fold no longer sees 3740's column grant — the test went blind: ${granting.join(", ")}`);
    assert.ok(THE_FILE > granting.at(-1)!, `${THE_FILE} sorts before ${granting.at(-1)}, which grants the column back`);
  });
});

// ── AV-P1: the premise ────────────────────────────────────────────────────────

describe("AV-P1 the premise: no client tree writes avatar_url through PostgREST", () => {
  const CLIENT_ROOTS = ["travel-buddy-standalone/src", "travel-buddy-standalone/app", "src", "app", "packages", "posts-ui", "lib"];
  const SKIP_DIR = /(^|\/)(node_modules|__tests__|\.expo|dist|build)(\/|$)/;
  function* walk(dir: string): Generator<string> {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      if (SKIP_DIR.test(p)) continue;
      const st = statSync(p);
      if (st.isDirectory()) yield* walk(p);
      else if (/\.(tsx?|jsx?|mjs)$/.test(e) && !/\.test\.|\.spec\./.test(e)) yield p;
    }
  }
  const callArgs = (text: string, open: number) => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
  };
  it("every client write to profiles leaves avatar_url alone (and the walk read real files)", () => {
    let scanned = 0;
    let writes = 0;
    const hits: string[] = [];
    for (const root of CLIENT_ROOTS) {
      for (const p of walk(join(REPO_ROOT, root))) {
        scanned++;
        const text = readFileSync(p, "utf8");
        for (const m of text.matchAll(/\.from\(\s*['"`]profiles['"`]\s*\)\s*\.(update|upsert|insert)\s*\(/g)) {
          writes++;
          const args = callArgs(text, m.index! + m[0].length - 1).replace(/\/\/[^\n]*/g, "");
          const v = /^\s*([A-Za-z_]\w*)\s*(?:,|$)/.exec(args);
          let scope = args;
          if (v) {
            const before = text.slice(Math.max(0, m.index! - 3000), m.index!).replace(/\/\/[^\n]*/g, "");
            scope = [
              ...[...before.matchAll(new RegExp(String.raw`\b${v[1]}\.(\w+)\s*=(?!=)`, "g"))].map((k) => k[1]!),
              ...[...before.matchAll(new RegExp(String.raw`\b${v[1]}\[\s*['"\`](\w+)['"\`]\s*\]\s*=(?!=)`, "g"))].map((k) => k[1]!),
              ...[...before.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+${v[1]}\b[^=]*=\s*\{([^}]*)\}`, "g"))].flatMap((k) => [...k[1]!.matchAll(/(\w+)\s*[:,}]/g)].map((x) => x[1]!)),
            ].join(" ");
          }
          if (/\bavatar_url\b/.test(scope)) hits.push(`${p.slice(REPO_ROOT.length + 1)}: ${m[1]} names avatar_url`);
        }
        if (/rest\/v1\/profiles/.test(text) && /method:\s*['"`](PATCH|POST)['"`]/.test(text)) hits.push(`${p.slice(REPO_ROOT.length + 1)}: raw PostgREST write to profiles`);
      }
    }
    assert.ok(scanned > 200, `only ${scanned} client files scanned: the roots moved`);
    assert.ok(writes >= 2, `only ${writes} client profiles writes found: the pattern stopped matching`);
    assert.deepEqual(hits, [], "a client writes profiles.avatar_url through PostgREST; 3827 refuses it — route it through PATCH /api/me/profile");
  });
});
