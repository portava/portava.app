/**
 * intel_evidence.reference names no account — census-map §45.
 *
 * THE DEFECT (found by lane I, census-media §35.7 item 1): the map evidence path
 * stored `reference = <bucket>/<path>`, and every path POST /api/media/upload
 * mints begins with the uploader's ACCOUNT uuid. 3002 tokenises the contributor
 * id on this table so that no stored contribution names an account; the key put
 * the account back one column over, and with it every observation under that
 * contributor's weekly token.
 *
 * What this suite pins, each part seen RED with the fix mutated out:
 *
 *   A. the codec: sealed references open only for their own observation and
 *      key, are deterministic per (observation, object) and unrelated across
 *      observations, and hide the key's length;
 *   B. through the REAL capture path: the stored row carries no account uuid,
 *      in any substring or encoding;
 *   C. the contributor's reader: resolves the object for the contributor and
 *      refuses everyone else, including a stranger the byte gate alone WOULD
 *      serve, and refuses the contributor an object the byte gate refuses;
 *   D. account deletion: still finds and removes the bytes, under every
 *      identity the account's rows are stored with (the account id and each
 *      3002 token), and says so when a reference cannot be opened;
 *   E. nothing outside lib/intelEvidenceCapture selects `reference`.
 *
 * Everything runs in memory against fake clients. Nothing on the path under
 * test is mocked: attachMediaEvidence, ingestMapContribution,
 * readOwnContributorIdentities, authorizeMediaAccess and executeAccountDeletion
 * are the shipping implementations.
 *
 * Run: node --import tsx/esm --test src/test/intelEvidenceReference.test.ts
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_REFERENCE_PREFIX,
  PHOTO_EVIDENCE_CONSENT_VERSIONS,
  _setPhotoEvidenceConsentVersionsForTests,
  attachMediaEvidence,
  openEvidenceReference,
  rekeyLegacyEvidenceReferences,
  resolveEvidenceMediaForContributor,
  sealEvidenceReference,
} from "../lib/intelEvidenceCapture.js";
import { ingestMapContribution } from "../routes/mapObservations.js";
import { linkMediaEvidence } from "../lib/media/mediaEvidenceLink.js";
import { _clearMediaAccessCache, authorizeMediaAccess } from "../lib/mediaAccess.js";
import {
  CONSENTED_CONTRIBUTORS_RPC,
  CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC,
  resetContributorIdentityShapeMemo,
} from "../lib/intelConsent.js";
import { executeAccountDeletion, POST_MEDIA_BUCKET } from "../services/accountDeletion/AccountDeletionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..");

const KEY = "intel-evidence-reference-suite-key-0123456789abcdef";
const OTHER_KEY = "a-different-server-key-that-must-not-open-it-0123";

/**
 * A FICTIONAL disclosure version whose words name photos. Gate 2b keeps a photo
 * only under such a version and no real one exists (section F pins the shipped,
 * empty list), so sections B–E, which test what happens AFTER that gate, give
 * their contributors this one.
 */
const PHOTO_TEST_VERSION = "test_only_disclosure_naming_photos";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.INTEL_EVIDENCE_REFERENCE_KEY;
  process.env.INTEL_EVIDENCE_REFERENCE_KEY = KEY;
  _setPhotoEvidenceConsentVersionsForTests([PHOTO_TEST_VERSION]);
  resetContributorIdentityShapeMemo();
  _clearMediaAccessCache();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.INTEL_EVIDENCE_REFERENCE_KEY;
  else process.env.INTEL_EVIDENCE_REFERENCE_KEY = savedKey;
  _setPhotoEvidenceConsentVersionsForTests(null);
});

const OBS_1 = "44444444-4444-4444-8444-000000000001";
const OBS_2 = "44444444-4444-4444-8444-000000000002";
const PLACE = "22222222-2222-4222-8222-222222222222";
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString();

/** Every encoding of an account uuid that a stored value must not contain. */
function encodingsOf(uuid: string): string[] {
  const hex = uuid.replace(/-/g, "");
  const raw = Buffer.from(hex, "hex");
  const text = Buffer.from(uuid, "utf8");
  const segments = uuid.split("-").filter((s) => s.length >= 8);
  return [
    uuid, uuid.toUpperCase(), hex, hex.toUpperCase(),
    raw.toString("base64"), raw.toString("base64").replace(/=+$/, ""), raw.toString("base64url"),
    text.toString("base64"), text.toString("base64").replace(/=+$/, ""), text.toString("base64url"),
    text.toString("hex"), encodeURIComponent(uuid),
    ...segments, ...segments.map((s) => s.toUpperCase()),
  ];
}
const UUID_SHAPED = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

function assertNamesNoAccount(value: string, account: string, what: string, opts: { anyUuid: boolean } = { anyUuid: true }): void {
  for (const enc of encodingsOf(account)) {
    assert.equal(value.includes(enc), false, `${what} contains an encoding of the account id (${enc})`);
  }
  // A sealed reference holds no identifier of any kind. (A whole row does: its
  // own id and its observation id, which is why the row check turns this off.)
  if (opts.anyUuid) assert.equal(UUID_SHAPED.test(value), false, `${what} contains a uuid-shaped substring`);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. The codec
// ═══════════════════════════════════════════════════════════════════════════

describe("A. a sealed reference", () => {
  const ACCOUNT = randomUUID();
  const KEY_1 = `post-media/${ACCOUNT}/1756600000000.jpg`;

  const seal = (key: string, obs: string): string => {
    const s = sealEvidenceReference(key, obs);
    assert.equal(s.ok, true, JSON.stringify(s));
    return (s as { reference: string }).reference;
  };

  it("opens to the key it sealed, for its own observation", () => {
    const ref = seal(KEY_1, OBS_1);
    assert.ok(ref.startsWith(EVIDENCE_REFERENCE_PREFIX));
    assert.deepEqual(openEvidenceReference(ref, OBS_1), { ok: true, storageKey: KEY_1 });
    // Uuid case variants of the observation id are the same observation.
    assert.deepEqual(openEvidenceReference(ref, OBS_1.toUpperCase()), { ok: true, storageKey: KEY_1 });
  });

  it("is the same value on a replay, so 2223's unique index still dedupes a double-tap", () => {
    assert.equal(seal(KEY_1, OBS_1), seal(KEY_1, OBS_1));
  });

  it("is UNRELATED across observations, and does not open for another one", () => {
    const a = seal(KEY_1, OBS_1);
    const b = seal(KEY_1, OBS_2);
    assert.notEqual(a, b, "the same photo on two observations must not produce one linkable value");
    // Not merely different: no shared run long enough to be a common component.
    const body = (s: string) => s.slice(EVIDENCE_REFERENCE_PREFIX.length);
    for (let i = 0; i + 16 <= body(a).length; i += 4) {
      assert.equal(body(b).includes(body(a).slice(i, i + 16)), false, "the two references share a 16-char run");
    }
    assert.deepEqual(openEvidenceReference(a, OBS_2), { ok: false, reason: "unopenable" });
  });

  it("does not open under another key, edited, truncated, or without its prefix", () => {
    const ref = seal(KEY_1, OBS_1);
    process.env.INTEL_EVIDENCE_REFERENCE_KEY = OTHER_KEY;
    assert.deepEqual(openEvidenceReference(ref, OBS_1), { ok: false, reason: "unopenable" });
    process.env.INTEL_EVIDENCE_REFERENCE_KEY = KEY;
    const flip = ref.slice(0, -5) + (ref.at(-5) === "A" ? "B" : "A") + ref.slice(-4);
    assert.deepEqual(openEvidenceReference(flip, OBS_1), { ok: false, reason: "unopenable" });
    assert.deepEqual(openEvidenceReference(ref.slice(0, -8), OBS_1), { ok: false, reason: "unopenable" });
    assert.deepEqual(openEvidenceReference(KEY_1, OBS_1), { ok: false, reason: "not_sealed" });
  });

  it("hides the key's length: every upload-shaped key seals to the same length", () => {
    const lengths = new Set(
      ["jpg", "webp", "mp4", "mov", "jpeg"].map((ext) => seal(`post-media/${ACCOUNT}/1756600000000.${ext}`, OBS_1).length),
    );
    assert.equal(lengths.size, 1, `lengths ${[...lengths].join(",")}`);
  });

  it("refuses to seal or open with no key, or a key under 32 characters — there is no fallback", () => {
    const ref = seal(KEY_1, OBS_1);
    for (const bad of [undefined, "", "x".repeat(31)]) {
      if (bad === undefined) delete process.env.INTEL_EVIDENCE_REFERENCE_KEY;
      else process.env.INTEL_EVIDENCE_REFERENCE_KEY = bad;
      assert.deepEqual(sealEvidenceReference(KEY_1, OBS_1), { ok: false, reason: "reference_key_unavailable" });
      assert.deepEqual(openEvidenceReference(ref, OBS_1), { ok: false, reason: "reference_key_unavailable" });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Through the real capture path: the stored row names no account
// ═══════════════════════════════════════════════════════════════════════════

/** The capture fake: mapMediaEvidence.test.ts's shape, with 2223's unique index. */
function captureDb(accounts: string[], consentVersion: string = PHOTO_TEST_VERSION) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "map_contributions_enabled", enabled: true },
      { flag: "intel_capture_quick_signal", enabled: true },
    ],
    places: [{ id: PLACE }],
    intel_contribution_consent: accounts.map((user_id) => ({ user_id, enabled: true, withdrawn_at: null, consent_version: consentVersion })),
    intel_observations: [],
    intel_evidence: [],
  };
  let seq = 0;
  function from(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    const filters: Array<[string, any, string]> = [];
    const run = () => {
      const store = tables[table] ?? (tables[table] = []);
      if (op !== "select") {
        const row = { id: `44444444-4444-4444-8444-${String(++seq).padStart(12, "0")}`, created_at: new Date().toISOString(), ...payload };
        const dup =
          (table === "intel_observations" && store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key)) ||
          (table === "intel_evidence" && row.reference != null && store.some((r) => r.observation_id === row.observation_id && r.reference === row.reference));
        if (dup) return { data: null, error: { code: "23505", message: "duplicate key" } };
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      return {
        data: store.filter((r) => filters.every(([c, v, k]) => (k === "in" ? (v as any[]).includes(r[c]) : k === "is" ? (r[c] ?? null) === v : r[c] === v))),
        error: null,
      };
    };
    const first = () => { const r = run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; };
    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { filters.push([c, v, "eq"]); return b; },
      in(c: string, v: any[]) { filters.push([c, v, "in"]); return b; },
      is(c: string, v: any) { filters.push([c, v, "is"]); return b; },
      lte() { return b; }, gte() { return b; }, order() { return b; }, limit() { return b; },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      maybeSingle() { return Promise.resolve(first()); },
      single() { return Promise.resolve(first()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from, _tables: tables } as any;
}

describe("B. the persisted evidence row names no account", () => {
  it("no stored reference, for forty accounts, contains any account id in any substring or encoding", async () => {
    const accounts = Array.from({ length: 40 }, () => randomUUID());
    const db = captureDb(accounts);
    for (const account of accounts) {
      const obs = await ingestMapContribution(db, account, {
        objectId: PLACE, objectKind: "place", kind: "crowd_level", value: "busy", observedAt: OBSERVED,
      });
      assert.equal(obs.ok, true, JSON.stringify(obs));
      const media = `post-media/${account}/1756600000000.jpg`;
      const ev = await ingestMapContribution(db, account, {
        objectId: PLACE, objectKind: "place", kind: "media", value: "photo", mediaUri: media, observedAt: OBSERVED,
        observationId: (obs as any).observation.id,
      });
      assert.equal(ev.ok, true, JSON.stringify(ev));
    }
    // Vacuity guard: forty rows really were written, one per account.
    assert.equal(db._tables.intel_evidence.length, 40);

    for (const row of db._tables.intel_evidence) {
      const account = accounts.find((a) => row.actor_id === a);
      assert.ok(account, "setup: the fake stores the ingest credential in actor_id (3002's trigger tokenises it in the database)");
      assertNamesNoAccount(String(row.reference), account, "intel_evidence.reference");
      // Every OTHER column this path writes, too. actor_id is excluded only because
      // the database, not this code, replaces it (3002's BEFORE INSERT trigger).
      const { actor_id: _tokenisedByTheDatabase, ...rest } = row;
      void _tokenisedByTheDatabase;
      assertNamesNoAccount(JSON.stringify(rest), account, "the evidence row", { anyUuid: false });
      // CONTROL: it is not an empty or constant value — it opens to the key.
      assert.equal(openEvidenceReference(row.reference, row.observation_id).ok, true);
    }
  });

  it("the same photo on two observations is stored as two unrelated references", async () => {
    const account = randomUUID();
    const db = captureDb([account]);
    const ids: string[] = [];
    for (const [kind, value] of [["crowd_level", "busy"], ["queue", "under_5m"]] as const) {
      const obs = await ingestMapContribution(db, account, { objectId: PLACE, objectKind: "place", kind, value, observedAt: OBSERVED });
      assert.equal(obs.ok, true, JSON.stringify(obs));
      ids.push((obs as any).observation.id);
    }
    for (const observationId of ids) {
      const r = await attachMediaEvidence(db, account, {
        observationId, subjectId: PLACE, mediaUri: `post-media/${account}/1756600000000.jpg`, mediaKind: "photo", observedAt: OBSERVED,
      });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const [a, b] = db._tables.intel_evidence.map((r: any) => r.reference);
    assert.notEqual(a, b, "one stable value per object would link the weekly tokens it sits beside");
  });

  it("the media seam's writer stores no storage key either (its only writer of `reference`)", async () => {
    // lib/media/mediaEvidenceLink has no production caller; it is accessible code
    // behind media_evidence_enabled, and it used to mirror the asset's storage
    // path — `<account>/<ms>.<ext>` — into `reference`.
    const account = randomUUID();
    const db = captureDb([account]);
    db._tables.feature_flags.push({ flag: "media_evidence_enabled", enabled: true });
    const res = await linkMediaEvidence(db, {
      observationId: OBS_1,
      actorId: account,
      asset: {
        id: randomUUID(), media_type: "image", storage_path: `${account}/1756600000000.jpg`,
        source_type: "camera", captured_at: OBSERVED,
        provenance: { sourceType: "camera", capturedAt: OBSERVED, editHistory: [], hasLocation: false },
      } as any,
    });
    assert.equal(res.linked, true, JSON.stringify(res));
    const row = db._tables.intel_evidence[0];
    assert.equal(row.reference, null);
    // media_asset_id is the seam's link, and it still joins to media_assets.owner_user_id:
    // that half is census-media §35.4 MD65 Question 3, an owner decision, not taken here.
    const { actor_id: _a, media_asset_id: _m, ...rest } = row;
    void _a; void _m;
    assertNamesNoAccount(JSON.stringify(rest), account, "the seam's evidence row", { anyUuid: false });
  });

  it("with no key configured, the capture refuses by name and stores nothing", async () => {
    const account = randomUUID();
    const db = captureDb([account]);
    const obs = await ingestMapContribution(db, account, { objectId: PLACE, objectKind: "place", kind: "crowd_level", value: "busy", observedAt: OBSERVED });
    delete process.env.INTEL_EVIDENCE_REFERENCE_KEY;
    const ev = await ingestMapContribution(db, account, {
      objectId: PLACE, objectKind: "place", kind: "media", value: "photo",
      mediaUri: `post-media/${account}/1756600000000.jpg`, observedAt: OBSERVED, observationId: (obs as any).observation.id,
    });
    assert.equal(ev.ok, false);
    assert.equal((ev as any).reason, "reference_key_unavailable");
    assert.equal((ev as any).code, "server_not_configured");
    assert.equal(db._tables.intel_evidence.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared fake for C and D: a permissive PostgREST builder with eq/in filtering,
// the 3310 identity bridge, storage and auth.
// ═══════════════════════════════════════════════════════════════════════════

interface Op { table: string; op: string; filters: Array<[string, string, any]> }

function bridgeClient(opts: { rows?: Record<string, any[]>; tokens?: Record<string, string[]>; bridgeFails?: boolean } = {}) {
  const rows: Record<string, any[]> = { ...(opts.rows ?? {}) };
  const ops: Op[] = [];
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  const authDeleted: string[] = [];

  function builder(table: string) {
    const state = { op: "select", filters: [] as Array<[string, string, any]>, single: false, limit: 0 };
    const run = () => {
      ops.push({ table, op: state.op, filters: state.filters });
      let data: any[] = (rows[table] ?? []).filter((r) =>
        state.filters.every(([kind, c, v]) => (kind === "eq" ? r[c] === v : kind === "in" ? (v as any[]).includes(r[c]) : true)),
      );
      if (state.limit) data = data.slice(0, state.limit);
      return Promise.resolve(state.single ? { data: data[0] ?? null, error: null } : { data, error: null });
    };
    const target: any = {
      select() { return proxy; },
      delete() { state.op = "delete"; return proxy; },
      update() { state.op = "update"; return proxy; },
      upsert() { state.op = "upsert"; return proxy; },
      insert() { state.op = "insert"; return proxy; },
      eq(c: string, v: any) { state.filters.push(["eq", c, v]); return proxy; },
      in(c: string, v: any[]) { state.filters.push(["in", c, v]); return proxy; },
      limit(n: number) { state.limit = n; return proxy; },
      maybeSingle() { state.single = true; return run(); },
      single() { state.single = true; return run(); },
      then(res: any, rej: any) { return run().then(res, rej); },
    };
    // Any other PostgREST method (or, not, order, is, contains, …) chains and
    // does not filter: every table the tests below fill is read through eq/in.
    const proxy: any = new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => proxy) });
    return proxy;
  }

  return {
    _ops: ops,
    _removed: removed,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, any>) => {
      ops.push({ table: `rpc:${fn}`, op: "rpc", filters: [] });
      if (opts.bridgeFails && (fn === CONSENTED_CONTRIBUTORS_RPC || fn === CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC)) {
        return { data: null, error: { message: "connection reset", code: "08006" } };
      }
      if (fn === CONSENTED_CONTRIBUTORS_RPC) return { data: [], error: null };
      if (fn === CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC) return { data: opts.tokens?.[String(args.p_actor_id)] ?? [], error: null };
      return { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          ops.push({ table: `storage:${bucket}`, op: "remove", filters: [] });
          removed.push({ bucket, paths });
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
    auth: { admin: { deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; } } },
  };
}

const sealOrThrow = (key: string, obs: string): string => {
  const s = sealEvidenceReference(key, obs);
  if (!s.ok) throw new Error(`setup: could not seal (${s.reason})`);
  return s.reference;
};

// ═══════════════════════════════════════════════════════════════════════════
// C. The contributor's reader
// ═══════════════════════════════════════════════════════════════════════════

describe("C. an evidence reader resolves for its contributor and refuses everyone else", () => {
  const ACCOUNT = randomUUID();
  const TOKEN_NOW = randomUUID();
  const TOKEN_LAST_WEEK = randomUUID();
  const STRANGER = randomUUID();
  const OTHER_OWNER = randomUUID();
  const POST_KEY = `post-media/${ACCOUNT}/1756600000000.jpg`;
  const AVATAR_KEY = `profile-media/avatars/${ACCOUNT}/a.jpg`;
  const FOREIGN_KEY = `post-media/${OTHER_OWNER}/1756600000000.jpg`;

  /** Evidence as the database holds it after 3002: actor_id is a token, never the account. */
  function world() {
    return bridgeClient({
      tokens: { [ACCOUNT]: [TOKEN_NOW, TOKEN_LAST_WEEK], [STRANGER]: [randomUUID()] },
      rows: {
        intel_evidence: [
          { id: "ev-post", observation_id: OBS_1, actor_id: TOKEN_NOW, reference: sealOrThrow(POST_KEY, OBS_1) },
          { id: "ev-avatar", observation_id: OBS_2, actor_id: TOKEN_LAST_WEEK, reference: sealOrThrow(AVATAR_KEY, OBS_2) },
          // A row is not a promise: this one is the contributor's, but its key names
          // somebody else's object.
          { id: "ev-foreign", observation_id: OBS_1, actor_id: TOKEN_NOW, reference: sealOrThrow(FOREIGN_KEY, OBS_1) },
          // A reference moved onto a row of a different observation.
          { id: "ev-moved", observation_id: OBS_2, actor_id: TOKEN_NOW, reference: sealOrThrow(POST_KEY, OBS_1) },
          { id: "ev-note", observation_id: OBS_1, actor_id: TOKEN_NOW, reference: null },
        ],
        // A PUBLIC profile: the byte gate serves this avatar to anyone.
        profiles: [{ id: ACCOUNT, is_private: false, passport_visibility: "public", account_status: "active", show_profile_picture_publicly: true }],
      },
    });
  }

  it("resolves the contributor's own object, under this week's token and last week's", async () => {
    const sc = world();
    assert.deepEqual(await resolveEvidenceMediaForContributor(sc, ACCOUNT, "ev-post"),
      { ok: true, bucket: "post-media", path: `${ACCOUNT}/1756600000000.jpg` });
    assert.deepEqual(await resolveEvidenceMediaForContributor(sc, ACCOUNT, "ev-avatar"),
      { ok: true, bucket: "profile-media", path: `avatars/${ACCOUNT}/a.jpg` });
  });

  it("refuses a stranger even where the byte gate alone WOULD serve them the bytes", async () => {
    const sc = world();
    // CONTROL: the bytes themselves are visible to the stranger (a public avatar).
    assert.equal(await authorizeMediaAccess(sc as any, STRANGER, "profile-media", `avatars/${ACCOUNT}/a.jpg`), true,
      "setup: the byte gate must allow this stranger, or the refusal below proves nothing");
    // Telling them WHICH observation it backs would re-identify the contributor.
    const theirs = await resolveEvidenceMediaForContributor(sc, STRANGER, "ev-avatar");
    const missing = await resolveEvidenceMediaForContributor(sc, STRANGER, "ev-does-not-exist");
    assert.deepEqual(theirs, { ok: false, reason: "not_found" });
    assert.deepEqual(missing, theirs, "a real-but-foreign row and a missing one must be indistinguishable");
    assert.deepEqual(await resolveEvidenceMediaForContributor(sc, STRANGER, "ev-post"), { ok: false, reason: "not_found" });
  });

  it("refuses the contributor an object the byte gate refuses them", async () => {
    const sc = world();
    // CONTROL: the reference opens; the refusal is the byte gate's, not the codec's.
    assert.equal(openEvidenceReference(sealOrThrow(FOREIGN_KEY, OBS_1), OBS_1).ok, true);
    assert.deepEqual(await resolveEvidenceMediaForContributor(sc, ACCOUNT, "ev-foreign"), { ok: false, reason: "not_authorized" });
  });

  it("refuses a reference moved to another observation, and a row that stores no object", async () => {
    const sc = world();
    assert.deepEqual(await resolveEvidenceMediaForContributor(sc, ACCOUNT, "ev-moved"), { ok: false, reason: "unopenable" });
    assert.deepEqual(await resolveEvidenceMediaForContributor(sc, ACCOUNT, "ev-note"), { ok: false, reason: "no_media" });
  });

  it("says why when it cannot decide: no key, or identities unreadable — never 'not yours'", async () => {
    const sealedWorld = world();
    delete process.env.INTEL_EVIDENCE_REFERENCE_KEY;
    assert.deepEqual(await resolveEvidenceMediaForContributor(sealedWorld, ACCOUNT, "ev-post"), { ok: false, reason: "reference_key_unavailable" });
    process.env.INTEL_EVIDENCE_REFERENCE_KEY = KEY;
    resetContributorIdentityShapeMemo();
    const broken = bridgeClient({ bridgeFails: true, rows: { intel_evidence: [] } });
    const r = await resolveEvidenceMediaForContributor(broken, ACCOUNT, "ev-post");
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "db_error");
    assert.equal(broken._ops.some((o) => o.table === "intel_evidence"), false, "identities are resolved before any evidence id is looked up");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Account deletion still finds the bytes
// ═══════════════════════════════════════════════════════════════════════════

describe("D. account deletion removes evidence objects through the sealed reference", () => {
  const USER = randomUUID();
  const OTHER = randomUUID();
  const TOKEN_NOW = randomUUID();
  const TOKEN_LAST_WEEK = randomUUID();
  const OTHER_TOKEN = randomUUID();

  const removedPaths = (c: any) => c._removed.flatMap((r: any) => r.paths);
  const stepOf = (out: any, name: string) => out.steps.find((s: any) => s.step === name);

  it("collects every object under every identity the account's rows carry, and nobody else's", async () => {
    const c = bridgeClient({
      tokens: { [USER]: [TOKEN_NOW, TOKEN_LAST_WEEK] },
      rows: {
        intel_evidence: [
          // post-3002, this week and last week
          { id: "e1", observation_id: OBS_1, actor_id: TOKEN_NOW, reference: sealOrThrow(`${POST_MEDIA_BUCKET}/${USER}/1.jpg`, OBS_1) },
          { id: "e2", observation_id: OBS_2, actor_id: TOKEN_LAST_WEEK, reference: sealOrThrow(`${POST_MEDIA_BUCKET}/${USER}/2.mp4`, OBS_2) },
          // pre-seal (pre-3360) plaintext row, pre-3002 account id
          { id: "e3", observation_id: OBS_1, actor_id: USER, reference: `${POST_MEDIA_BUCKET}/${USER}/3.jpg` },
          // no object
          { id: "e4", observation_id: OBS_1, actor_id: TOKEN_NOW, reference: null },
          // somebody else's evidence, under somebody else's token
          { id: "e5", observation_id: OBS_2, actor_id: OTHER_TOKEN, reference: sealOrThrow(`${POST_MEDIA_BUCKET}/${OTHER}/9.jpg`, OBS_2) },
        ],
      },
    });

    const out = await executeAccountDeletion(c as any, USER, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    // Nothing else in this fake holds an object, so the removes are exactly these.
    assert.deepEqual(c._removed.map((r: any) => r.bucket).filter((b: string) => b !== POST_MEDIA_BUCKET), []);
    assert.deepEqual(removedPaths(c).sort(), [`${USER}/1.jpg`, `${USER}/2.mp4`, `${USER}/3.jpg`]);
    assert.equal(removedPaths(c).some((p: string) => p.startsWith(OTHER)), false, "another account's object reached remove()");
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.ok, true);
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.count, 3);

    // Still collected BEFORE erase_intel_for_actor deletes the rows.
    const lastRead = c._ops.map((o) => o.table === "intel_evidence" && o.op === "select").lastIndexOf(true);
    const erased = c._ops.findIndex((o) => o.table === "rpc:erase_intel_for_actor");
    assert.ok(lastRead >= 0 && erased > lastRead, `read@${lastRead} erase@${erased}`);
  });

  it("a sealed reference that does not open fails the step and warns, after collecting the rest", async () => {
    const c = bridgeClient({
      tokens: { [USER]: [TOKEN_NOW] },
      rows: {
        intel_evidence: [
          { id: "e1", observation_id: OBS_1, actor_id: TOKEN_NOW, reference: sealOrThrow(`${POST_MEDIA_BUCKET}/${USER}/1.jpg`, OBS_1) },
          // sealed for another observation: it cannot be opened for this row
          { id: "e2", observation_id: OBS_2, actor_id: TOKEN_NOW, reference: sealOrThrow(`${POST_MEDIA_BUCKET}/${USER}/2.jpg`, OBS_1) },
        ],
      },
    });
    const out = await executeAccountDeletion(c as any, USER, { actorId: "admin-1" });
    const s = stepOf(out, "collect_intel_evidence_paths");
    assert.equal(s?.ok, false, "an object the deletion cannot find is not a successful collection");
    assert.match(String(s?.error), /could not be opened/);
    assert.ok(out.warnings.some((w: string) => w.includes("intel evidence")), JSON.stringify(out.warnings));
    assert.ok(removedPaths(c).includes(`${USER}/1.jpg`), "what did open is still removed");
    assert.deepEqual(c._authDeleted, [USER], "the deletion still completes");
  });

  it("with no key configured, sealed rows fail the step loudly rather than reading as 'no evidence'", async () => {
    const c = bridgeClient({
      tokens: { [USER]: [TOKEN_NOW] },
      rows: { intel_evidence: [{ id: "e1", observation_id: OBS_1, actor_id: TOKEN_NOW, reference: sealOrThrow(`${POST_MEDIA_BUCKET}/${USER}/1.jpg`, OBS_1) }] },
    });
    delete process.env.INTEL_EVIDENCE_REFERENCE_KEY;
    const out = await executeAccountDeletion(c as any, USER, { actorId: "admin-1" });
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.ok, false);
    assert.ok(out.warnings.some((w: string) => w.includes("intel evidence")));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. The remediation, and the one-module rule
// ═══════════════════════════════════════════════════════════════════════════

describe("E. legacy rows, and who may read `reference`", () => {
  it("the dry run counts plaintext rows and writes nothing; --apply re-seals each through the one-row function", async () => {
    const USER = randomUUID();
    const legacy = [
      { id: "l1", observation_id: OBS_1, evidence_kind: "photo", reference: `post-media/${USER}/1.jpg` },
      { id: "l2", observation_id: OBS_2, evidence_kind: "video", reference: `post-media/${USER}/2.mp4` },
      { id: "l3", observation_id: OBS_2, evidence_kind: "photo", reference: "not-a-key-of-ours" },
    ];
    const calls: any[] = [];
    const sc: any = {
      from: () => {
        const b: any = new Proxy({}, {
          get: (_t, p) => (p === "then"
            ? (res: any) => Promise.resolve({ data: legacy, error: null }).then(res)
            : () => b),
        });
        return b;
      },
      rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: true, error: null }; },
    };

    const dry = await rekeyLegacyEvidenceReferences(sc, { apply: false });
    assert.deepEqual(dry, { apply: false, legacy: 3, rekeyed: 0, refused: 0, failed: 0 });
    assert.equal(calls.length, 0, "a dry run writes nothing");
    assert.equal(JSON.stringify(dry).includes(USER), false, "the outcome names no account");

    const applied = await rekeyLegacyEvidenceReferences(sc, { apply: true });
    assert.deepEqual(applied, { apply: true, legacy: 3, rekeyed: 2, refused: 1, failed: 0 });
    assert.deepEqual(calls.map((c) => c.fn), ["intel_evidence_rekey_reference", "intel_evidence_rekey_reference"]);
    for (const [i, call] of calls.entries()) {
      assert.equal(call.args.p_legacy_reference, legacy[i]!.reference, "the function is told the exact value it must replace");
      assertNamesNoAccount(call.args.p_sealed_reference, USER, "the re-sealed value");
      assert.equal(openEvidenceReference(call.args.p_sealed_reference, legacy[i]!.observation_id).ok, true);
    }

    delete process.env.INTEL_EVIDENCE_REFERENCE_KEY;
    await assert.rejects(rekeyLegacyEvidenceReferences(sc, { apply: true }), /INTEL_EVIDENCE_REFERENCE_KEY/);
    assert.equal(calls.length, 2, "no key: nothing written");
  });

  it("nothing outside lib/intelEvidenceCapture selects `reference` from intel_evidence", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "test" && e.name !== "migrations" && e.name !== "node_modules") walk(p);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !e.name.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(SRC_ROOT);
    assert.ok(files.length > 200, "the scan found almost nothing");
    const producer = join(SRC_ROOT, "lib", "intelEvidenceCapture.ts");
    const readsReference = (src: string) =>
      /from\(["']intel_evidence["']\)/.test(src) && /\.select\([^)]*\breference\b/.test(src);
    assert.equal(readsReference(readFileSync(producer, "utf8")), true, "CONTROL: the pattern matches the one file that may");
    const offenders = files
      .filter((f) => f !== producer && readsReference(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC_ROOT.length + 1));
    assert.deepEqual(offenders, [],
      "a reader of intel_evidence.reference outside the module that seals it: open it through " +
        "resolveEvidenceMediaForContributor or collectOwnEvidenceObjectKeys, never by parsing the stored value");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Gate 2b — a photo is kept only under words that name photos
// ═══════════════════════════════════════════════════════════════════════════
//
// Requested by the coordinator after the integrator's read-only production read
// (2026-09-27): map_contributions_enabled and media_evidence_enabled have no
// row, intel_evidence has 0 rows, intel_capture_quick_signal is true. Nothing has
// been kept; the gap would open the day the map flag is turned on.

describe("F. a photo is refused under a consent whose words do not name photos", () => {
  const V1 = "intel_contributions_v1";
  const V2 = "sensing_contributions_v2";

  it("ships an EMPTY list: no version in force, and not the unapproved v2, names photos", () => {
    _setPhotoEvidenceConsentVersionsForTests(null);
    assert.deepEqual([...PHOTO_EVIDENCE_CONSENT_VERSIONS], []);
    assert.equal(PHOTO_EVIDENCE_CONSENT_VERSIONS.includes(V1), false);
    assert.equal(PHOTO_EVIDENCE_CONSENT_VERSIONS.includes(V2), false);
  });

  it("under v1: the tap is recorded, the photo is refused with 409 consent_does_not_cover_photos, and nothing else is written", async () => {
    _setPhotoEvidenceConsentVersionsForTests(null); // the SHIPPED list
    const account = randomUUID();
    const db = captureDb([account], V1);

    // A contribution WITHOUT a photo: unaffected.
    const tap = await ingestMapContribution(db, account, {
      objectId: PLACE, objectKind: "place", kind: "crowd_level", value: "busy", observedAt: OBSERVED,
    });
    assert.equal(tap.ok, true, `the tap-only path must be unchanged: ${JSON.stringify(tap)}`);
    assert.equal(db._tables.intel_observations.length, 1);
    const before = JSON.stringify(db._tables);

    // The photo for it: refused, and the refusal leaves every table exactly as it was.
    const photo = await ingestMapContribution(db, account, {
      objectId: PLACE, objectKind: "place", kind: "media", value: "photo",
      mediaUri: `post-media/${account}/1756600000000.jpg`, observedAt: OBSERVED,
      observationId: (tap as any).observation.id,
    });
    assert.equal(photo.ok, false, "a photo was kept under words that never mention one");
    assert.equal((photo as any).reason, "consent_does_not_cover_photos");
    assert.equal((photo as any).code, "consent_does_not_cover_photos");
    assert.equal(db._tables.intel_evidence.length, 0);
    assert.equal(db._tables.intel_observations.length, 1, "no observation is created or removed by the refusal");
    assert.equal(JSON.stringify(db._tables), before, "the refusal wrote nothing, anywhere");

    // A video is the same artifact class and is refused the same way.
    const video = await attachMediaEvidence(db, account, {
      observationId: (tap as any).observation.id, subjectId: PLACE,
      mediaUri: `post-media/${account}/1756600000001.mp4`, mediaKind: "video", observedAt: OBSERVED,
    });
    assert.equal(!video.ok && video.reason, "consent_does_not_cover_photos");
  });

  it("the route answers it as HTTP 409 with a stable code", async () => {
    const { sendError } = await import("../lib/http.js");
    let status = 0;
    let body: any = null;
    const res: any = { status(n: number) { status = n; return res; }, json(b: any) { body = b; return res; } };
    sendError(res, "consent_does_not_cover_photos", "not kept");
    assert.equal(status, 409);
    assert.equal(body.error, "consent_does_not_cover_photos");
    assert.equal(body.retryable, undefined, "retrying the same photo cannot succeed");
  });

  it("reads the RECORDED version: with a covering version listed, v1 is still refused and only that version keeps a photo", async () => {
    _setPhotoEvidenceConsentVersionsForTests([PHOTO_TEST_VERSION]);
    for (const [version, keeps] of [[V1, false], [V2, false], [PHOTO_TEST_VERSION, true]] as const) {
      const account = randomUUID();
      const db = captureDb([account], version);
      const tap = await ingestMapContribution(db, account, {
        objectId: PLACE, objectKind: "place", kind: "crowd_level", value: "busy", observedAt: OBSERVED,
      });
      assert.equal(tap.ok, true, version);
      const photo = await attachMediaEvidence(db, account, {
        observationId: (tap as any).observation.id, subjectId: PLACE,
        mediaUri: `post-media/${account}/1756600000000.jpg`, mediaKind: "photo", observedAt: OBSERVED,
      });
      assert.equal(photo.ok, keeps, `${version}: ${JSON.stringify(photo)}`);
      assert.equal(db._tables.intel_evidence.length, keeps ? 1 : 0, version);
    }
  });

  it("no consent version recorded, or a withdrawn grant, keeps nothing either", async () => {
    _setPhotoEvidenceConsentVersionsForTests([PHOTO_TEST_VERSION]);
    const account = randomUUID();
    const db = captureDb([account], PHOTO_TEST_VERSION);
    const tap = await ingestMapContribution(db, account, {
      objectId: PLACE, objectKind: "place", kind: "crowd_level", value: "busy", observedAt: OBSERVED,
    });
    delete db._tables.intel_contribution_consent[0].consent_version;
    const unversioned = await attachMediaEvidence(db, account, {
      observationId: (tap as any).observation.id, subjectId: PLACE,
      mediaUri: `post-media/${account}/1756600000000.jpg`, mediaKind: "photo", observedAt: OBSERVED,
    });
    assert.equal(!unversioned.ok && unversioned.reason, "consent_does_not_cover_photos");
    db._tables.intel_contribution_consent[0].withdrawn_at = new Date().toISOString();
    db._tables.intel_contribution_consent[0].consent_version = PHOTO_TEST_VERSION;
    const withdrawn = await attachMediaEvidence(db, account, {
      observationId: (tap as any).observation.id, subjectId: PLACE,
      mediaUri: `post-media/${account}/1756600000000.jpg`, mediaKind: "photo", observedAt: OBSERVED,
    });
    assert.equal(!withdrawn.ok && withdrawn.reason, "consent_required", "Gate 2 still answers a withdrawal first");
    assert.equal(db._tables.intel_evidence.length, 0);
  });

  it("no product code widens the list through the test seam", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "test" && e.name !== "node_modules") walk(p);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(SRC_ROOT);
    const definer = join(SRC_ROOT, "lib", "intelEvidenceCapture.ts");
    const callers = files
      .filter((f) => f !== definer && readFileSync(f, "utf8").includes("_setPhotoEvidenceConsentVersionsForTests"))
      .map((f) => f.slice(SRC_ROOT.length + 1));
    assert.deepEqual(callers, [], "a product file calls the test seam that widens which consent keeps photos");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. The client is told BEFORE it uploads (census-map §45.12)
// ═══════════════════════════════════════════════════════════════════════════
//
// GET /v1/intel/consent carries `coversPhotoEvidence`, computed by Gate 2b's own
// predicate. The client offers the photo step only on `true`.

describe("G. GET /v1/intel/consent says whether a photo would be kept, with the gate's own answer", () => {
  const USER = "11111111-1111-4111-8111-11111111aaaa";
  type ConsentRow = { enabled: boolean; consent_version: string | null; consented_at: string | null; withdrawn_at: string | null };

  function routeClient(consent: ConsentRow | null | "error") {
    return {
      auth: {
        async getUser(token: string) {
          return token === "valid-token"
            ? { data: { user: { id: USER } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } };
        },
      },
      from(table: string) {
        const q: any = { select: () => q, eq: () => q, in: () => q, is: () => q, limit: async () => ({ data: [], error: null }) };
        q.maybeSingle = async () => {
          if (table === "profiles") return { data: { account_status: "active" }, error: null };
          if (table === "intel_contribution_consent") {
            if (consent === "error") return { data: null, error: { code: "42501", message: "permission denied" } };
            return { data: consent, error: null };
          }
          return { data: null, error: null };
        };
        return q;
      },
    };
  }

  async function readConsent(consent: ConsentRow | null | "error"): Promise<{ status: number; body: any }> {
    const { _setTestClient } = await import("../lib/http.js");
    const { default: intelRouter } = await import("../routes/intel.js");
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    _setTestClient(routeClient(consent), true);
    const app = express();
    app.use(express.json());
    app.use("/api", intelRouter);
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port as number;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/intel/consent`, { headers: { Authorization: "Bearer valid-token" } });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      _setTestClient(null, false);
    }
  }

  const row = (consent_version: string | null, over: Partial<ConsentRow> = {}): ConsentRow => ({
    enabled: true, consent_version, consented_at: "2026-09-01T00:00:00.000Z", withdrawn_at: null, ...over,
  });

  it("with the SHIPPED list, a v1 holder is told false, and so is every other state", async () => {
    restoreShippedPhotoList();
    for (const consent of [row("intel_contributions_v1"), row("sensing_contributions_v2"), row(null), null]) {
      const { status, body } = await readConsent(consent);
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.coversPhotoEvidence, false, `${JSON.stringify(consent)} → ${JSON.stringify(body)}`);
    }
  });

  it("reads the RECORDED version: only a listed version is told true, and a withdrawal turns it off", async () => {
    _setPhotoEvidenceConsentVersionsForTests([PHOTO_TEST_VERSION]);
    assert.equal((await readConsent(row(PHOTO_TEST_VERSION))).body.coversPhotoEvidence, true);
    assert.equal((await readConsent(row("intel_contributions_v1"))).body.coversPhotoEvidence, false);
    assert.equal(
      (await readConsent(row(PHOTO_TEST_VERSION, { withdrawn_at: "2026-09-02T00:00:00.000Z" }))).body.coversPhotoEvidence,
      false,
    );
    assert.equal((await readConsent(row(PHOTO_TEST_VERSION, { enabled: false }))).body.coversPhotoEvidence, false);
  });

  it("an unreadable consent row answers 500 and no coverage bit at all (the client reads that as false)", async () => {
    _setPhotoEvidenceConsentVersionsForTests([PHOTO_TEST_VERSION]);
    const { status, body } = await readConsent("error");
    assert.equal(status, 500);
    assert.equal(body.coversPhotoEvidence, undefined);
  });

  it("the route's answer and the gate's answer are the same for every state (one predicate)", async () => {
    _setPhotoEvidenceConsentVersionsForTests([PHOTO_TEST_VERSION]);
    for (const version of ["intel_contributions_v1", PHOTO_TEST_VERSION]) {
      const told = (await readConsent(row(version))).body.coversPhotoEvidence;
      const account = randomUUID();
      const db = captureDb([account], version);
      const tap = await ingestMapContribution(db, account, {
        objectId: PLACE, objectKind: "place", kind: "crowd_level", value: "busy", observedAt: OBSERVED,
      });
      const kept = await attachMediaEvidence(db, account, {
        observationId: (tap as any).observation.id, subjectId: PLACE,
        mediaUri: `post-media/${account}/1756600000000.jpg`, mediaKind: "photo", observedAt: OBSERVED,
      });
      assert.equal(told, kept.ok, `${version}: the client was told ${told} but the gate answered ${kept.ok}`);
    }
  });
});

/** Section G's first case runs with the SHIPPED (empty) list. */
function restoreShippedPhotoList(): void {
  _setPhotoEvidenceConsentVersionsForTests(null);
}
